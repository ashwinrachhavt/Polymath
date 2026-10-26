import { GenerationUnconfiguredError, generationProvider, type GenerationProvider } from "@/integrations/generation/provider";
import type { AuthContext } from "@/domains/identity/resolve";

/*
 * ASH-285, part 2: the "fully formed" half of drafting a Linear issue. The
 * deterministic scaffold stays the floor; when a generation provider is
 * configured this proposes the actual content - title, problem, proposal,
 * acceptance criteria, out of scope - grounded in the quoted source material,
 * with the provider recorded as the proposer exactly like the other
 * generation-backed surfaces. A generation failure never degrades the
 * result silently: the caller falls back to the honest scaffold.
 *
 * Creating the issue in Linear itself is deliberately not here: the Linear
 * seam is reads-only and its transport refuses mutations by design.
 */

/** Marker phrase the e2e fixture provider answers by (src/integrations/generation/fixture.ts). */
export const LINEAR_ISSUE_SYSTEM_MARKER = "Linear issue proposal";

export const LINEAR_ISSUE_SYSTEM_PROMPT = [
  `You write a ${LINEAR_ISSUE_SYSTEM_MARKER} from source material.`,
  "Answer with a single JSON object, no prose around it:",
  `{ "title": string, "problem": string, "proposal": string, "acceptanceCriteria": string[], "outOfScope": string }`,
  "Rules: the title is one imperative line; the problem says what is broken or missing and for whom; the proposal is the smallest change that resolves it; every acceptance criterion is an observable behavior a reviewer could check; the out-of-scope names what this issue deliberately does not do. Never invent facts beyond the source material - say what the source supports and mark the rest as open questions inside the relevant field.",
].join("\n");

export type LinearIssueProposal = {
  title: string;
  problem: string;
  proposal: string;
  acceptanceCriteria: string[];
  outOfScope: string;
};

export class LinearIssueProposalError extends Error {
  constructor(
    public readonly code: "unconfigured" | "unparseable" | "empty_source",
    message: string,
  ) {
    super(message);
    this.name = "LinearIssueProposalError";
  }
}

/** The model sees at most this much source; longer material is quoted from the top with an explicit cut. */
const MAX_SOURCE_CHARS = 8000;

export function buildLinearIssuePrompt(input: { title: string; text: string }): string {
  const trimmed = input.text.trim();
  if (!trimmed) throw new LinearIssueProposalError("empty_source", "There is no source material to draft from.");
  const quoted = trimmed.length <= MAX_SOURCE_CHARS ? trimmed : `${trimmed.slice(0, MAX_SOURCE_CHARS)}\n\n[...the source continues; this is the first ${MAX_SOURCE_CHARS} characters]`;
  return [`SOURCE TITLE: ${input.title}`, "", "SOURCE MATERIAL:", quoted, "", "Write the Linear issue proposal for this source."].join("\n");
}

/** Pure parse, so the output contract is unit-tested instead of drifting inside an async body. */
export function parseLinearIssueProposal(text: string): LinearIssueProposal {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LinearIssueProposalError("unparseable", "The model did not return a JSON issue proposal.");
  }
  const obj = raw as Record<string, unknown>;
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  const problem = typeof obj.problem === "string" ? obj.problem.trim() : "";
  const proposal = typeof obj.proposal === "string" ? obj.proposal.trim() : "";
  const outOfScope = typeof obj.outOfScope === "string" ? obj.outOfScope.trim() : "";
  const acceptanceCriteria = Array.isArray(obj.acceptanceCriteria)
    ? obj.acceptanceCriteria.filter((c): c is string => typeof c === "string").map((c) => c.trim()).filter(Boolean)
    : [];
  if (!title || !problem || !proposal || acceptanceCriteria.length === 0) {
    throw new LinearIssueProposalError("unparseable", "The issue proposal is missing required sections.");
  }
  return { title, problem, proposal, acceptanceCriteria, outOfScope };
}

/** Render a proposal into the same issue shape the deterministic scaffold uses, so downstream readers see one format. */
export function renderLinearIssueDraft(proposal: LinearIssueProposal, opts: { sourceMaterial: string; proposer: string }): string {
  const quoted = opts.sourceMaterial.trim().split("\n").map((line) => `> ${line}`).join("\n");
  return [
    `# ${proposal.title}`,
    ``,
    `## Problem`,
    ``,
    proposal.problem,
    ``,
    `## Proposal`,
    ``,
    proposal.proposal,
    ``,
    `## Acceptance criteria`,
    ``,
    ...proposal.acceptanceCriteria.map((c) => `- [ ] ${c}`),
    ``,
    `## Out of scope`,
    ``,
    proposal.outOfScope,
    ``,
    `## Source`,
    ``,
    quoted,
    ``,
    `---`,
    `*Proposed by ${opts.proposer} from the source material quoted above. Review before it becomes an issue; nothing has been sent to Linear.*`,
  ].join("\n");
}

/**
 * Propose a fully formed Linear issue from source material (a capture's text
 * or a note's body). Throws LinearIssueProposalError("unconfigured") when no
 * generation provider is configured - the caller falls back to the scaffold.
 */
export async function proposeLinearIssue(
  auth: AuthContext,
  input: { title: string; text: string },
  deps?: { provider?: GenerationProvider },
): Promise<{ proposal: LinearIssueProposal; proposer: string }> {
  let provider: GenerationProvider;
  try {
    provider = deps?.provider ?? generationProvider(process.env);
  } catch (error) {
    if (error instanceof GenerationUnconfiguredError) {
      throw new LinearIssueProposalError("unconfigured", error.message);
    }
    throw error;
  }
  const prompt = buildLinearIssuePrompt(input);
  const out = await provider.generate({ system: LINEAR_ISSUE_SYSTEM_PROMPT, prompt, json: true });
  return { proposal: parseLinearIssueProposal(out.text), proposer: provider.name };
}

/* --- Notes surface (ASH-285: "from a note or capture") --- */

import { and, eq } from "drizzle-orm";
import { withTransaction } from "@/lib/db-transaction";
import { createNoteInTx, syncNoteLinks } from "@/domains/knowledge/notes";
import { artifactVersions, artifacts } from "@/domains/knowledge/schema";
import { draftBody } from "@/domains/capture/draft-templates";

export class LinearIssueNoteError extends Error {
  constructor(
    public readonly code: "note_not_found",
    message: string,
  ) {
    super(message);
    this.name = "LinearIssueNoteError";
  }
}

/**
 * Draft a Linear-issue proposal from an existing note. The proposal becomes
 * a new note that [[wiki-links]] back to its source, so the link graph keeps
 * provenance like every other notebook artifact. With no generation provider
 * configured the honest deterministic scaffold is the content; nothing is
 * ever sent to Linear from here.
 */
export async function draftLinearIssueFromNote(
  auth: AuthContext,
  input: { artifactId: string },
): Promise<{ artifactId: string; title: string; generated: boolean }> {
  return withTransaction(async (tx) => {
    const [note] = await tx
      .select({ id: artifacts.id, title: artifacts.title, content: artifactVersions.content })
      .from(artifacts)
      .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
      .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.kind, "note")))
      .limit(1);
    if (!note) throw new LinearIssueNoteError("note_not_found", "No such note.");
    const markdown = note.content && typeof (note.content as { text?: unknown }).text === "string" ? ((note.content as { text: string }).text as string) : "";

    let title: string;
    let body: string;
    let generated = false;
    try {
      const { proposal, proposer } = await proposeLinearIssue(auth, { title: note.title, text: markdown });
      title = `Linear issue: ${proposal.title}`;
      body = renderLinearIssueDraft(proposal, { sourceMaterial: markdown, proposer });
      generated = true;
    } catch {
      const firstLine = markdown.split("\n").map((line) => line.trim()).find(Boolean) ?? note.title;
      title = `Linear issue: ${firstLine}`;
      body = draftBody("linear-issue", { firstLine, material: markdown });
    }
    // Provenance rides the link graph: the draft links back to its source note.
    body += `\n\nDrafted from [[${note.title}]].`;
    const draft = await createNoteInTx(tx, auth, { title, content: { format: "markdown", text: body }, plainText: body, kind: "note" });
    await syncNoteLinks(tx, auth, draft.id, body);
    return { artifactId: draft.id, title, generated };
  });
}
