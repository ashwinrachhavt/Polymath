import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { artifacts, artifactVersions } from "./schema";
import { withReceipt } from "@/domains/audit/receipt";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { untrustedDataClauseJsonSafe } from "@/lib/prompts";
import {
  GenerationUnconfiguredError,
  generationProvider,
  type GenerationProvider,
} from "@/integrations/generation/provider";

/*
 * Design brief (ASH-286): one pass over a research artifact produces a
 * structured design brief, saved as a memo artifact the owner can review and
 * edit. The handoff half is a design import through the approval-bound
 * executor (ADR 0009): "Send to Canva" files a canva.design.import proposal
 * pinning this brief and the SHA-256 of its deterministic DOCX render; only
 * an owner's approval of that exact revision runs the import, and the async
 * job settles through the reconciliation sweep. The brief JSON rides inside
 * the artifact version's content so the proposal carries the structured
 * brief, not a markdown re-parse.
 *
 * The brief contract below is the shared vocabulary the handoff carries:
 * `format` spells Canva's preset design types verbatim ("doc", "whiteboard",
 * "presentation", per the Connect API create-design reference), so the
 * executor maps it without a translation layer.
 */

export class DesignBriefNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignBriefNotAllowedError";
  }
}

export class DesignBriefUnusableAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignBriefUnusableAnswerError";
  }
}

/** Canva preset design-type names, the only formats the handoff can create. */
export const DESIGN_FORMATS = ["doc", "whiteboard", "presentation"] as const;
export type DesignFormat = (typeof DESIGN_FORMATS)[number];

/** Model cap: a source longer than this is truncated, never rejected. */
export const BRIEF_MAX_INPUT_CHARS = 40_000;
export const BRIEF_MAX_LIST_ITEMS = 6;

/*
 * Exported for the canva.design.import executor payload: the approved
 * revision embeds this exact shape, and the executor validates against the
 * same contract before rendering.
 */
export const designBriefSchema = z.object({
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(1000),
  audience: z.string().trim().min(1).max(500),
  keyMessage: z.string().trim().min(1).max(500),
  tone: z.array(z.string().trim().min(1).max(60)).min(1).max(BRIEF_MAX_LIST_ITEMS),
  format: z.enum(DESIGN_FORMATS),
  visualDirection: z.string().trim().min(1).max(1000),
  deliverables: z.array(z.string().trim().min(1).max(200)).max(BRIEF_MAX_LIST_ITEMS).nullable(),
  constraints: z.array(z.string().trim().min(1).max(200)).max(BRIEF_MAX_LIST_ITEMS).nullable(),
  callToAction: z.string().trim().max(300).nullable(),
});

export type DesignBrief = z.infer<typeof designBriefSchema>;

/*
 * The artifact kinds a brief can start from. "Research card" in the product
 * is a Library card with text: company/profile research reports, memos,
 * documents, notes, and zettel cards. Transcripts belong to the debrief;
 * decks, infographics and diagrams are already designed output.
 */
export const BRIEFABLE_KINDS = ["report", "memo", "document", "note", "zettel"] as const;

const SYSTEM = `You turn a research card into a design brief a designer (or a design tool) can act on. Return JSON with exactly these keys: {"title": string, "objective": string, "audience": string, "keyMessage": string, "tone": string[], "format": "doc"|"whiteboard"|"presentation", "visualDirection": string, "deliverables": string[]|null, "constraints": string[]|null, "callToAction": string|null}.
"title": the working title of the piece to design, not the research's title.
"objective": what the designed piece must achieve, one or two sentences.
"audience": who it is for, as specifically as the research supports.
"keyMessage": the single thing the audience should take away.
"tone": 1-6 adjectives or short phrases.
"format": the Canva preset the piece should be made as - "doc" for a document/brief, "whiteboard" for an explorable board, "presentation" for slides.
"visualDirection": concrete direction for layout, imagery and style grounded in the research; no invented brand facts.
"deliverables": the concrete pieces to produce, or null.
"constraints": real constraints the research states or implies, or null.
"callToAction": the action the piece should drive, or null.
Ground every field in the research. ${untrustedDataClauseJsonSafe("research card")} Brief only what the card supports; leave a field null rather than inventing it.`;

/** Parse the model's JSON strictly; a malformed or over-cap answer is unusable, never partially applied. */
export function parseDesignBriefAnswer(text: string): DesignBrief {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DesignBriefUnusableAnswerError("The model's answer was not JSON.");
  }
  const parsed = designBriefSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DesignBriefUnusableAnswerError("The model's answer did not match the design-brief shape.");
  }
  return parsed.data;
}

function list(items: string[] | null): string[] {
  return items && items.length > 0 ? items.map((item) => `- ${item}`) : ["- None given."];
}

/*
 * The brief as it reads in the Library: every field visible, nulls shown as
 * absent, never smoothed over. No title heading: the artifact page already
 * shows "Design brief: <title>" as its h1, so the body opens with the source
 * line instead of repeating it.
 */
export function renderBriefMarkdown(brief: DesignBrief, sourceTitle: string): string {
  return [
    `*Design brief from "${sourceTitle}". "Send to Canva" above files a proposal; nothing imports until you approve it in Reviews.*`,
    "",
    `**Format:** ${brief.format}`,
    "",
    `**Objective.** ${brief.objective}`,
    "",
    `**Audience.** ${brief.audience}`,
    "",
    `**Key message.** ${brief.keyMessage}`,
    "",
    `**Tone.** ${brief.tone.join(", ")}`,
    "",
    `**Visual direction.** ${brief.visualDirection}`,
    "",
    "**Deliverables**",
    "",
    ...list(brief.deliverables),
    "",
    "**Constraints**",
    "",
    ...list(brief.constraints),
    "",
    `**Call to action.** ${brief.callToAction ?? "None given."}`,
  ].join("\n");
}

export type DesignBriefResult = {
  sourceArtifactId: string;
  briefArtifactId: string;
  title: string;
  /** True when an earlier click already drafted this card's brief; nothing new was written. */
  existing: boolean;
};

export async function designBriefFromArtifact(
  auth: AuthContext,
  artifactId: string,
  deps?: { provider?: GenerationProvider },
): Promise<DesignBriefResult> {
  const [row] = await db
    .select({ title: artifacts.title, kind: artifacts.kind, plainText: artifactVersions.plainText, versionId: artifacts.currentVersionId })
    .from(artifacts)
    .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!row) throw new DesignBriefNotAllowedError("That artifact does not exist in this workspace.");
  if (!(BRIEFABLE_KINDS as readonly string[]).includes(row.kind)) {
    throw new DesignBriefNotAllowedError(`A ${row.kind} artifact cannot become a design brief; start from a research report, memo, document, note, or card.`);
  }
  const source = (row.plainText ?? "").trim();
  if (!source || !row.versionId) throw new DesignBriefNotAllowedError("This artifact has no text to brief from.");

  let provider: GenerationProvider;
  try {
    provider = deps?.provider ?? generationProvider(process.env);
  } catch (error) {
    // No key configured is a clear refusal, not a failure: the owner sees why
    // the brief cannot run, and nothing is written.
    if (error instanceof GenerationUnconfiguredError) throw new DesignBriefNotAllowedError(error.message);
    throw error;
  }

  /*
   * One brief per (source card, source revision): the receipt key carries the
   * source's current version, so a repeat click replays the stored result -
   * atomically, the advisory lock serializes concurrent first attempts and
   * the loser replays - while an edit to the source is a new key and drafts
   * a fresh brief instead of reusing a stale one.
   */
  return withTransaction(async (tx) => {
    const { value, replayed } = await withReceipt(
      tx,
      auth,
      `design-brief:${artifactId}:${row.versionId}`,
      { op: "designBrief", sourceArtifactId: artifactId, sourceVersionId: row.versionId },
      async () => {
        const out = await provider.generate({
          system: SYSTEM,
          prompt: `Research card titled "${row.title}":\n\n${source.slice(0, BRIEF_MAX_INPUT_CHARS)}`,
          json: true,
        });
        const brief = parseDesignBriefAnswer(out.text);
        const markdown = renderBriefMarkdown(brief, row.title);
        const title = `Design brief: ${brief.title}`.slice(0, 200);
        const [artifact] = await tx
          .insert(artifacts)
          .values({ workspaceId: auth.workspaceId, kind: "memo", status: "generated", title, createdBy: auth.userId, updatedBy: auth.userId })
          .returning({ id: artifacts.id });
        const [version] = await tx
          .insert(artifactVersions)
          .values({
            workspaceId: auth.workspaceId,
            artifactId: artifact.id,
            versionNumber: 1,
            content: { text: markdown, brief },
            plainText: markdown,
            reason: "generated",
            createdBy: auth.userId,
          })
          .returning({ id: artifactVersions.id });
        await tx.update(artifacts).set({ currentVersionId: version.id, embedError: null }).where(eq(artifacts.id, artifact.id));
        await recordAudit(
          auth,
          {
            action: "knowledge.design_brief.generated",
            subjectType: "artifact",
            subjectId: artifact.id,
            summary: `Drafted design brief "${brief.title}" from "${row.title}".`,
            metadata: { sourceArtifactId: artifactId, sourceVersionId: row.versionId, format: brief.format, proposer: provider.name },
          },
          tx,
        );
        return { sourceArtifactId: artifactId, briefArtifactId: artifact.id, title };
      },
    );
    return { ...value, existing: replayed };
  });
}
