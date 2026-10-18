import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_UPLOAD_BYTES } from "@/lib/file-validation";
import { sha256Hex } from "@/lib/hash";

/*
 * Development object store: binaries on the local disk under
 * AXIOM_LOCAL_BLOB_DIR, so upload and extraction run without a Vercel Blob
 * token. object-store.ts never selects it in production. Keys are
 * "local:<relative path>" and every read resolves inside the root, so a stored
 * key cannot walk out of it.
 */

export const LOCAL_KEY_PREFIX = "local:";

function root(): string {
  return path.resolve(process.env.AXIOM_LOCAL_BLOB_DIR ?? path.join(process.cwd(), ".cache", "axiom-blob"));
}

function resolveKey(storageKey: string): string {
  const relative = storageKey.slice(LOCAL_KEY_PREFIX.length);
  const base = root();
  const full = path.resolve(base, relative);
  if (!storageKey.startsWith(LOCAL_KEY_PREFIX) || !full.startsWith(base + path.sep)) {
    throw new Error("Stored blob key is outside the local store");
  }
  return full;
}

export async function putLocalBlob(input: {
  bytes: Uint8Array;
  filename: string;
  workspaceId: string;
  contentHash?: string;
}): Promise<{ storageKey: string; contentHash: string; sizeBytes: number }> {
  const safeName = input.filename.replace(/[^\w.-]+/g, "_").slice(0, 120) || "file";
  const storageKey = `${LOCAL_KEY_PREFIX}workspaces/${input.workspaceId}/${crypto.randomUUID()}/${safeName}`;
  const full = resolveKey(storageKey);
  await mkdir(path.dirname(full), { recursive: true });
  // "wx": a key is written once; a collision is a bug, not an overwrite.
  await writeFile(full, input.bytes, { flag: "wx" });
  const contentHash = input.contentHash ?? (await sha256Hex(input.bytes));
  return { storageKey, contentHash, sizeBytes: input.bytes.byteLength };
}

export async function readLocalBlob(storageKey: string): Promise<Uint8Array> {
  const full = resolveKey(storageKey);
  if ((await stat(full)).size > MAX_UPLOAD_BYTES) {
    throw new Error("Stored blob exceeds the extraction size limit");
  }
  return new Uint8Array(await readFile(full));
}
