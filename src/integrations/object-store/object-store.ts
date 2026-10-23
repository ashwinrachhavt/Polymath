import { deleteLocalBlob, LOCAL_KEY_PREFIX, putLocalBlob, readLocalBlob } from "./local-fs";
import { deleteBlob as deleteVercelBlob, putBlob as putVercelBlob, readBlob as readVercelBlob } from "./vercel-blob";

/*
 * The object-store seam: Vercel Blob when it is configured, the local disk in
 * development when it is not. Production never falls back to disk; with no
 * Blob configuration it fails closed with a message naming what to set.
 * Reads route by the stored key, so a document uploaded locally stays
 * readable after a token is added, and a local key is refused in production.
 */

export function objectStoreMode(): "vercel-blob" | "local" | "unconfigured" {
  if (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID) return "vercel-blob";
  return process.env.NODE_ENV === "production" ? "unconfigured" : "local";
}

export class ObjectStoreUnconfiguredError extends Error {
  constructor() {
    super("Private file storage is not configured. Set BLOB_READ_WRITE_TOKEN, or BLOB_STORE_ID with Vercel OIDC.");
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
  if (process.env.NODE_ENV === "production") throw new Error("Local blobs are not deletable in production");
  return deleteLocalBlob(storageKey);
}

/** Server-side only; callers must authorize the stored key's workspace first. */
export async function readBlob(storageKey: string): Promise<Uint8Array> {
  if (!storageKey.startsWith(LOCAL_KEY_PREFIX)) return readVercelBlob(storageKey);
  if (process.env.NODE_ENV === "production") throw new Error("Local blobs are not readable in production");
  return readLocalBlob(storageKey);
}
