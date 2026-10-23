"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { captureUrl } from "@/domains/knowledge/capture-url";
import { attachDocuments, DossierError } from "@/domains/knowledge/dossiers";
import { enqueueOutbox } from "@/domains/audit/outbox";
import { queueYouTubeCapture } from "@/domains/knowledge/youtube-capture";
import { documentExtractions, documents } from "@/domains/knowledge/schema";
import { isYouTubeUrl } from "@/integrations/youtube/transcript";
import { getAuthContext, type AuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { withTransaction } from "@/lib/db-transaction";

/*
 * The notebook Sources pane's mutation surface. Three ways in, one per row of
 * the empty state:
 *
 *   - a URL or YouTube link: the capture path the retired Sources page used
 *     (captureUrl inline, YouTube queued), then the document joins the
 *     notebook. A queued video binds by address, so it appears here before the
 *     transcript lands.
 *   - a file upload: POST /api/v1/files runs from the browser (the 4.5 MB
 *     multipart ceiling is Vercel's), and the returned document id attaches.
 *   - a pick from the Document Vault: attachDocuments, which reuses the
 *     already-ingested document.
 *
 * Every failure returns a stated error; nothing throws into the client. The
 * readiness field on each source row is the one state model - this file never
 * stores a status of its own.
 */

const revalidate = (dossierId: string) => revalidatePath(`/alfred/dossiers/${dossierId}/notebook`);

async function authorize(): Promise<AuthContext> {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return auth;
}

export type AddSourceResult = { ok: boolean; message: string };

/** Attach an already-ingested document to the notebook (Document Vault pick, or a finished upload). */
export async function attachToNotebookAction(input: { dossierId: string; documentIds: string[] }): Promise<AddSourceResult> {
  const auth = await authorize();
  const parsed = z
    .object({ dossierId: z.uuid(), documentIds: z.array(z.uuid()).min(1).max(200) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, message: "No document was named." };
  try {
    const { attached } = await attachDocuments(auth, parsed.data);
    revalidate(parsed.data.dossierId);
    return attached > 0
      ? { ok: true, message: attached === 1 ? "1 source added." : `${attached} sources added.` }
      : { ok: true, message: "Already in this notebook." };
  } catch (cause) {
    if (cause instanceof DossierError) return { ok: false, message: cause.message };
    throw cause;
  }
}

/** Capture a pasted link into the notebook: YouTube is queued, any other URL is fetched inline. */
export async function addUrlToNotebookAction(input: { dossierId: string; url: string }): Promise<AddSourceResult> {
  const auth = await authorize();
  const parsed = z
    .object({ dossierId: z.uuid(), url: z.string().trim().min(1).max(2000) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, message: "Paste a link first." };
  const { dossierId, url } = parsed.data;

  if (isYouTubeUrl(url)) {
    const queued = await queueYouTubeCapture(auth, { url });
    if (!queued.ok) return { ok: false, message: queued.error };
    // The video binds to the notebook by address (see dossiers.sourceFor), so
    // it appears in the pane before the transcript lands.
    await attachDocuments(auth, { dossierId, documentIds: [queued.documentId] });
    revalidate(dossierId);
    return { ok: true, message: queued.enqueued ? "Video queued. It reads the transcript next." : "That video is already filed." };
  }

  const captured = await captureUrl(auth, { url });
  // A fetch failure with a document row leaves the row in place in Failed
  // state, retryable from there; a failure with no row never became anything,
  // so its reason is the whole answer.
  if (captured.documentId) {
    try {
      await attachDocuments(auth, { dossierId, documentIds: [captured.documentId] });
    } catch (cause) {
      if (cause instanceof DossierError) return { ok: false, message: cause.message };
      throw cause;
    }
  }
  revalidate(dossierId);
  if (!captured.ok) return { ok: false, message: captured.error };
  return { ok: true, message: "Source captured. Reading it now." };
}

/** Re-runs a source's ingest from where it stopped. Same topic the inbox retry uses. */
export async function retryNotebookSourceAction(input: { dossierId: string; documentId: string }): Promise<AddSourceResult> {
  const auth = await authorize();
  const parsed = z
    .object({ dossierId: z.uuid(), documentId: z.uuid() })
    .safeParse(input);
  if (!parsed.success) return { ok: false, message: "That source id is not valid." };
  const { dossierId, documentId } = parsed.data;

  // The row must be this workspace's, or the retry would mint doomed work for
  // a document that can never be seen here.
  const [doc] = await db
    .select({ id: documents.id, fileId: documents.fileId, sourceUrl: documents.sourceUrl })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!doc) return { ok: false, message: "That source is not in this notebook." };

  // Branch on why it failed. A fetch-class failure (a URL capture whose fetch
  // never produced bytes, a video whose transcript fetch failed) left no file,
  // so re-queueing extraction could never succeed — re-run the capture
  // instead. A document with bytes retries its extraction. A skipped row has
  // no reader at all, so there is genuinely nothing to retry.
  const latest = await db
    .select({ status: documentExtractions.status, extractor: documentExtractions.extractor })
    .from(documentExtractions)
    .where(and(eq(documentExtractions.workspaceId, auth.workspaceId), eq(documentExtractions.documentId, documentId)))
    .orderBy(desc(documentExtractions.createdAt))
    .limit(1);
  const failure = latest[0] ?? null;
  const isFetchClass = !doc.fileId || failure?.extractor === "url-fetch" || failure?.extractor === "youtube-transcript";
  if (failure?.status === "skipped" && !isFetchClass) {
    return { ok: false, message: "No reader accepts this source type. There is nothing to retry." };
  }

  if (isFetchClass) {
    if (!doc.sourceUrl) return { ok: false, message: "This source has no address to fetch again. Add it as a file instead." };
    const isVideo = isYouTubeUrl(doc.sourceUrl);
    if (isVideo) {
      const queued = await queueYouTubeCapture(auth, { url: doc.sourceUrl });
      if (!queued.ok) return { ok: false, message: queued.error };
    } else {
      const captured = await captureUrl(auth, { url: doc.sourceUrl });
      if (!captured.ok) return { ok: false, message: captured.error };
    }
    revalidate(dossierId);
    return { ok: true, message: "Fetching the source again." };
  }

  await withTransaction(async (tx) => {
    // One queued attempt per document: a second click joins the first instead
    // of minting another doomed row (the dispatch key is the dedupe).
    await enqueueOutbox(tx, auth, {
      topic: "document.extraction_requested",
      payload: { documentId },
      dispatchKey: `retry:${auth.workspaceId}:${documentId}`,
    });
  });
  revalidate(dossierId);
  return { ok: true, message: "Queued for another attempt." };
}
