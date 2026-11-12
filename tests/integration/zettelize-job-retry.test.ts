import { GENERATION_ENV_KEYS } from "../helpers/generation-env";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generationJobs } from "@/domains/jobs/schema";
import { captures } from "@/domains/capture/schema";
import { artifacts } from "@/domains/knowledge/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Value: protects=zettelize work surviving a failure without losing the
 * request or doubling the cards; fails_when=a failed pass leaves its job
 * running or vanishes, a retry is not a new attempt, the recovered pass
 * creates the cards more than once, or a second delivery of the same attempt
 * runs the pass again; seam=requestZettelGeneration and the job runner against
 * real Postgres with a scripted extractor; no_claim=the live model.
 */

const handle = makeTestDb();
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
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

import { ZETTELIZE_KIND, requestZettelGeneration, zettelizeRunner } from "@/domains/capture/zettel-generation";
import { retryGenerationJob, runGenerationJob } from "@/domains/jobs/commands";
import type { ZettelExtractor } from "@/integrations/zettels/extractor";

const BODY =
  "Atomic notes compound. A zettel carries one idea, verbatim evidence, and links to its neighbours. Writing them daily turns reading into thinking.";
const Q1 = "A zettel carries one idea, verbatim evidence";

beforeAll(() => {
  holder.db = handle.db;
  // Generation keys unset: the pass under test is the only consumer, and the
  // no-provider path must not take the live-call route.
  for (const key of GENERATION_ENV_KEYS) vi.stubEnv(key, "");
  vi.stubEnv("DOCLING_SERVE_URL", "");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await handle.client.end();
});

describe("zettelize job retry and replay resilience", () => {
  it("a failed pass fails its job, the retry creates the cards once, and a second delivery does nothing", async () => {
    const { userId, workspaceId } = await seedWorkspace(holder.db!, `zretry-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);
    const [capture] = await holder
      .db!.insert(captures)
      .values({
        workspaceId,
        kind: "text",
        captureMode: "authored",
        rawPayload: { text: BODY },
        text: BODY,
        processingState: "unprocessed",
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
    const request = await requestZettelGeneration(auth, { captureIds: [capture.id], idempotencyKey: crypto.randomUUID() });
    const [started] = request.started;
    const job = async () => (await holder.db!.select().from(generationJobs).where(eq(generationJobs.id, started.jobId)))[0];

    // A network drop inside extraction or the model call fails this attempt, visibly.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await runGenerationJob(started, {
      [ZETTELIZE_KIND]: async () => {
        throw new Error("provider connection reset");
      },
    });
    quiet.mockRestore();
    expect(await job()).toMatchObject({ kind: ZETTELIZE_KIND, status: "failed", attempt: 1 });

    const extractor: ZettelExtractor = {
      name: "fake@1",
      extract: async () => [{ title: "One idea", content: "One idea.", quote: Q1 }],
    };
    const retried = await retryGenerationJob(auth, started.jobId);
    expect(retried).toMatchObject({ status: "queued", attempt: 2 });
    await runGenerationJob({ jobId: started.jobId, attempt: 2 }, { [ZETTELIZE_KIND]: zettelizeRunner({ extractor }) });
    expect(await job()).toMatchObject({ status: "ready", result: { notice: "Made 1 zettel." } });

    // The same attempt delivered again (the worker and an inline start both had it) does no work.
    const second = vi.fn();
    await runGenerationJob({ jobId: started.jobId, attempt: 2 }, { [ZETTELIZE_KIND]: second });
    expect(second).not.toHaveBeenCalled();

    const cards = await holder
      .db!.select()
      .from(artifacts)
      .where(and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.kind, "zettel")));
    expect(cards).toHaveLength(1);
  });
});
