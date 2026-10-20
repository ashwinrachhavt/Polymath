import { and, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { validateFile } from "@/lib/file-validation";
import { sha256Hex } from "@/lib/hash";
import { MAX_UPLOAD_BYTES, type FileValidationResult } from "@/lib/file-validation";
import { canonicalCaptureUrl, parseCaptureUrl, safeFetch, type SafeFetchOptions } from "@/lib/safe-fetch";
import { extractDocument, type ExtractDocumentResult } from "./extraction";
import { extractPageText, isHtmlDocument } from "./html-to-text";
import { DocumentAlreadyHasFileError, intakeFile } from "./intake";
import { documentExtractions, documents } from "./schema";
import { recordSource } from "./sources";

/*
 * URL capture is the file upload with a different source. The document row is
 * written first with its `sourceUrl`, so a URL is one document per workspace
 * from the first click. The bytes then go through intakeFile (the same path as
 * an upload) and the existing extract + proposal pass. There is no second
 * ingest API.
 *
 * HTML pages are reduced to their reading text at the boundary and stored
 * as markdown; the extraction pass then reads the text directly.
 *
 * A fetch that fails leaves the document without a file or a type, with the
 * reason on an extraction row, so the inbox says "Could not read" instead of
 * showing an empty Filed document. Pasting the URL again retries the fetch on
 * the same document.
 */

export type CaptureUrlResult =
  | { ok: true; documentId: string; created: boolean; extraction: ExtractDocumentResult }
  | { ok: false; documentId: string | null; error: string };

/** The extraction row for a fetch that never produced bytes has no content hash; this stands in. */
async function unfetchedHash(url: string): Promise<string> {
  return `unfetched:${await sha256Hex(url)}`;
}

function titleFor(url: URL): string {
  const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
  const name = last.replace(/\.[^.]+$/, "");
  return (name || url.hostname).slice(0, 200);
}

async function recordFetchFailure(
  auth: AuthContext,
  documentId: string,
  url: string,
  error: string,
): Promise<void> {
  const contentHash = await unfetchedHash(url);
  await db
    .insert(documentExtractions)
    .values({ workspaceId: auth.workspaceId, documentId, contentHash, status: "failed", error, extractor: "url-fetch" })
    .onConflictDoUpdate({
      target: [documentExtractions.documentId, documentExtractions.contentHash],
      set: { error, createdAt: new Date() },
    });
}

type IntakeAttachment = {
  bytes: Uint8Array;
  filename: string;
  title: string;
  verdict: FileValidationResult;
  sourceUrl: string;
  documentId: string;
  /** A reduced HTML page is a web source; an attached binary is a document source. */
  sourceKind: "web" | "document";
};

/** The one attach step both content kinds share; a concurrent paste's win is not an error. */
async function attachIntake(
  auth: AuthContext,
  input: IntakeAttachment,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const contentHash = await sha256Hex(input.bytes);
  try {
    await intakeFile(auth, {
      ...input,
      contentHash,
      origin: "url",
      inTransaction: (tx) =>
        recordSource(auth, tx, {
          title: input.title,
          url: input.sourceUrl,
          contentHash,
          kind: input.sourceKind,
        }),
    });
    return { ok: true };
  } catch (cause) {
    // A concurrent paste attached its bytes first; this call joins its result.
    if (cause instanceof DocumentAlreadyHasFileError) return { ok: true };
    throw cause;
  }
}

export async function captureUrl(
  auth: AuthContext,
  input: { url: string; fetchOptions?: SafeFetchOptions },
): Promise<CaptureUrlResult> {
  const parsed = parseCaptureUrl(input.url, input.fetchOptions?.allowPrivateAddresses);
  if (!parsed.ok) return { ok: false, documentId: null, error: parsed.error };
  const sourceUrl = canonicalCaptureUrl(parsed.url);

  const inWorkspace = and(eq(documents.workspaceId, auth.workspaceId), eq(documents.sourceUrl, sourceUrl));
  const find = async () => {
    const [row] = await db
      .select({ id: documents.id, fileId: documents.fileId })
      .from(documents)
      .where(inWorkspace)
      .limit(1);
    return row;
  };

  let existing = await find();
  let created = false;
  if (!existing) {
    // The partial unique index decides a race; the loser reads the winner's row.
    const [inserted] = await db
      .insert(documents)
      .values({
        workspaceId: auth.workspaceId,
        title: titleFor(parsed.url),
        sourceUrl,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .onConflictDoNothing()
      .returning({ id: documents.id, fileId: documents.fileId });
    created = Boolean(inserted);
    existing = inserted ?? (await find());
  }
  if (!existing) return { ok: false, documentId: null, error: "The document could not be created." };
  const documentId = existing.id;

  // Already fetched: return the same document, and let extraction dedupe or retry.
  if (existing.fileId) {
    return { ok: true, documentId, created: false, extraction: await extractDocument(auth, { documentId }) };
  }

  const fetched = await safeFetch(sourceUrl, input.fetchOptions);
  if (!fetched.ok) {
    await recordFetchFailure(auth, documentId, sourceUrl, fetched.error);
    return { ok: false, documentId, error: fetched.error };
  }
  // A web page is captured as its reading text: HTML in, markdown bytes out,
  // so every page extracts without a parsing provider.
  if (isHtmlDocument(fetched.contentType, fetched.bytes)) {
    const page = extractPageText(new TextDecoder("utf-8").decode(fetched.bytes));
    if (!page.text) {
      const error = "The page had no readable text to capture.";
      await recordFetchFailure(auth, documentId, sourceUrl, error);
      return { ok: false, documentId, error };
    }
    const pageBytes = new TextEncoder().encode(page.text);
    if (pageBytes.byteLength > MAX_UPLOAD_BYTES) {
      const error = "That page is larger than the 4 MB limit once reduced to text.";
      await recordFetchFailure(auth, documentId, sourceUrl, error);
      return { ok: false, documentId, error };
    }
    const attached = await attachIntake(auth, {
      bytes: pageBytes,
      filename: `${titleFor(parsed.url)}.md`,
      title: (page.title ?? titleFor(parsed.url)).slice(0, 200),
      verdict: { ok: true, mimeType: "text/markdown" },
      sourceUrl,
      documentId,
      sourceKind: "web",
    });
    if (!attached.ok) return { ok: false, documentId, error: attached.error };
    return { ok: true, documentId, created, extraction: await extractDocument(auth, { documentId }) };
  }

  const verdict = validateFile(fetched.bytes);
  if (!verdict.ok) {
    const error = verdict.reason === "unidentified"
      ? "That address is not a PDF, an image, or a web page, which are the types Polymath can read today."
      : verdict.reason === "empty_file" ? "The address returned an empty file." : "That file is larger than the 4 MB limit.";
    await recordFetchFailure(auth, documentId, sourceUrl, error);
    return { ok: false, documentId, error };
  }

  const attached = await attachIntake(auth, {
    bytes: fetched.bytes,
    filename: titleFor(parsed.url) + (verdict.mimeType === "application/pdf" ? ".pdf" : ""),
    title: titleFor(parsed.url),
    verdict,
    sourceUrl,
    documentId,
    sourceKind: "document",
  });
  if (!attached.ok) return { ok: false, documentId, error: attached.error };
  return { ok: true, documentId, created, extraction: await extractDocument(auth, { documentId }) };
}
