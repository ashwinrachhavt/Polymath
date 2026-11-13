import { deleteLocalBlob, LOCAL_KEY_PREFIX, putLocalBlob, readLocalBlob } from "./local-fs";
import { localDiskEnabled, objectStoreMode } from "./mode";
import { deleteBlob as deleteVercelBlob, putBlob as putVercelBlob, readBlob as readVercelBlob } from "./vercel-blob";

/*
 * The object-store seam: Vercel Blob when it is configured, otherwise the
 * local disk where mode.ts allows it (development, or a self-hosted
 * production that opted in with a volume). With neither it fails closed with
 * a message naming what to set. Reads route by the stored key, so a document
 * uploaded locally stays readable after a token is added, and a local key is
 * refused wherever local disk is not enabled.
 *
 * Local files are never served as static assets: every read goes through
 * readBlob from a route that has already checked the caller's workspace
 * (src/lib/blob-serve.ts).
 */

export { objectStoreMode };

export class ObjectStoreUnconfiguredError extends Error {
  constructor() {
    super(
      "Private file storage is not configured. Set BLOB_READ_WRITE_TOKEN (or BLOB_STORE_ID with Vercel OIDC), or POLYMATH_OBJECT_STORE=local-disk with AXIOM_LOCAL_BLOB_DIR on a persistent volume.",
    );
    this.name = "ObjectStoreUnconfiguredError";
  }
}

export async function putBlob(input: Parameters<typeof putVercelBlob>[0]) {
  const mode = objectStoreMode();
  if (mode === "unconfigured") throw new ObjectStoreUnconfiguredError();
  return mode === "local" ? putLocalBlob(input) : putVercelBlob(input);
}

/**
 * Removes an object this run just wrote, routing by key like reads. Callers
 * treat it as best-effort: a missed delete leaves storage garbage, never a
 * live reference - blob_objects is the only ledger that makes bytes reachable.
 */
export async function deleteBlob(storageKey: string): Promise<void> {
  if (!storageKey.startsWith(LOCAL_KEY_PREFIX)) return deleteVercelBlob(storageKey);
  if (!localDiskEnabled()) throw new Error("Local blobs are not deletable in this deployment");
  return deleteLocalBlob(storageKey);
}

/** Server-side only; callers must authorize the stored key's workspace first. */
export async function readBlob(storageKey: string): Promise<Uint8Array> {
  if (!storageKey.startsWith(LOCAL_KEY_PREFIX)) return readVercelBlob(storageKey);
  if (!localDiskEnabled()) throw new Error("Local blobs are not readable in this deployment");
  return readLocalBlob(storageKey);
}
