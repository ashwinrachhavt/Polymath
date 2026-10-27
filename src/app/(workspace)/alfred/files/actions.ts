"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { archiveFolder, createFolder, FolderError, renameFolder, setDocumentFolder } from "@/domains/knowledge/folders";
import { addTag, removeTag, TagError } from "@/domains/knowledge/tags";
import { createExportManifest, ExportManifestError } from "@/domains/knowledge/exports";
import { assembleExportPacket, ExportPacketError } from "@/domains/knowledge/packets";
import { getExplorerPage, type ExplorerPage } from "@/domains/knowledge/file-rows";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";

/*
 * Mutations behind the Files surface, over the library backend's folder
 * domain. Organising is a write, so every action needs member or above.
 * Results are returned, not thrown: a production build hides a thrown
 * message, and "that name is taken" or "folder is not empty" is something the
 * owner should read. Anything that is not a known FolderError is rethrown.
 */

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const id = z.string().uuid();
const name = z.string().max(200);
const version = z.number().int();

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

async function run<T extends object>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const result = await fn();
    revalidatePath("/alfred/files");
    return { ok: true, ...result };
  } catch (cause) {
    if (cause instanceof TagError) return { ok: false, error: cause.message };
    if (cause instanceof FolderError) return { ok: false, error: cause.message };
    if (cause instanceof z.ZodError) return { ok: false, error: "That request was not valid." };
    throw cause;
  }
}

export async function createFolderAction(folderName: string, parentId: string | null) {
  const auth = await authorize();
  return run(async () => {
    const folder = await createFolder(auth, { name: name.parse(folderName), parentId: parentId === null ? null : id.parse(parentId) });
    return { folderId: folder.id };
  });
}

export async function renameFolderAction(folderId: string, folderName: string, expectedVersion: number) {
  const auth = await authorize();
  return run(async () => {
    await renameFolder(auth, { folderId: id.parse(folderId), name: name.parse(folderName), expectedVersion: version.parse(expectedVersion) });
    return {};
  });
}

export async function removeFolderAction(folderId: string, expectedVersion: number) {
  const auth = await authorize();
  return run(async () => {
    await archiveFolder(auth, { folderId: id.parse(folderId), expectedVersion: version.parse(expectedVersion) });
    return {};
  });
}

/** File documents into a folder (null = root). Each move is version-checked; a stale one is reported, the rest still land. */
export async function moveDocumentsAction(items: Array<{ documentId: string; expectedVersion: number }>, folderId: string | null) {
  const auth = await authorize();
  return run(async () => {
    const parsed = z.array(z.object({ documentId: id, expectedVersion: version })).min(1).max(100).parse(items);
    const target = folderId === null ? null : id.parse(folderId);
    let moved = 0;
    let stale = 0;
    for (const item of parsed) {
      try {
        await setDocumentFolder(auth, { documentId: item.documentId, folderId: target, expectedVersion: item.expectedVersion });
        moved += 1;
      } catch (cause) {
        if (cause instanceof FolderError && cause.code === "stale_write") stale += 1;
        else throw cause;
      }
    }
    if (moved === 0 && stale > 0) throw new FolderError("stale_write", "Those documents changed. Reload to see the current state.");
    return { moved, stale };
  });
}

export async function addTagAction(documentIds: string[], tag: string) {
  const auth = await authorize();
  return run(async () => {
    await addTag(auth, { documentIds: z.array(id).min(1).max(200).parse(documentIds), tag: name.parse(tag) });
    return {};
  });
}

export async function removeTagAction(documentIds: string[], tag: string) {
  const auth = await authorize();
  return run(async () => {
    await removeTag(auth, { documentIds: z.array(id).min(1).max(200).parse(documentIds), tag: name.parse(tag) });
    return {};
  });
}

/** Next page (or a re-sorted / searched first page) of the library, read by the explorer. Viewers may read. */
export async function loadPageAction(input: { sort: "added" | "recent" | "title" | "size"; cursor?: string; q?: string; taskId?: string }): Promise<ActionResult<{ page: ExplorerPage }>> {
  const auth = await getAuthContext();
  requireRole(auth, "viewer");
  const parsed = z.object({ sort: z.enum(["added", "recent", "title", "size"]), cursor: z.string().max(500).optional(), q: z.string().max(200).optional(), taskId: z.string().uuid().optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "That request was not valid." };
  const page = await getExplorerPage(auth, parsed.data);
  return { ok: true, page };
}

/**
 * Build a zip packet of a document's pinned versions and hand back its download
 * path. The manifest is the packet's source of truth, so one is created for the
 * file; nothing leaves the workspace.
 */
export async function downloadPacketAction(documentId: string, title: string): Promise<ActionResult<{ downloadPath: string }>> {
  const auth = await authorize();
  try {
    const manifest = await createExportManifest(auth, { name: `${z.string().max(160).parse(title).trim() || "Document"} packet`, items: [{ documentId: id.parse(documentId) }] });
    const packet = await assembleExportPacket(auth, { manifestId: manifest.id });
    return { ok: true, downloadPath: `/api/v1/exports/packets/${packet.packetId}` };
  } catch (cause) {
    if (cause instanceof ExportManifestError || cause instanceof ExportPacketError) return { ok: false, error: cause.message };
    if (cause instanceof z.ZodError) return { ok: false, error: "That request was not valid." };
    throw cause;
  }
}
