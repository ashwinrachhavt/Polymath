import { and, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { documents } from "@/domains/knowledge/schema";
import { db } from "@/lib/db";
import { ConflictError, convertCaptureToDocument, StaleWriteError } from "./commands";
import { captures } from "./schema";

/** What a converted capture became, in words, for the refusal below. */
const CONVERTED_NOUN: Record<string, string> = { task: "a task", note: "a note" };

/**
 * The library document that holds a capture's words, filing the capture
 * first when it is still open. Learning reads documents, never captures, so
 * this is how an inbox capture becomes a flashcard or quiz source.
 *
 * - Already filed as a document: that document, whatever the caller's version.
 * - Its URL already in the library (the same article captured twice): the
 *   library's document; the capture stays open, as Save to library leaves it.
 * - Open: filed through convertCaptureToDocument, which checks the version.
 * - Turned into a task, note or draft: refused with a ConflictError.
 *
 * Throws convertCaptureToDocument's errors otherwise (stale version, no text).
 */
export async function documentForCapture(
  auth: AuthContext,
  input: { captureId: string; expectedVersion: number },
): Promise<string> {
  const [capture] = await db
    .select({
      processingState: captures.processingState,
      convertedType: captures.convertedType,
      convertedId: captures.convertedId,
      url: captures.url,
    })
    .from(captures)
    .where(and(eq(captures.workspaceId, auth.workspaceId), eq(captures.id, input.captureId)))
    .limit(1);
  if (!capture) throw new StaleWriteError("That capture no longer exists. Reload the inbox.");
  if (capture.processingState === "converted") {
    if (capture.convertedType === "document" && capture.convertedId) return capture.convertedId;
    const noun = CONVERTED_NOUN[capture.convertedType ?? ""] ?? "a draft";
    throw new ConflictError(`That capture became ${noun}, so it cannot be a source.`);
  }

  const filed = capture.url ? await documentForUrl(auth, capture.url) : null;
  if (filed) return filed;
  try {
    const { documentId } = await convertCaptureToDocument(auth, input);
    if (!documentId) throw new ConflictError("That capture could not be filed to the library.");
    return documentId;
  } catch (cause) {
    // Another request filed the same article between the lookup and the insert.
    const raced = cause instanceof ConflictError && capture.url ? await documentForUrl(auth, capture.url) : null;
    if (raced) return raced;
    throw cause;
  }
}

async function documentForUrl(auth: AuthContext, url: string): Promise<string | null> {
  const [row] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.workspaceId, auth.workspaceId), eq(documents.sourceUrl, url)))
    .limit(1);
  return row?.id ?? null;
}
