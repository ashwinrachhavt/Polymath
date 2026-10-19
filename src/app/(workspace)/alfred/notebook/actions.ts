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
} from "@/domains/knowledge/notes";
import { getAuthContext } from "@/lib/auth";

/*
 * Notebook mutations on the canonical artifact rows (ASH-141 / B04). A note
 * written here is the same row generated artifacts use; slash blocks, media
 * and [[ autocomplete are the D11 follow-up on top of this core.
 */

const revalidate = () => revalidatePath("/alfred/notebook");

type Result<T extends object> = ({ ok: true } & T) | { ok: false; error: string };
const domainErrors = [NoteNotFoundError, VersionConflictError, IdempotencyConflictError];

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
  const auth = await getAuthContext();
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
  const auth = await getAuthContext();
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
  const auth = await getAuthContext();
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
  const auth = await getAuthContext();
  return guarded(async () => ({ version: (await renameNote(auth, parsed.data)).version }));
}
