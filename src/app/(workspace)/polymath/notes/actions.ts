"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { IdempotencyConflictError } from "@/domains/audit/receipt";
import {
  NoteNotFoundError,
  VersionConflictError,
  autosaveNoteDraft,
  commitNoteSnapshot,
  createNote,
  listNotes,
  listNoteVersions,
  renameNote,
  retryNoteEmbedding,
  setNoteTags,
} from "@/domains/knowledge/notes";
import { createEngine } from "@/domains/agents/engine";
import { ensureProfile } from "@/domains/agents/commands";
import { createEveDriver, eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { dismissSemanticLink, LinkEditError, promoteSemanticLink, RELATION_TYPES, removeLink, setLinkRelation } from "@/domains/knowledge/relations";
import { NOTE_AI_ACTIONS, NoteAIError, applyNoteAIResult, getNoteAIRunOutput, startNoteAIRun } from "@/domains/knowledge/note-ai";
import { NoteCommentError, addNoteComment, listNoteComments, resolveNoteComment } from "@/domains/knowledge/note-comments";
import { LinearIssueNoteError, draftLinearIssueFromNote, type LinearIssueDraftResult } from "@/domains/capture/linear-issue-proposal";
import { searchKnowledge } from "@/domains/knowledge/retrieval";
import { safeArtifactEmbedError } from "@/domains/knowledge/embedding";
import { searchCapturesForLink } from "@/domains/capture/queries";
import { searchTasksForLink } from "@/domains/work/queries";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { resolveConnectedAccount } from "@/domains/integrations/queries";
import { composioNotionClient } from "@/integrations/notion/client";
import { noteNotionDedupeKey, proposeNotionPageUpdate } from "@/domains/knowledge/notion-proposals";
import { requireRole } from "@/lib/auth/guards";

/*
 * Notes mutations on the canonical artifact rows (ASH-141 / B04). A note
 * written here is the same row generated artifacts use; slash blocks, media
 * and [[ autocomplete are the D11 follow-up on top of this core.
 */

const revalidate = () => revalidatePath("/polymath/notes");

/*
 * Notes writes (create/autosave/commit/rename and the AI pass that spends
 * a run) require member or above; reading a run's output stays membership-
 * only so a viewer can watch progress (ASH-121 AC05).
 */
async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

type Result<T extends object> = ({ ok: true } & T) | { ok: false; error: string };
const domainErrors = [LinkEditError, NoteNotFoundError, VersionConflictError, IdempotencyConflictError, NoteAIError, LinearIssueNoteError, NoteCommentError];

async function guarded<T extends object>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    const value = await run();
    revalidate();
    return { ok: true, ...value };
  } catch (error) {
    if (domainErrors.some((E) => error instanceof E)) return { ok: false, error: (error as Error).message };
    throw error;
  }
}

const content = z.record(z.string(), z.unknown());
const key = z.string().uuid().optional();

const createInput = z.object({
  title: z.string().trim().min(1).max(300),
  content: content.optional(),
  plainText: z.string().max(200_000).optional(),
  idempotencyKey: key,
});

export async function createNoteAction(input: z.input<typeof createInput>): Promise<Result<{ artifactId: string }>> {
  const parsed = createInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Give the note a title." };
  const auth = await authorize();
  return guarded(async () => ({ artifactId: (await createNote(auth, parsed.data)).id }));
}

const autosaveInput = z.object({
  artifactId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  content,
  plainText: z.string().max(200_000).optional(),
  idempotencyKey: key,
});

export async function autosaveNoteAction(input: z.input<typeof autosaveInput>): Promise<Result<{ version: number }>> {
  const parsed = autosaveInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That autosave is not valid." };
  const auth = await authorize();
  return guarded(async () => ({ version: (await autosaveNoteDraft(auth, parsed.data)).version }));
}

const commitInput = z.object({
  artifactId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  content,
  plainText: z.string().max(200_000).optional(),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: key,
});

export async function commitNoteAction(input: z.input<typeof commitInput>): Promise<Result<{ version: number; versionNumber: number; versions: { id: string; versionNumber: number; reason: string; note: string | null; createdAt: string }[] }>> {
  const parsed = commitInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That checkpoint is not valid." };
  const auth = await authorize();
  return guarded(async () => {
    const { version, versionNumber } = await commitNoteSnapshot(auth, parsed.data);
    const versions = await listNoteVersions(auth, parsed.data.artifactId);
    return { version, versionNumber, versions: versions.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })) };
  });
}

const renameInput = z.object({
  artifactId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  title: z.string().trim().min(1).max(300),
  idempotencyKey: key,
});

const retryEmbedInput = z.object({ artifactId: z.string().uuid() });

/*
 * Re-run meaning indexing for one note. The commit path embeds best-effort,
 * so a note saved while the embedding provider was unconfigured (or a
 * transient failure) carries artifacts.embed_error and stays invisible to
 * meaning search until this runs. The call is the member's own, scoped to
 * their workspace's note; the outcome string is the provider's honest state,
 * never a blanket "indexed".
 */
export async function retryNoteEmbeddingAction(input: z.input<typeof retryEmbedInput>): Promise<Result<{ message: string }>> {
  const auth = await authorize();
  const parsed = retryEmbedInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That note id is not valid." };
  try {
    const out = await retryNoteEmbedding(auth, parsed.data);
    revalidate();
    if (out.status === "succeeded") return { ok: true, message: "Indexed for meaning search." };
    if (out.status === "skipped") {
      const reason = out.reason === "no_text" ? "This note has no text to index yet."
        : out.reason === "busy" ? "Indexing is already in progress for this note."
        : out.reason === "edited" ? "This note changed while indexing. Retry to index the latest version."
        : "That note is not here.";
      return { ok: false, error: reason };
    }
    // Authored categories only: a provider payload must never reach the UI.
    return { ok: false, error: safeArtifactEmbedError(out.error) ?? "Indexing failed. Retry to try again." };
  } catch (error) {
    if (error instanceof NoteNotFoundError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function renameNoteAction(input: z.input<typeof renameInput>): Promise<Result<{ version: number }>> {
  const parsed = renameInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Give the note a title." };
  const auth = await authorize();
  return guarded(async () => ({ version: (await renameNote(auth, parsed.data)).version }));
}

const linkRelatedInput = z.object({ artifactId: z.string().uuid(), targetId: z.string().uuid() });

/** Confirm a "related by meaning" suggestion into the explicit graph. */
export async function linkRelatedNoteAction(input: z.input<typeof linkRelatedInput>): Promise<Result<{ linked: true }>> {
  const parsed = linkRelatedInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That suggestion is not valid." };
  const auth = await authorize();
  return guarded(async () => {
    if (!(await promoteSemanticLink(auth, parsed.data))) throw new NoteNotFoundError();
    return { linked: true as const };
  });
}

const relationInput = z.object({
  artifactId: z.string().uuid(),
  targetId: z.string().uuid(),
  linkType: z.enum(RELATION_TYPES),
  why: z.string().max(500).optional(),
});

/** Name what a link means and why (ASH-110: similarity is not a relationship). */
export async function setLinkRelationAction(input: z.input<typeof relationInput>): Promise<Result<{ saved: true }>> {
  const parsed = relationInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That relationship is not valid." };
  const auth = await authorize();
  return guarded(async () => {
    await setLinkRelation(auth, parsed.data);
    return { saved: true as const };
  });
}

/** Remove a curated link or reject a suggestion; neither touches the notes. */
export async function removeLinkAction(input: z.input<typeof linkRelatedInput> & { dismiss?: boolean }): Promise<Result<{ removed: true }>> {
  const parsed = linkRelatedInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That link is not valid." };
  const auth = await authorize();
  return guarded(async () => {
    if (input.dismiss) {
      if (!(await dismissSemanticLink(auth, parsed.data))) throw new NoteNotFoundError();
    } else {
      await removeLink(auth, parsed.data);
    }
    return { removed: true as const };
  });
}

const tagsInput = z.object({
  artifactId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  tags: z.array(z.string().max(60)).max(20),
  idempotencyKey: key,
});

export async function setNoteTagsAction(input: z.input<typeof tagsInput>): Promise<Result<{ version: number; tags: string[] }>> {
  const parsed = tagsInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Those tags are not valid." };
  const auth = await authorize();
  return guarded(async () => setNoteTags(auth, parsed.data));
}

/* ---------------------------------------------------------------------------
 * Notes AI. Starts a run bound to the note, polls its output, and applies
 * an accepted draft as a checkpoint with run lineage. The run is the spend
 * and audit unit; the panel only ever stages the result for acceptance.
 * ------------------------------------------------------------------------- */

const aiStartInput = z.object({
  artifactId: z.string().uuid(),
  action: z.enum(NOTE_AI_ACTIONS),
  selection: z.string().max(20_000).optional(),
  question: z.string().max(2000).optional(),
  language: z.string().trim().max(60).optional(),
});

export async function startNoteAIAction(input: z.input<typeof aiStartInput>): Promise<Result<{ runId: string }>> {
  const parsed = aiStartInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That AI request is not valid." };
  const unavailable = eveBridgeUnavailableReason();
  if (unavailable) return { ok: false, error: unavailable };
  const auth = await authorize();
  return guarded(async () => {
    await ensureProfile(auth.workspaceId);
    return startNoteAIRun(auth, parsed.data, createEngine(createEveDriver()));
  });
}

const aiPollInput = z.object({ runId: z.string().uuid() });

/** A read, polled by the editor while a run is live — deliberately no revalidate. */
export async function getNoteAIRunOutputAction(input: z.input<typeof aiPollInput>): Promise<Result<{ state: string; output: string | null }>> {
  const parsed = aiPollInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That run reference is not valid." };
  const auth = await getAuthContext();
  try {
    const run = await getNoteAIRunOutput(auth, parsed.data.runId);
    return { ok: true, state: run.state, output: run.output };
  } catch (error) {
    if (domainErrors.some((E) => error instanceof E)) return { ok: false, error: (error as Error).message };
    throw error;
  }
}

const aiApplyInput = z.object({
  artifactId: z.string().uuid(),
  runId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  content,
  plainText: z.string().max(200_000).optional(),
  idempotencyKey: key,
});

export async function applyNoteAIResultAction(input: z.input<typeof aiApplyInput>): Promise<Result<{ version: number; versionNumber: number }>> {
  const parsed = aiApplyInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That apply request is not valid." };
  const auth = await authorize();
  return guarded(async () => applyNoteAIResult(auth, parsed.data));
}

const findInput = z.object({ query: z.string().max(200), mode: z.enum(["keyword", "hybrid"]), excludeId: z.string().uuid().optional() });

/**
 * Cards the `[[` picker can link to, from the same retrieval layer as search.
 * An empty query lists recent cards so the menu is useful the moment it opens.
 * A read: membership is enough, and nothing is revalidated.
 */
/* ---------------------------------------------------------------------------
 * Margin comments on a note (Notion-feel). Writes are member actions; the
 * panel's initial comments arrive server-rendered with the note, and these
 * actions return the freshly written row so the panel can append it without
 * a refetch round trip.
 * ------------------------------------------------------------------------- */

const addCommentInput = z.object({
  noteId: z.string().uuid(),
  body: z.string().trim().min(1, "Write a comment first.").max(2000, "Comments hold up to 2000 characters."),
  idempotencyKey: key,
});

export async function addNoteCommentAction(input: z.input<typeof addCommentInput>): Promise<Result<{ comment: { id: string; body: string; resolvedAt: string | null; createdAt: string; authorName: string | null } }>> {
  const parsed = addCommentInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "That comment is not valid." };
  const auth = await authorize();
  return guarded(async () => {
    const comment = await addNoteComment(auth, parsed.data);
    return {
      comment: {
        id: comment.id,
        body: comment.body,
        resolvedAt: comment.resolvedAt ? comment.resolvedAt.toISOString() : null,
        createdAt: comment.createdAt.toISOString(),
        authorName: comment.authorName,
      },
    };
  });
}

const resolveCommentInput = z.object({
  commentId: z.string().uuid(),
  resolved: z.boolean(),
  idempotencyKey: key,
});

export async function resolveNoteCommentAction(input: z.input<typeof resolveCommentInput>): Promise<Result<{ resolvedAt: string | null }>> {
  const parsed = resolveCommentInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That comment reference is not valid." };
  const auth = await authorize();
  return guarded(async () => {
    const { resolvedAt } = await resolveNoteComment(auth, parsed.data);
    return { resolvedAt: resolvedAt ? resolvedAt.toISOString() : null };
  });
}

/** The open note's comments for the margin panel, oldest first. A read. */
export async function listNoteCommentsAction(input: { noteId: string }): Promise<{ id: string; body: string; resolvedAt: string | null; createdAt: string; authorName: string | null }[]> {
  const parsed = z.object({ noteId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return [];
  const auth = await getAuthContext();
  try {
    const rows = await listNoteComments(auth, parsed.data.noteId);
    return rows.map((c) => ({
      id: c.id,
      body: c.body,
      resolvedAt: c.resolvedAt ? c.resolvedAt.toISOString() : null,
      createdAt: c.createdAt.toISOString(),
      authorName: c.authorName,
    }));
  } catch {
    // A bad or foreign note id is the empty panel, not an error surface;
    // the note itself 404s elsewhere.
    return [];
  }
}

const proposeIssueInput = z.object({ artifactId: z.string().uuid() });

/**
 * ASH-285: draft a fully formed Linear issue proposal from this note. The
 * result is a note linking back to its source; with no generation provider
 * configured it is the honest deterministic scaffold instead. Repeats are
 * honest too: unchanged source replays the existing draft, a changed source
 * refreshes it as a new version. It never talks to Linear.
 */
export async function proposeLinearIssueAction(input: z.input<typeof proposeIssueInput>): Promise<Result<LinearIssueDraftResult>> {
  const parsed = proposeIssueInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That issue request is not valid." };
  const auth = await authorize();
  return guarded(async () => draftLinearIssueFromNote(auth, parsed.data));
}

export async function findLinkTargetsAction(input: z.input<typeof findInput>): Promise<{ id: string; title: string; kind: string; href?: string }[]> {
  const parsed = findInput.safeParse(input);
  if (!parsed.success) return [];
  const auth = await getAuthContext();
  const query = parsed.data.query.trim();
  if (!query) return (await listNotes(auth, 9)).filter((r) => r.id !== parsed.data.excludeId).slice(0, 8).map((r) => ({ id: r.id, title: r.title, kind: r.kind }));
  // Row 36: the picker searches beyond knowledge artifacts - captures and
  // tasks match too. Non-artifact targets carry a canonical href (captures
  // resolve at the inbox, tasks at the tasks page); the editor inserts those
  // as real links, since a [[wiki link]] edge can only point at note/zettel.
  const [knowledge, captureRows, taskRows] = await Promise.all([
    searchKnowledge(auth, { query, mode: parsed.data.mode, limit: 9 }),
    searchCapturesForLink(auth, query),
    searchTasksForLink(auth, query),
  ]);
  const rows: { id: string; title: string; kind: string; href?: string }[] = [
    ...knowledge.hits.map((r) => ({ id: r.id, title: r.title, kind: r.kind })),
    ...captureRows,
    ...taskRows,
  ];
  return rows.filter((r) => r.id !== parsed.data.excludeId).slice(0, 8);
}

/*
 * ASH-283: queue the current note as a Notion page append, for approval. The
 * editor's action only proposes — the review queue shows the diff, and the
 * executor is the only thing that writes to Notion. `notionPageId` is chosen
 * by the owner in the editor, so the proposal names a page they picked rather
 * than one a model inferred.
 */
const toNotionInput = z.object({
  noteId: z.string().uuid(),
  notionPageId: z.string().trim().min(1).max(200),
  notionPageTitle: z.string().trim().min(1).max(300),
  markdown: z.string().trim().min(1).max(20_000),
});

export async function proposeNotionAppendAction(
  input: z.input<typeof toNotionInput>,
): Promise<Result<{ proposalId: string; contentHash: string }>> {
  const parsed = toNotionInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Pick a Notion page and write the content first." };
  const auth = await authorize();
  const { noteId, notionPageId, notionPageTitle, markdown } = parsed.data;
  // The page id is user input, so it is shape-checked before it reaches a URL.
  // Notion ids are 32 hex characters, with or without dashes.
  if (!/^[0-9a-f]{32}$/i.test(notionPageId.replace(/-/g, ""))) {
    return { ok: false, error: "That does not look like a Notion page id." };
  }
  try {
    // Read the page so the review card shows what the addition lands under. A
    // missing connection or a read failure leaves the diff without context
    // rather than blocking the proposal.
    const account = await resolveConnectedAccount(auth, "notion");
    const result = await proposeNotionPageUpdate(auth, {
      ...(account.ok ? { readClient: composioNotionClient(account.connectedAccountId) } : {}),
      mode: "append",
      pageId: notionPageId,
      title: notionPageTitle,
      markdown,
      // Keyed on the note, the page and the exact text: re-queuing unchanged
      // content resolves the open proposal, while an edited note proposes
      // again instead of silently resolving to a diff of the old text.
      dedupeKey: noteNotionDedupeKey(noteId, notionPageId, markdown),
    });
    revalidatePath("/reviews");
    return { ok: true, proposalId: result.proposalId, contentHash: result.contentHash };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The Notion proposal was not created." };
  }
}

/** The pages the connected Notion account has shared, for the editor's picker. */
export async function listNotionPagesAction(): Promise<{ id: string; title: string; url: string }[]> {
  const auth = await getAuthContext();
  const account = await resolveConnectedAccount(auth, "notion");
  if (!account.ok) return [];
  try {
    const client = composioNotionClient(account.connectedAccountId);
    const hits = await client.searchEditedSince(null);
    return hits.filter((hit) => hit.object === "page").slice(0, 25).map((hit) => ({ id: hit.id, title: hit.title, url: hit.url }));
  } catch {
    // A Notion outage must not make the note editor unusable; the picker is
    // simply empty and the action reports the real failure when used.
    return [];
  }
}
