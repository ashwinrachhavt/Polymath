import { and, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { submitOrRetryGenerationJob } from "@/domains/jobs/commands";
import { kickGenerationJob } from "@/domains/jobs/kick";
import { canonicalVideoUrl, parseVideoId } from "@/integrations/youtube/transcript";
import { withTransaction } from "@/lib/db-transaction";
import { documents } from "./schema";
import { YOUTUBE_ABSORB_KIND, type YouTubeAbsorbInput } from "./youtube-absorb";

/*
 * Starting a YouTube capture. Nothing is fetched here: the transcript and its
 * extraction are long work, and long work never lives inside a request. This
 * writes the document row (so the source is visible immediately) and submits
 * the video's absorption job (youtube-absorb.ts), which the person watches in
 * the jobs panel. Asking again for a video whose job failed or was stopped
 * tries it again; asking for one already absorbed starts nothing.
 *
 * The stored URL is always canonical, because canonicalCaptureUrl does not strip
 * YouTube's si/t/feature/list parameters: youtu.be/ID?si=x and
 * youtube.com/watch?v=ID would otherwise become two documents.
 */

export type QueueVideoResult =
  { ok: true; documentId: string; created: boolean; enqueued: boolean } | { ok: false; error: string };

export async function queueYouTubeCapture(
  auth: AuthContext,
  input: { url: string; captureId?: string },
): Promise<QueueVideoResult> {
  const videoId = parseVideoId(input.url);
  if (!videoId) return { ok: false, error: "That is not a YouTube video address." };
  const sourceUrl = canonicalVideoUrl(videoId);

  const filed = await withTransaction(async (tx) => {
    const find = async () =>
      (
        await tx
          .select({ id: documents.id, fileId: documents.fileId })
          .from(documents)
          .where(and(eq(documents.workspaceId, auth.workspaceId), eq(documents.sourceUrl, sourceUrl)))
          .limit(1)
      )[0];
    const existing = await find();
    if (existing) return { ...existing, created: false };
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
      .returning({ id: documents.id, fileId: documents.fileId });
    // A concurrent paste won the unique index; join its row.
    return inserted ? { ...inserted, created: true } : { ...(await find()), created: false };
  });
  if (!filed.id) return { ok: false, error: "The video could not be filed." };

  // A video whose text is already filed has nothing to fetch; a capture still gets it as its child.
  if (filed.fileId && !input.captureId) return { ok: true, documentId: filed.id, created: false, enqueued: false };

  const jobInput: YouTubeAbsorbInput = {
    documentId: filed.id,
    videoId,
    ...(input.captureId ? { captureId: input.captureId } : {}),
  };
  const { started } = await submitOrRetryGenerationJob(auth, {
    kind: YOUTUBE_ABSORB_KIND,
    // A captured video shows on its capture's row; a notebook's on its source row.
    subject: input.captureId ? `capture:${input.captureId}` : `document:${filed.id}`,
    idempotencyKey: input.captureId ? `youtube:${filed.id}:capture:${input.captureId}` : `youtube:${filed.id}`,
    title: "Absorbing a YouTube video",
    input: jobInput,
  });
  if (started) kickGenerationJob(started);
  return { ok: true, documentId: filed.id, created: filed.created, enqueued: started !== null };
}
