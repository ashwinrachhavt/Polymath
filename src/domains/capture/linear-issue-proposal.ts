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

import { createHash } from "crypto";
import { and, desc, eq, ilike } from "drizzle-orm";
import { db } from "@/lib/db";
import { commitNoteSnapshot, createNote } from "@/domains/knowledge/notes";
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

/*
 * Provenance and repeat semantics. Every proposal draft carries an HTML
 * comment recording its source artifact and the source's content hash:
 *   <!-- linear-issue-source: <artifactId>@<sha16> -->
 * A repeat invocation finds that draft: unchanged source replays the existing
 * draft (no silent duplicates), a changed source refreshes the same draft as
 * a new committed version (no silent staleness). The idempotency key is
 * derived from (source, hash), so concurrent same-content invocations
 * collapse on the receipt ledger instead of racing into two drafts.
 */
export const LINEAR_ISSUE_SOURCE_MARKER = "linear-issue-source";

export function sourceMarkerOf(sourceId: string, sourceHash: string): string {
  return `<!-- ${LINEAR_ISSUE_SOURCE_MARKER}: ${sourceId}@${sourceHash} -->`;
}

export function sourceHashOf(markdown: string): string {
  return createHash("sha256").update(markdown).digest("hex").slice(0, 16);
}

export function parseSourceMarker(plainText: string): { sourceId: string; sourceHash: string } | null {
  const m = plainText.match(new RegExp(`<!-- ${LINEAR_ISSUE_SOURCE_MARKER}: ([0-9a-f-]{36})@([0-9a-f]{16}) -->`));
  return m ? { sourceId: m[1], sourceHash: m[2] } : null;
}

/** Receipt keys must be UUID-shaped; derive one deterministically from the semantic identity of the write. */
function derivedKey(...parts: string[]): string {
  const hex = createHash("sha256").update(parts.join("|")).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export type LinearIssueDraftOutcome = "created" | "replayed" | "refreshed";

export type LinearIssueDraftResult = {
  artifactId: string;
  title: string;
  /** True when a generation provider filled the proposal; false when the honest scaffold is the content. */
  generated: boolean;
  outcome: LinearIssueDraftOutcome;
};

async function renderForSource(auth: AuthContext, source: { id: string; title: string; markdown: string }): Promise<{ title: string; body: string; generated: boolean }> {
  const hash = sourceHashOf(source.markdown);
  let title: string;
  let body: string;
  let generated = false;
  try {
    const { proposal, proposer } = await proposeLinearIssue(auth, { title: source.title, text: source.markdown });
    title = `Linear issue: ${proposal.title}`;
    body = renderLinearIssueDraft(proposal, { sourceMaterial: source.markdown, proposer });
    generated = true;
  } catch {
    const firstLine = source.markdown.split("\n").map((line) => line.trim()).find(Boolean) ?? source.title;
    title = `Linear issue: ${firstLine}`;
    body = draftBody("linear-issue", { firstLine, material: source.markdown });
  }
  // Provenance: a wiki-link the graph can follow, plus the machine marker.
  return { title, body: `${body}\n\n${sourceMarkerOf(source.id, hash)}\n\nDrafted from [[${source.title}]].`, generated };
}

/**
 * Draft a Linear-issue proposal from an existing note. Repeat calls are
 * honest: an unchanged source replays the existing draft, a changed source
 * refreshes that draft as a new version, and concurrent identical calls
 * collapse on the receipt ledger. Never talks to Linear.
 */
export async function draftLinearIssueFromNote(
  auth: AuthContext,
  input: { artifactId: string },
): Promise<LinearIssueDraftResult> {
  const [source] = await db
    .select({ id: artifacts.id, title: artifacts.title, content: artifactVersions.content })
    .from(artifacts)
    .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.kind, "note")))
    .limit(1);
  if (!source) throw new LinearIssueNoteError("note_not_found", "No such note.");
  const markdown = source.content && typeof (source.content as { text?: unknown }).text === "string" ? ((source.content as { text: string }).text as string) : "";
  const hash = sourceHashOf(markdown);

  const [existing] = await db
    .select({ id: artifacts.id, title: artifacts.title, version: artifacts.version, plainText: artifactVersions.plainText })
    .from(artifacts)
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(and(eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.kind, "note"), ilike(artifactVersions.plainText, `%${LINEAR_ISSUE_SOURCE_MARKER}: ${source.id}@%`)))
    .orderBy(desc(artifacts.updatedAt))
    .limit(1);

  if (existing) {
    const recorded = existing.plainText ? parseSourceMarker(existing.plainText) : null;
    if (recorded?.sourceHash === hash) {
      return { artifactId: existing.id, title: existing.title, generated: true, outcome: "replayed" };
    }
    const rendered = await renderForSource(auth, { id: source.id, title: source.title, markdown });
    await commitNoteSnapshot(auth, {
      idempotencyKey: derivedKey("linear-issue-refresh", auth.workspaceId, source.id, hash),
      artifactId: existing.id,
      expectedVersion: existing.version,
      content: { format: "markdown", text: rendered.body },
      plainText: rendered.body,
      note: "Source note changed; the issue proposal was regenerated.",
    });
    return { artifactId: existing.id, title: existing.title, generated: rendered.generated, outcome: "refreshed" };
  }

  const rendered = await renderForSource(auth, { id: source.id, title: source.title, markdown });
  const draft = await createNote(auth, {
    idempotencyKey: derivedKey("linear-issue-create", auth.workspaceId, source.id, hash),
    title: rendered.title,
    content: { format: "markdown", text: rendered.body },
    plainText: rendered.body,
    kind: "note",
  });
  return { artifactId: draft.id, title: rendered.title, generated: rendered.generated, outcome: "created" };
}
