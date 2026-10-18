import { put } from "@vercel/blob";

/*
 * The Vercel Blob adapter (D2: Vercel primary, R2 documented fallback). Private
 * storage with OIDC on Vercel; locally, BLOB_READ_WRITE_TOKEN comes from
 * `vercel env pull`. Signed reads come from the Blob URL stored as storageKey.
 *
 * The @vercel/blob package is the only Vercel import in the tree outside
 * framework config; swapping to R2 means replacing this one file.
 */

export async function putBlob(input: {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
  workspaceId: string;
}): Promise<{ storageKey: string; contentHash: string; sizeBytes: number }> {
  // Private access: reads go through signed URLs, so a storage-key leak is not
  // a document leak. Public was never the intent for owned documents.
  const blob = await put(
    `workspaces/${input.workspaceId}/${crypto.randomUUID()}/${input.filename}`,
    new Blob([new Uint8Array(input.bytes)], { type: input.contentType }),
    { access: "private", addRandomSuffix: false },
  );
  const contentHash = await sha256Hex(input.bytes);
  return { storageKey: blob.url, contentHash, sizeBytes: input.bytes.byteLength };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
