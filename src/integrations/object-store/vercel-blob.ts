import { get, put } from "@vercel/blob";
import { MAX_UPLOAD_BYTES } from "@/lib/file-validation";
import { sha256Hex } from "@/lib/hash";

/*
 * The Vercel Blob adapter (D2: Vercel primary, R2 documented fallback). Private
 * storage with OIDC on Vercel; locally, BLOB_READ_WRITE_TOKEN comes from
 * `vercel env pull`. Reads use the authenticated SDK, never a public URL fetch.
 *
 * The @vercel/blob package is the only Vercel import in the tree outside
 * framework config; swapping to R2 means replacing this one file.
 */

export async function putBlob(input: {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
  workspaceId: string;
  /** Caller-supplied digest of the same bytes; skips re-hashing on intake. */
  contentHash?: string;
}): Promise<{ storageKey: string; contentHash: string; sizeBytes: number }> {
  // The storage key is not a credential; reads require server-side Blob auth.
  const blob = await put(
    `workspaces/${input.workspaceId}/${crypto.randomUUID()}/${input.filename}`,
    new Blob([new Uint8Array(input.bytes)], { type: input.contentType }),
    { access: "private", addRandomSuffix: false },
  );
  const contentHash = input.contentHash ?? (await sha256Hex(input.bytes));
  return { storageKey: blob.url, contentHash, sizeBytes: input.bytes.byteLength };
}

/** Server-side only; callers must authorize the stored key's workspace first. */
export async function readBlob(storageKey: string): Promise<Uint8Array> {
  // The SDK supplies Blob credentials and validates the URL's store origin.
  // Never attach a read-write token to an arbitrary fetch URL.
  const result = await get(storageKey, {
    access: "private",
    abortSignal: AbortSignal.timeout(30_000),
  });
  if (!result || result.statusCode !== 200) throw new Error("Stored blob is unavailable");
  if (result.blob.size > MAX_UPLOAD_BYTES) {
    await result.stream.cancel();
    throw new Error("Stored blob exceeds the extraction size limit");
  }

  const reader = result.stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      size += value.byteLength;
      // Enforce the bound on actual bytes, even if metadata is absent or wrong.
      if (size > MAX_UPLOAD_BYTES) throw new Error("Stored blob exceeds the extraction size limit");
      chunks.push(value);
    }
  } finally {
    try {
      if (!complete) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
