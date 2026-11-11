import { and, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { documents } from "@/domains/knowledge/schema";
import { db } from "@/lib/db";
import { ConflictError, convertCaptureToDocument, StaleWriteError } from "./commands";
import { workingText } from "./mode";
import { captures } from "./schema";

/** What a converted capture became, in words, for the refusal below. */
const CONVERTED_NOUN: Record<string, string> = { task: "a task", note: "a note" };

/**
 * Whether a capture can be a flashcard or quiz source, without filing it:
 * the library document it already resolves to, or null when it is open and
 * documentForCapture would file it. Throws the refusal documentForCapture
 * would throw, so a request can check every source before filing any.
 *
 * - Already filed as a document: that document, whatever the caller's version.
 * - Its URL already in the library (the same article captured twice): the
 *   library's document; the capture stays open, as Save to library leaves it.
 * - Turned into a task, note or draft: refused with a ConflictError.
 * - Open: refused when the caller's version is stale or it has no text to file.
 */
export async function checkCaptureSource(
  auth: AuthContext,
  input: { captureId: string; expectedVersion: number },
): Promise<{ documentId: string | null }> {
  const [capture] = await db
    .select({
      processingState: captures.processingState,
      convertedType: captures.convertedType,
      convertedId: captures.convertedId,
      url: captures.url,
      version: captures.version,
      captureMode: captures.captureMode,
      text: captures.text,
      fetchedText: captures.fetchedText,
    })
    .from(captures)
    .where(and(eq(captures.workspaceId, auth.workspaceId), eq(captures.id, input.captureId)))
    .limit(1);
  if (!capture) throw new StaleWriteError("That capture no longer exists. Reload the inbox.");
  if (capture.processingState === "converted") {
    if (capture.convertedType === "document" && capture.convertedId) return { documentId: capture.convertedId };
    const noun = CONVERTED_NOUN[capture.convertedType ?? ""] ?? "a draft";
    throw new ConflictError(`That capture became ${noun}, so it cannot be a source.`);
  }
  const filed = capture.url ? await documentForUrl(auth, capture.url) : null;
  if (filed) return { documentId: filed };
  if (capture.version !== input.expectedVersion) {
    throw new StaleWriteError("The capture changed since you loaded it. Reload and try again.");
  }
  if (!workingText(capture)?.trim()) throw new ConflictError("That capture has no text to file.");
  return { documentId: null };
}

/**
 * The library document that holds a capture's words, filing the capture
 * first when it is still open (checkCaptureSource names the cases). Learning
 * reads documents, never captures, so this is how an inbox capture becomes a
 * flashcard or quiz source.
 */
export async function documentForCapture(
  auth: AuthContext,
  input: { captureId: string; expectedVersion: number },
): Promise<string> {
  const { documentId } = await checkCaptureSource(auth, input);
  if (documentId) return documentId;
  try {
    const filed = await convertCaptureToDocument(auth, input);
    if (!filed.documentId) throw new ConflictError("That capture could not be filed to the library.");
    return filed.documentId;
  } catch (cause) {
    if (!(cause instanceof ConflictError || cause instanceof StaleWriteError)) throw cause;
    // Another request filed this capture, or the same article, between the check and the insert.
    const raced = await checkCaptureSource(auth, input);
    if (raced.documentId) return raced.documentId;
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
