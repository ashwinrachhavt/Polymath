"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { addTag, archiveFolder, createFolder, FolderError, moveDocuments, removeTag, renameFolder } from "@/domains/knowledge/folders";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Mutations behind the Files surface. Organising is a write, so every action
 * needs member or above. Results are returned, not thrown: a production build
 * hides a thrown message, and "that folder already exists" is something the
 * owner should read. Anything that is not a known FolderError is rethrown.
 */

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const id = z.string().uuid();
const ids = z.array(id).min(1).max(200);

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

async function run<T extends object>(auth: AuthContext, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const result = await fn();
    revalidatePath("/alfred/files");
    return { ok: true, ...result };
  } catch (cause) {
    if (cause instanceof FolderError) return { ok: false, error: cause.message };
    if (cause instanceof z.ZodError) return { ok: false, error: "That request was not valid." };
    throw cause;
  }
}

export async function createFolderAction(name: string) {
  const auth = await authorize();
  return run(auth, async () => {
    const folder = await createFolder(auth, { name: z.string().max(200).parse(name) });
    return { folderId: folder.id };
  });
}

export async function renameFolderAction(folderId: string, name: string, expectedVersion: number) {
  const auth = await authorize();
  return run(auth, async () => {
    await renameFolder(auth, { folderId: id.parse(folderId), name: z.string().max(200).parse(name), expectedVersion: z.number().int().parse(expectedVersion) });
    return {};
  });
}

export async function removeFolderAction(folderId: string, expectedVersion: number) {
  const auth = await authorize();
  return run(auth, async () => {
    await archiveFolder(auth, { folderId: id.parse(folderId), expectedVersion: z.number().int().parse(expectedVersion) });
    return {};
  });
}

export async function moveDocumentsAction(documentIds: string[], folderId: string | null) {
  const auth = await authorize();
  return run(auth, async () =>
    moveDocuments(auth, { documentIds: ids.parse(documentIds), folderId: folderId === null ? null : id.parse(folderId) }),
  );
}

export async function addTagAction(documentIds: string[], tag: string) {
  const auth = await authorize();
  return run(auth, async () => addTag(auth, { documentIds: ids.parse(documentIds), tag: z.string().max(200).parse(tag) }));
}

export async function removeTagAction(documentIds: string[], tag: string) {
  const auth = await authorize();
  return run(auth, async () => removeTag(auth, { documentIds: ids.parse(documentIds), tag: z.string().max(200).parse(tag) }));
}
