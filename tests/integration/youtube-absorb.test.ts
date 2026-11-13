import { and, desc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { outboxEvents } from "@/domains/audit/schema";
import { captureDocuments } from "@/domains/capture/schema";
import { generationJobs } from "@/domains/jobs/schema";
import { documentExtractions, documents, videoTranscripts, youtubeTranscripts } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Value: protects=a YouTube video absorbed fast and visibly: captions read
 * once and cached by video id so absorbing it again is instant, a video with
 * no captions skipped with that said plainly, and a failed fetch retryable;
 * fails_when=a cached video is fetched again, the transcript is not filed with
 * its cues, a video with no captions fails instead of being skipped or leaves
 * no note on its document, a failed video cannot be tried again, or a captured
 * video is not shown on, and linked to, its capture; seam=queueYouTubeCapture
 * and the absorption runner against real Postgres with the captions fetch
 * stubbed; no_claim=the real YouTube (measured by hand, see the PR) and the
 * extraction pass.
 */

const handle = makeTestDb();
vi.mock("@/domains/jobs/kick", () => ({ kickGenerationJob: vi.fn() }));

afterAll(async () => {
  await handle.client.end();
});

const randomVideoId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 11);

async function signIn(label: string) {
  const seeded = await seedWorkspace(handle.db, `yt-${label}-${Date.now()}`);
  return ownerAuth(seeded.userId, seeded.workspaceId);
}

const captions = (videoId: string) => async () => ({
  ok: true as const,
  videoId,
  canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  title: "A talk",
  cues: [
    { start: 0, duration: 2, text: "Hello there." },
    { start: 2, duration: 3, text: "Today, transformers." },
  ],
  text: "Hello there.\nToday, transformers.",
  language: "en",
  generated: false,
});
const noCaptions = async () => ({ ok: false as const, error: "This video has no captions available." });

async function absorb(
  auth: Awaited<ReturnType<typeof signIn>>,
  videoId: string,
  deps: import("@/domains/knowledge/youtube-absorb").YouTubeAbsorbDeps,
  captureId?: string,
) {
  const { queueYouTubeCapture } = await import("@/domains/knowledge/youtube-capture");
  const { youtubeAbsorbRunner } = await import("@/domains/knowledge/youtube-absorb");
  const { runGenerationJob } = await import("@/domains/jobs/commands");
  const queued = await queueYouTubeCapture(auth, { url: `https://youtu.be/${videoId}?si=x`, captureId });
  if (!queued.ok) throw new Error(queued.error);
  const [job] = await handle.db
    .select()
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.workspaceId, auth.workspaceId),
        eq(generationJobs.subject, captureId ? `capture:${captureId}` : `document:${queued.documentId}`),
      ),
    )
    .orderBy(desc(generationJobs.createdAt));
  await runGenerationJob({ jobId: job.id, attempt: job.attempt }, { "knowledge.youtube": youtubeAbsorbRunner(deps) });
  const [settled] = await handle.db.select().from(generationJobs).where(eq(generationJobs.id, job.id));
  return { documentId: queued.documentId, job: settled };
}

describe("YouTube absorption (real Postgres, stubbed providers)", () => {
  it("reads the captions, files them as the document's text with cues, and caches them by video id", async () => {
    const auth = await signIn("captions");
    const videoId = randomVideoId();
    const { documentId, job } = await absorb(auth, videoId, { fetchCaptions: captions(videoId) });

    expect(job).toMatchObject({
      status: "ready",
      result: { href: `/polymath/knowledge?doc=${documentId}`, notice: "Read from the video's captions (short)." },
    });
    const [doc] = await handle.db.select().from(documents).where(eq(documents.id, documentId));
    expect(doc).toMatchObject({ title: "A talk", sourceUrl: `https://www.youtube.com/watch?v=${videoId}` });
    expect(doc.fileId).not.toBeNull();
    const [cues] = await handle.db
      .select()
      .from(youtubeTranscripts)
      .where(eq(youtubeTranscripts.documentId, documentId));
    expect(cues).toMatchObject({ videoId, language: "en", generated: false });
    const [cached] = await handle.db.select().from(videoTranscripts).where(eq(videoTranscripts.videoId, videoId));
    expect(cached).toMatchObject({ language: "en", generated: false });
    // Extraction is the document pipeline's own queued work, not the job's.
    const queued = await handle.db.select().from(outboxEvents).where(eq(outboxEvents.workspaceId, auth.workspaceId));
    expect(queued.filter((event) => event.topic === "document.extraction_requested")).toHaveLength(1);
  });

  it("absorbs a cached video in another workspace without fetching anything", async () => {
    const videoId = randomVideoId();
    await absorb(await signIn("first"), videoId, { fetchCaptions: captions(videoId) });
    const fetchCaptions = vi.fn();
    const { job } = await absorb(await signIn("second"), videoId, { fetchCaptions });
    expect(fetchCaptions).not.toHaveBeenCalled();
    expect(job).toMatchObject({ status: "ready", result: { notice: "Used the saved transcript (short)." } });
  });

  it("skips a video with no captions, says so on the job and its document, and does not cache a transcript", async () => {
    const auth = await signIn("nocaptions");
    const videoId = randomVideoId();
    const { documentId, job } = await absorb(auth, videoId, { fetchCaptions: noCaptions });
    expect(job).toMatchObject({
      status: "ready",
      result: { href: `/polymath/knowledge?doc=${documentId}`, notice: "No captions, so this video was skipped." },
    });
    const [note] = await handle.db
      .select()
      .from(documentExtractions)
      .where(eq(documentExtractions.documentId, documentId));
    expect(note).toMatchObject({
      status: "failed",
      extractor: "youtube-transcript",
      error: "No captions, so this video was skipped.",
    });
    expect(await handle.db.select().from(videoTranscripts).where(eq(videoTranscripts.videoId, videoId))).toEqual([]);
  });

  it("tries a failed video again when it is asked for again, and links a captured video to its capture", async () => {
    const { createCapture } = await import("@/domains/capture/commands");
    const auth = await signIn("again");
    const videoId = randomVideoId();
    const first = await absorb(auth, videoId, {
      fetchCaptions: async () => ({ ok: false, error: "YouTube could not be reached." }),
    });
    expect(first.job.status).toBe("failed");
    const again = await absorb(auth, videoId, { fetchCaptions: captions(videoId) });
    expect(again.job).toMatchObject({ id: first.job.id, attempt: 2, status: "ready" });

    const capture = await createCapture(auth, { text: `https://www.youtube.com/watch?v=${videoId}` });
    const { documentId, job } = await absorb(auth, videoId, { fetchCaptions: captions(videoId) }, capture.id);
    expect(documentId).toBe(first.documentId);
    expect(job.status).toBe("ready");
    const [child] = await handle.db.select().from(captureDocuments).where(eq(captureDocuments.captureId, capture.id));
    expect(child).toMatchObject({ documentId, position: 0 });
  });
});
