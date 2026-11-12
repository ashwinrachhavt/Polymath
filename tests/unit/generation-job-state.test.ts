import { describe, expect, it } from "vitest";
import {
  isSettled,
  jobSignature,
  progressFraction,
  progressLabel,
  STALLED_COPY,
  statusesThatMayBecome,
  toJobView,
  type GenerationJobFacts,
} from "@/domains/jobs/state";
import { followGenerationJobs, parseJobCursor } from "@/domains/jobs/stream";

/*
 * Value: protects=the rule that a generation job is never a silent spinner
 * and that the push stream tells each change once; fails_when=a stalled run
 * reads as still running, an illegal transition becomes legal, the stream
 * repeats a state it sent or loses its cursor; seam=the pure state module and
 * the stream generator with a scripted tail; no_claim=SQL guards and the HTTP
 * route (integration suite, browser check).
 */

const base: GenerationJobFacts = {
  id: "job-1",
  kind: "learning.quiz",
  subject: null,
  status: "running",
  title: "Quiz: Notes",
  attempt: 1,
  result: null,
  error: null,
  progress: null,
  costMicroUsd: 0,
  createdAt: new Date("2026-11-11T10:00:00Z"),
  updatedAt: new Date("2026-11-11T10:00:05Z"),
  stalled: false,
};

describe("generation job state", () => {
  it("allows only the transitions of the machine", () => {
    expect(statusesThatMayBecome("running")).toEqual(["queued"]);
    expect(statusesThatMayBecome("ready")).toEqual(["running"]);
    expect(statusesThatMayBecome("failed")).toEqual(["running"]);
    expect(statusesThatMayBecome("queued")).toEqual(["failed", "cancelled"]);
    expect(statusesThatMayBecome("cancelled")).toEqual(["queued", "running"]);
  });

  it("treats ready, failed and cancelled as settled, and nothing else", () => {
    expect(["queued", "running"].map((s) => isSettled(s as never))).toEqual([false, false]);
    expect(["ready", "failed", "cancelled"].map((s) => isSettled(s as never))).toEqual([true, true, true]);
  });

  it("shows progress only while the job runs, and its spend in dollars", () => {
    const progress = { step: "Crawling", done: 12, total: 25 };
    expect(toJobView({ ...base, progress, costMicroUsd: 37_500 })).toMatchObject({ progress, costUsd: 0.0375 });
    expect(toJobView({ ...base, status: "ready", progress, result: { href: "/x", notice: null } }).progress).toBeNull();
    expect(toJobView({ ...base, progress, stalled: true }).progress).toBeNull();
  });

  it("labels a step with its counts and turns them into a fraction", () => {
    expect(progressLabel({ step: "Crawling", done: 12, total: 25 })).toBe("Crawling 12/25");
    expect(progressLabel({ step: "Reading pages", done: 3, total: null })).toBe("Reading pages 3");
    expect(progressLabel({ step: "Reading page", done: null, total: null })).toBe("Reading page");
    expect(progressFraction({ step: "Crawling", done: 5, total: 20 })).toBe(0.25);
    expect(progressFraction({ step: "Crawling", done: 5, total: null })).toBeNull();
    expect(progressFraction(null)).toBeNull();
  });

  it("shows a running job whose heartbeat stopped as failed with a reason", () => {
    const view = toJobView({ ...base, stalled: true });
    expect(view.status).toBe("failed");
    expect(view.error).toBe(STALLED_COPY);
  });

  it("ignores the stalled flag once a job has settled", () => {
    const view = toJobView({
      ...base,
      status: "ready",
      stalled: true,
      result: { href: "/learn/quizzes/q1", notice: null },
    });
    expect(view).toMatchObject({ status: "ready", href: "/learn/quizzes/q1", error: null });
  });

  it("exposes the result only when ready and the error only when failed", () => {
    expect(toJobView(base)).toMatchObject({ href: null, error: null });
    expect(toJobView({ ...base, status: "failed", error: "No." })).toMatchObject({ href: null, error: "No." });
  });

  it("gives a retried job a new signature even when its status repeats", () => {
    expect(jobSignature({ status: "failed", attempt: 1, progress: null })).not.toBe(
      jobSignature({ status: "failed", attempt: 2, progress: null }),
    );
  });

  it("gives every progress step its own signature, so the stream sends each one", () => {
    const at = (done: number) =>
      jobSignature({ status: "running", attempt: 1, progress: { step: "Crawling", done, total: 25 } });
    expect(at(3)).not.toBe(at(4));
    expect(at(4)).toBe(at(4));
  });
});

describe("generation job stream", () => {
  const auth = { workspaceId: "w", userId: "u" };

  async function collect(passes: Array<ReturnType<typeof toJobView>[]>, since: Date | null = null) {
    const controller = new AbortController();
    const seen: Array<Date | null> = [];
    let pass = 0;
    const frames: string[] = [];
    const stream = followGenerationJobs(auth, {
      since,
      signal: controller.signal,
      maxMs: 60_000,
      tail: async (_auth, from) => {
        seen.push(from);
        const jobs = passes[pass] ?? [];
        pass += 1;
        if (pass >= passes.length) controller.abort();
        return { jobs, now: new Date(Date.UTC(2026, 10, 11, 10, 0, pass)) };
      },
      sleep: async () => {},
    });
    for await (const frame of stream) frames.push(frame);
    return { frames, seen };
  }

  it("sends each state of a job once and resumes each pass from the last read", async () => {
    const running = toJobView(base);
    const ready = toJobView({ ...base, status: "ready", result: { href: "/learn/quizzes/q1", notice: null } });
    const { frames, seen } = await collect([[running], [running], [ready]]);

    const events = frames.filter((frame) => frame.includes("event: job"));
    expect(events).toHaveLength(2);
    expect(events[0]).toContain('"status":"running"');
    expect(events[1]).toContain('"status":"ready"');
    expect(events[1]).toContain("id: 2026-11-11T10:00:03.000Z");
    expect(seen).toEqual([null, new Date("2026-11-11T10:00:01Z"), new Date("2026-11-11T10:00:02Z")]);
  });

  it("moves the cursor on a quiet pass without dispatching an event", async () => {
    const { frames } = await collect([[]]);
    expect(frames).toEqual(["retry: 2000\n\n", "id: 2026-11-11T10:00:01.000Z\n\n"]);
  });

  it("starts from the cursor a reconnecting client sends", async () => {
    const cursor = parseJobCursor("2026-11-11T09:59:00.000Z");
    const { seen } = await collect([[]], cursor);
    expect(seen[0]).toEqual(new Date("2026-11-11T09:59:00Z"));
    expect(parseJobCursor("not a time")).toBeNull();
    expect(parseJobCursor(null)).toBeNull();
  });
});
