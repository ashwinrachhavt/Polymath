import { readBlob } from "@/integrations/object-store/object-store";
import { problemResponse } from "@/lib/problems";

/*
 * One blob-serve handler for the private blob store: the workspace check
 * happens in the caller's query (which also decides type, disposition, and
 * name from server-side verdicts - never client claims); this reads the bytes
 * and shapes the response. A read failure is a storage fault, answered as a
 * problem the viewer can surface - not an unhandled 500 (the packet route
 * served raw stack traces before this handler existed). ENOENT means the key
 * is unreachable from this deployment (404); anything else is a read fault
 * (500). nosniff rides every response so the advertised type cannot be
 * second-guessed.
 */

export type ServeBlobInput = {
  storageKey: string;
  /** The served type - the server's stored verdict, never the uploader's claim. */
  contentType: string;
  /** Inline renders (PDF viewer, <img>); attachment forces a download. */
  inline: boolean;
  /** Quotes and backslashes are stripped; they end the disposition parameter. */
  filename: string;
  sizeBytes?: number | null;
  /** The surface's noun for the storage-fault problem text ("capture", "document", "packet"). */
  label: string;
  /** Default "private, max-age=60"; one-off downloads pass "private, no-store". */
  cacheControl?: string;
  /** Per-surface extras (e.g. X-Content-SHA256 on packets). */
  headers?: Record<string, string>;
};

export async function serveBlob(input: ServeBlobInput): Promise<Response> {
  let bytes: Uint8Array;
  try {
    bytes = await readBlob(input.storageKey);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
    return problemResponse(
      missing ? 404 : 500,
      missing ? "file_unavailable" : "file_read_failed",
      missing
        ? `The stored file for this ${input.label} is not reachable from this server.`
        : `The stored file for this ${input.label} could not be read.`,
    );
  }

  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": input.inline ? input.contentType : "application/octet-stream",
      "Content-Length": String(input.sizeBytes ?? bytes.byteLength),
      "Content-Disposition": `${input.inline ? "inline" : "attachment"}; filename="${input.filename.replace(/["\\]/g, "")}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": input.cacheControl ?? "private, max-age=60",
      ...input.headers,
    },
  });
}
