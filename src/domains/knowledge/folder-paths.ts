import { and, eq, isNull } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { recordAudit } from "@/domains/audit/record";
import { validateFolderName } from "./folders";
import { documentFolders } from "./schema";

/*
 * Upload-time folder resolution: a dropped or picked folder arrives as a
 * relative path per file, and the vault files every document under the folder
 * chain that path names. Folders are created on demand — an upload never
 * fails because its folder does not exist yet. Only subdirectory paths create
 * folders; a bare filename files where the caller points (the library root by
 * default, or the folder the owner is standing in).
 */

export type FolderPathResult = {
  /** Folder id to file under, or null for the library root. */
  folderId: string | null;
  /** Names this call created, for the audit summary. */
  created: string[];
};

export type FolderPathOptions = {
  /** Resolve the path underneath this folder instead of the library root. */
  parentId?: string | null;
  /** False when the caller writes its own audit row. */
  audit?: boolean;
};

/**
 * Resolve one "Reports/2026/Lease.pdf" style path to the id of its "2026"
 * folder, creating any missing folders along the way. Idempotent: the second
 * upload into the same path joins the same chain, and a lost create race
 * re-reads and joins the winner's folder.
 */
export async function resolveFolderPath(
  auth: AuthContext,
  path: string,
  options: FolderPathOptions = {},
): Promise<FolderPathResult> {
  const { parentId: baseId = null, audit = true } = options;
  const segments = path
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return { folderId: baseId, created: [] };

  const created: string[] = [];
  let parentId = baseId;
  for (const segment of segments) {
    const name = validateFolderName(segment);
    const siblings = await db
      .select({ id: documentFolders.id, name: documentFolders.name })
      .from(documentFolders)
      .where(
        and(
          eq(documentFolders.workspaceId, auth.workspaceId),
          isNull(documentFolders.archivedAt),
          parentId === null ? isNull(documentFolders.parentId) : eq(documentFolders.parentId, parentId),
        ),
      );
    const match = siblings.find((row) => row.name.toLowerCase() === name.toLowerCase());
    if (match) {
      parentId = match.id;
      continue;
    }
    const [folder]: { id: string }[] | undefined[] = await db
      .insert(documentFolders)
      .values({ workspaceId: auth.workspaceId, parentId, name, createdBy: auth.userId, updatedBy: auth.userId })
      .onConflictDoNothing()
      .returning({ id: documentFolders.id });
    if (folder) {
      parentId = folder.id;
      created.push(name);
      continue;
    }
    // Lost the unique-index race to a concurrent create: re-read and join it.
    const after = await db
      .select({ id: documentFolders.id, name: documentFolders.name })
      .from(documentFolders)
      .where(
        and(
          eq(documentFolders.workspaceId, auth.workspaceId),
          isNull(documentFolders.archivedAt),
          parentId === null ? isNull(documentFolders.parentId) : eq(documentFolders.parentId, parentId),
        ),
      );
    const raced = after.find((row) => row.name.toLowerCase() === name.toLowerCase());
    if (!raced) throw new Error("Folder could not be created or found.");
    parentId = raced.id;
  }

  if (audit && created.length > 0) {
    await recordAudit(auth, {
      action: "document_folder.created",
      subjectType: "document_folder",
      subjectId: parentId!,
      summary: `Created folder${created.length === 1 ? "" : "s"} ${created.join(" / ")} while uploading`,
    });
  }
  return { folderId: parentId, created };
}

/** Every distinct directory path in one upload, resolved once. */
export async function resolveFolderPaths(
  auth: AuthContext,
  paths: string[],
): Promise<Map<string, string | null>> {
  const resolved = new Map<string, string | null>();
  for (const path of [...new Set(paths)]) {
    const result = await resolveFolderPath(auth, path);
    resolved.set(path, result.folderId);
  }
  return resolved;
}
