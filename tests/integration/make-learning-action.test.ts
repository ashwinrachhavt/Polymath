import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captures } from "@/domains/capture/schema";
import { generationJobs } from "@/domains/jobs/schema";
import { documents } from "@/domains/knowledge/schema";
import { MAX_LEARNING_SOURCES } from "@/domains/learning/item-count";
import { quizzes } from "@/domains/learning/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Making flashcards or a quiz from picked sources files each picked inbox
 * capture to the library, which takes it out of the inbox for good. So the
 * whole request is checked before any capture is filed: a bad source later
 * in the list must leave the earlier captures where they were.
 *
 * Value: protects=the inbox from half-filed requests that made nothing;
 * fails_when=a capture is filed before a later source is refused, a request
 * of more distinct sources than the cap files anything, a role rejection is
 * thrown to the client instead of returned, the verb waits for generation
 * instead of handing it over, or a repeated click starts the work twice; seam=the server action against
 * a real database with auth stubbed; no_claim=generation itself
 * (flashcards-batching, quiz suites).
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
type Auth = { userId: string; workspaceId: string; role: "owner" | "member" | "viewer" };
const authHolder: { ctx: Auth | undefined } = { ctx: undefined };
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthContext: vi.fn(async () => authHolder.ctx) }));
const kick = vi.hoisted(() => ({ kickGenerationJob: vi.fn() }));
vi.mock("@/domains/jobs/kick", () => kick);
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

import { createCapture } from "@/domains/capture/commands";
import { findLearningSourcesAction, makeFlashcardsOrQuizAction } from "@/app/(workspace)/learn/make-actions";

beforeAll(() => {
  holder.db = handle?.db;
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await handle?.client.end();
});

async function signIn(label: string) {
  const { userId, workspaceId } = await seedWorkspace(holder.db!, `mla-${label}-${Date.now()}`);
  const auth: Auth = ownerAuth(userId, workspaceId);
  authHolder.ctx = auth;
  return auth;
}

async function textCapture(auth: Auth, text: string) {
  const capture = await createCapture(auth, { text });
  return { type: "capture" as const, id: capture.id, version: capture.version };
}

async function openCaptures(workspaceId: string) {
  return (
    await holder
      .db!.select({ state: captures.processingState })
      .from(captures)
      .where(eq(captures.workspaceId, workspaceId))
  ).filter((row) => row.state !== "converted").length;
}

async function documentCount(workspaceId: string) {
  return (await holder.db!.select({ id: documents.id }).from(documents).where(eq(documents.workspaceId, workspaceId)))
    .length;
}

suite("makeFlashcardsOrQuizAction", () => {
  it("files no capture when a later capture has no text to file", async () => {
    const auth = await signIn("notext");
    const good = await textCapture(auth, "Spaced repetition beats cramming.");
    const empty = await textCapture(auth, "A capture whose words are cleared below.");
    await holder.db!.update(captures).set({ text: "   " }).where(eq(captures.id, empty.id));

    const result = await makeFlashcardsOrQuizAction({
      kind: "flashcards",
      sources: [good, empty],
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result).toEqual({ ok: false, error: "That capture has no text to file.", failedSourceId: empty.id });
    expect(await openCaptures(auth.workspaceId)).toBe(2);
    expect(await documentCount(auth.workspaceId)).toBe(0);
  });

  it("files no capture when a picked document is not in the workspace", async () => {
    const auth = await signIn("nodoc");
    const good = await textCapture(auth, "Interleaving mixes problem types.");

    const result = await makeFlashcardsOrQuizAction({
      kind: "quiz",
      sources: [good, { type: "document", id: crypto.randomUUID() }],
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.ok).toBe(false);
    expect(await openCaptures(auth.workspaceId)).toBe(1);
    expect(await documentCount(auth.workspaceId)).toBe(0);
  });

  it("refuses more than the cap of distinct sources before filing any", async () => {
    const auth = await signIn("many");
    const sources = [];
    const over = MAX_LEARNING_SOURCES + 1;
    for (let i = 0; i < over; i++) sources.push(await textCapture(auth, `Fact number ${i} stands on its own.`));

    const result = await makeFlashcardsOrQuizAction({
      kind: "flashcards",
      sources,
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result).toEqual({
      ok: false,
      error: `One request reads up to ${MAX_LEARNING_SOURCES} sources, and these are ${over}. Remove 1 and try again.`,
    });
    expect(await openCaptures(auth.workspaceId)).toBe(over);
  });

  it("offers only captures with text to file in the source picker", async () => {
    const auth = await signIn("picker");
    const good = await textCapture(auth, "Retrieval practice strengthens memory.");
    const empty = await textCapture(auth, "Cleared below.");
    await holder.db!.update(captures).set({ text: "\n  " }).where(eq(captures.id, empty.id));

    const found = await findLearningSourcesAction({ query: "" });

    expect(found.ok && found.captures.map((source) => source.id)).toEqual([good.id]);
  });

  it("hands the work over as one queued job and starts it once, however often the request repeats", async () => {
    const auth = await signIn("accept");
    const source = await textCapture(auth, "Spaced repetition beats cramming. Retrieval practice strengthens memory.");
    const idempotencyKey = crypto.randomUUID();
    kick.kickGenerationJob.mockClear();

    const first = await makeFlashcardsOrQuizAction({ kind: "quiz", sources: [source], count: 5, idempotencyKey });
    // The capture was filed by the first request; the dialog's replay still names it as it was picked.
    const [document] = await holder
      .db!.select({ id: documents.id })
      .from(documents)
      .where(eq(documents.workspaceId, auth.workspaceId));
    const replay = await makeFlashcardsOrQuizAction({
      kind: "quiz",
      sources: [{ type: "document", id: document.id }],
      count: 5,
      idempotencyKey,
    });

    if (!first.ok || !replay.ok) throw new Error("expected both requests to be accepted");
    expect(first.job).toMatchObject({ kind: "learning.quiz", status: "queued", href: null });
    expect(first.job.title).toMatch(/^Quiz: /);
    expect(replay.job.id).toBe(first.job.id);
    expect(kick.kickGenerationJob).toHaveBeenCalledTimes(1);
    expect(kick.kickGenerationJob).toHaveBeenCalledWith({ jobId: first.job.id, attempt: 1 });
    const jobs = await holder.db!.select().from(generationJobs).where(eq(generationJobs.workspaceId, auth.workspaceId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].input).toEqual({ documentIds: [document.id], count: 5 });
    expect(await holder.db!.select().from(quizzes).where(eq(quizzes.workspaceId, auth.workspaceId))).toEqual([]);
  });

  it("returns a role rejection instead of throwing it", async () => {
    const auth = await signIn("viewer");
    authHolder.ctx = { ...auth, role: "viewer" };

    const made = await makeFlashcardsOrQuizAction({
      kind: "quiz",
      sources: [{ type: "document", id: crypto.randomUUID() }],
      idempotencyKey: crypto.randomUUID(),
    });
    const found = await findLearningSourcesAction({ query: "" });

    expect(made).toEqual({ ok: false, error: expect.stringMatching(/member/i) });
    expect(found).toEqual({ ok: false, error: expect.stringMatching(/member/i) });
  });
});
