import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureDocuments } from "@/domains/capture/schema";
import { generationJobs } from "@/domains/jobs/schema";
import { documentExtractions, documents, videoTranscripts, youtubeTranscripts } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Value: protects=a YouTube video absorbed cheaply and visibly: captions
 * first, speech only when there are none, the transcript cached by video id so
 * absorbing it again is free, spend recorded on the job, and a failure the
 * notebook can show; fails_when=a video with captions is sent to the paid
 * transcriber, a cached video is fetched again, speech cues lose their place
 * in the video, the spend is not recorded, a failed video leaves no failure
 * on its document, or a captured video is not the capture's child;
 * seam=queueYouTubeCapture and the absorption runner against real Postgres
 * with the captions fetch, the audio source and Groq stubbed; no_claim=the
 * real YouTube and Groq (measured by hand, see the PR), the extraction pass.
 */

const handle = makeTestDb();
vi.mock("@/domains/jobs/kick", () => ({ kickGenerationJob: vi.fn() }));
// Extraction is its own path with its own suites; here it only has to be called.
const extractDocument = vi.fn(async () => ({ ok: true }));
vi.mock("@/domains/knowledge/extraction", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domains/knowledge/extraction")>()),
  extractDocument: (...args: unknown[]) => extractDocument(...(args as [])),
}));

afterAll(async () => {
  await handle.client.end();
});

beforeEach(() => {
  extractDocument.mockClear();
  vi.stubEnv("GROQ_API_KEY", "test-key");
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
        eq(generationJobs.subject, `document:${queued.documentId}`),
      ),
    )
    // The newest: a capture's video gets a job of its own beside the plain one.
    .orderBy(desc(generationJobs.createdAt));
  await runGenerationJob({ jobId: job.id, attempt: job.attempt }, { "knowledge.youtube": youtubeAbsorbRunner(deps) });
  const [settled] = await handle.db.select().from(generationJobs).where(eq(generationJobs.id, job.id));
  return { documentId: queued.documentId, job: settled };
}

describe("YouTube absorption (real Postgres, stubbed providers)", () => {
  it("reads the captions, files them as the document's text with cues, and caches them by video id", async () => {
    const auth = await signIn("captions");
    const videoId = randomVideoId();
    const transcribeClip = vi.fn();
    const { documentId, job } = await absorb(auth, videoId, { fetchCaptions: captions(videoId), transcribeClip });

    expect(job).toMatchObject({
      status: "ready",
      costMicroUsd: 0,
      result: { href: `/polymath/knowledge?doc=${documentId}`, notice: "Read from the video's captions (short)." },
    });
    expect(transcribeClip).not.toHaveBeenCalled();
    const [doc] = await handle.db.select().from(documents).where(eq(documents.id, documentId));
    expect(doc).toMatchObject({ title: "A talk", sourceUrl: `https://www.youtube.com/watch?v=${videoId}` });
    expect(doc.fileId).not.toBeNull();
    const [cues] = await handle.db
      .select()
      .from(youtubeTranscripts)
      .where(eq(youtubeTranscripts.documentId, documentId));
    expect(cues).toMatchObject({ videoId, language: "en", generated: false });
    const [cached] = await handle.db.select().from(videoTranscripts).where(eq(videoTranscripts.videoId, videoId));
    expect(cached).toMatchObject({ source: "captions", costMicroUsd: 0 });
    expect(extractDocument).toHaveBeenCalledWith(auth, { documentId });
  });

  it("absorbs a cached video in another workspace without fetching anything", async () => {
    const videoId = randomVideoId();
    await absorb(await signIn("first"), videoId, { fetchCaptions: captions(videoId) });
    const fetchCaptions = vi.fn();
    const { job } = await absorb(await signIn("second"), videoId, { fetchCaptions });
    expect(fetchCaptions).not.toHaveBeenCalled();
    expect(job).toMatchObject({ status: "ready", result: { notice: "Used the saved transcript (short)." } });
  });

  it("transcribes the speech in clips when there are no captions, on the video's own clock, and records the spend", async () => {
    const auth = await signIn("speech");
    const videoId = randomVideoId();
    const clips: Array<{ from: number; to: number }> = [];
    const audio = {
      durationSeconds: vi.fn(async () => 50 * 60),
      clip: vi.fn(async (_id: string, range: { from: number; to: number }) => {
        clips.push(range);
        return { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/mp4", filename: "clip.m4a" };
      }),
    };
    const transcribeClip = vi.fn(async () => ({
      segments: [{ start: 1.5, end: 4, text: "Words." }],
      durationSeconds: 1200,
      costMicroUsd: 13_334,
    }));
    const { documentId, job } = await absorb(auth, videoId, { fetchCaptions: noCaptions, audio, transcribeClip });

    expect(clips).toEqual([
      { from: 0, to: 1200 },
      { from: 1200, to: 2400 },
      { from: 2400, to: 3000 },
    ]);
    expect(job).toMatchObject({ status: "ready", costMicroUsd: 40_002 });
    const [cues] = await handle.db
      .select()
      .from(youtubeTranscripts)
      .where(eq(youtubeTranscripts.documentId, documentId));
    expect((cues.cues as Array<{ start: number }>).map((cue) => cue.start)).toEqual([1.5, 1201.5, 2401.5]);
    const [cached] = await handle.db.select().from(videoTranscripts).where(eq(videoTranscripts.videoId, videoId));
    expect(cached).toMatchObject({ source: "speech", costMicroUsd: 40_002, generated: true });
  });

  it("fails with a reason, recorded on the document, when a video has no captions and no audio can be had", async () => {
    const auth = await signIn("noaudio");
    const videoId = randomVideoId();
    const { documentId, job } = await absorb(auth, videoId, { fetchCaptions: noCaptions, audio: null });
    expect(job).toMatchObject({
      status: "failed",
      error: "This video has no captions, and transcribing speech is not set up here.",
    });
    const [failure] = await handle.db
      .select()
      .from(documentExtractions)
      .where(eq(documentExtractions.documentId, documentId));
    expect(failure).toMatchObject({ status: "failed", extractor: "youtube-transcript" });
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
