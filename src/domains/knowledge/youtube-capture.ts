import { and, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { enqueueOutbox } from "@/domains/audit/outbox";
import { withTransaction } from "@/lib/db-transaction";
import { canonicalVideoUrl, parseVideoId } from "@/integrations/youtube/transcript";
import { documents } from "./schema";

/*
 * Starting a YouTube capture. Nothing is fetched here: a transcript fetch plus
 * extraction is long work, and the rule is that long work never lives inside a
 * request. This writes the document row (so the source is visible immediately)
 * and queues `youtube.transcript_requested` in the same transaction. The outbox
 * handler does the fetch, files the text, writes the cues and runs the normal
 * extraction pass.
 *
 * The stored URL is always canonical, because canonicalCaptureUrl does not strip
 * YouTube's si/t/feature/list parameters: youtu.be/ID?si=x and
 * youtube.com/watch?v=ID would otherwise become two documents.
 */

export const YOUTUBE_TOPIC = "youtube.transcript_requested";

export type QueueVideoResult =
  | { ok: true; documentId: string; created: boolean; enqueued: boolean }
  | { ok: false; error: string };

export async function queueYouTubeCapture(auth: AuthContext, input: { url: string }): Promise<QueueVideoResult> {
  const videoId = parseVideoId(input.url);
  if (!videoId) return { ok: false, error: "That is not a YouTube video address." };
  const sourceUrl = canonicalVideoUrl(videoId);

  return withTransaction(async (tx) => {
    const [existing] = await tx
      .select({ id: documents.id, fileId: documents.fileId })
      .from(documents)
      .where(and(eq(documents.workspaceId, auth.workspaceId), eq(documents.sourceUrl, sourceUrl)))
      .limit(1);

    let documentId = existing?.id;
    let created = false;
    if (!documentId) {
      const [inserted] = await tx
        .insert(documents)
        .values({
          workspaceId: auth.workspaceId,
          title: `YouTube video ${videoId}`,
          sourceUrl,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        })
        .onConflictDoNothing()
        .returning({ id: documents.id });
      documentId = inserted?.id;
      created = Boolean(inserted);
      if (!documentId) {
        // A concurrent paste won the unique index; join its row.
        const [raced] = await tx
          .select({ id: documents.id, fileId: documents.fileId })
          .from(documents)
          .where(and(eq(documents.workspaceId, auth.workspaceId), eq(documents.sourceUrl, sourceUrl)))
          .limit(1);
        documentId = raced?.id;
        if (raced?.fileId) return { ok: true, documentId: raced.id, created: false, enqueued: false };
      }
    }

    if (!documentId) return { ok: false, error: "The video could not be filed." };

    // Re-pasting a video that already has its text retries extraction instead of
    // re-fetching the transcript: the bytes are already durable.
    const [current] = await tx
      .select({ fileId: documents.fileId })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (current?.fileId) return { ok: true, documentId, created: false, enqueued: false };

    const queued = await enqueueOutbox(tx, auth, {
      topic: YOUTUBE_TOPIC,
      payload: { documentId, videoId, sourceUrl },
      // One queued fetch per video: a second paste joins the first job.
      dispatchKey: `youtube:${auth.workspaceId}:${videoId}`,
    });
    return { ok: true, documentId, created, enqueued: queued.enqueued };
  });
}
