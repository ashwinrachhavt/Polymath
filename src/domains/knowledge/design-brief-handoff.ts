import { and, eq } from "drizzle-orm";
import { createProposal, senderAccountPin, withSenderAccountPin } from "@/domains/actions/commands";
import { actionRevisions } from "@/domains/actions/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { designBriefSchema, type DesignBrief } from "./design-brief";
import { designBriefDocxSha256 } from "./design-brief-docx";
import { artifacts, artifactVersions } from "./schema";

/*
 * The brief-to-Canva handoff (ASH-286, ADR 0009). One click on a generated
 * design brief files a canva.design.import proposal; nothing imports until
 * the owner approves the exact revision in Reviews, and the approved-effect
 * executor runs it. The payload embeds the structured brief and the SHA-256
 * of its deterministic DOCX render, so what the owner inspects is byte-for-
 * byte what Canva would receive; editing the brief afterwards cannot change
 * an already-approved payload, and a renderer change refuses at execution.
 *
 * The proposal pins the exact Canva account (the shared sender-pin contract)
 * and dedupes per brief revision: a second click resolves the same proposal,
 * and an edited brief is a new proposal, never a silent re-import.
 */

export const CANVA_IMPORT_CAPABILITY = "canva.design.import";

export class DesignBriefHandoffNotAllowedError extends Error {
  readonly code = "design_brief_handoff_not_allowed";
  constructor(message: string) {
    super(message);
    this.name = "DesignBriefHandoffNotAllowedError";
  }
}

/** The structured brief stored in the generated artifact's version content. */
export function briefFromContent(content: unknown): DesignBrief | null {
  if (content === null || typeof content !== "object") return null;
  const parsed = designBriefSchema.safeParse((content as { brief?: unknown }).brief);
  return parsed.success ? parsed.data : null;
}

export async function proposeCanvaImport(
  auth: AuthContext,
  briefArtifactId: string,
): Promise<{ proposalId: string; deduplicated: boolean }> {
  const [row] = await db
    .select({
      title: artifacts.title,
      versionId: artifactVersions.id,
      content: artifactVersions.content,
    })
    .from(artifacts)
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(and(eq(artifacts.id, briefArtifactId), eq(artifacts.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!row) throw new DesignBriefHandoffNotAllowedError("That artifact does not exist in this workspace.");
  const brief = briefFromContent(row.content);
  if (!brief) {
    throw new DesignBriefHandoffNotAllowedError(
      "This artifact is not a design brief this build can hand off; draft a fresh brief from the research card first.",
    );
  }

  return withTransaction(async (tx) => {
    const result = await createProposal(tx, auth, {
      capability: CANVA_IMPORT_CAPABILITY,
      riskClass: "external_write",
      targetType: "artifact",
      targetId: briefArtifactId,
      title: `Import design brief "${brief.title}" to Canva`.slice(0, 300),
      expectedEffect:
        `Creates one new Canva design from the design brief "${brief.title}", imported as a generated Word ` +
        `document through the connected Canva account shown below. No existing Canva design is modified. ` +
        `The import is asynchronous: approving starts Canva's import job, and the proposal settles when Canva ` +
        `reports the outcome. Canva's rendering of the generated document is not verified yet - this is the ` +
        `first import path, so inspect the result in Canva.`,
      dedupeKey: `${CANVA_IMPORT_CAPABILITY}:${briefArtifactId}:${row.versionId}`,
    });
    if (!result.deduplicated) {
      const payload = { title: row.title.slice(0, 255), brief, docxSha256: designBriefDocxSha256(brief) };
      const preview = {
        title: brief.title,
        format: brief.format,
        objective: brief.objective,
        docxSha256: payload.docxSha256,
      };
      const pinned = withSenderAccountPin(
        await senderAccountPin(auth, CANVA_IMPORT_CAPABILITY, null),
        payload,
        preview,
      );
      await tx.insert(actionRevisions).values({
        workspaceId: auth.workspaceId,
        proposalId: result.proposalId,
        revisionNumber: 1,
        payload: pinned.payload,
        preview: pinned.preview,
        createdBy: auth.userId,
      });
    }
    return result;
  });
}
