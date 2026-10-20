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
  renameNote,
  setNoteTags,
} from "@/domains/knowledge/notes";
import { createEngine } from "@/domains/agents/engine";
import { ensureProfile } from "@/domains/agents/commands";
import { createEveDriver, eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { promoteSemanticLink } from "@/domains/knowledge/relations";
import { NOTE_AI_ACTIONS, NoteAIError, applyNoteAIResult, getNoteAIRunOutput, startNoteAIRun } from "@/domains/knowledge/note-ai";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Notebook mutations on the canonical artifact rows (ASH-141 / B04). A note
 * written here is the same row generated artifacts use; slash blocks, media
 * and [[ autocomplete are the D11 follow-up on top of this core.
 */

const revalidate = () => revalidatePath("/alfred/notebook");

/*
 * Notebook writes (create/autosave/commit/rename and the AI pass that spends
 * a run) require member or above; reading a run's output stays membership-
 * only so a viewer can watch progress (ASH-121 AC05).
 */
async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

type Result<T extends object> = ({ ok: true } & T) | { ok: false; error: string };
const domainErrors = [NoteNotFoundError, VersionConflictError, IdempotencyConflictError, NoteAIError];

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

export async function commitNoteAction(input: z.input<typeof commitInput>): Promise<Result<{ version: number; versionNumber: number }>> {
  const parsed = commitInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That checkpoint is not valid." };
  const auth = await authorize();
  return guarded(async () => {
    const { version, versionNumber } = await commitNoteSnapshot(auth, parsed.data);
    return { version, versionNumber };
  });
}

const renameInput = z.object({
  artifactId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  title: z.string().trim().min(1).max(300),
  idempotencyKey: key,
});

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
 * Notebook AI. Starts a run bound to the note, polls its output, and applies
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
