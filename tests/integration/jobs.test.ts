import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/* ASH-134 Q04: one claim wins, stale workers are fenced, attempts are recorded, unknown is never blind-retried. */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let client: NonNullable<typeof handle>["client"];
let jobs: typeof import("@/domains/audit/jobs");
let workspaceId: string;

beforeAll(async () => {
  if (!handle) return;
  ({ db, client } = handle);
  jobs = await import("@/domains/audit/jobs");
  ({ workspaceId } = await seedWorkspace(db, `jobs-${Date.now()}`));
});
afterAll(async () => {
  await handle?.client.end();
});
beforeEach(async () => {
  if (handle) await db.execute(sql`delete from jobs`);
});

suite("jobs", () => {
  it("dedupes on key and returns the existing id", async () => {
    const a = await jobs.enqueueJob(client, { workspaceId, kind: "ocr", input: { d: 1 }, dedupeKey: "d1" });
    const b = await jobs.enqueueJob(client, { workspaceId, kind: "ocr", input: { d: 1 }, dedupeKey: "d1" });
    expect(a.enqueued).toBe(true);
    expect(b).toEqual({ enqueued: false, id: a.id });
  });

  it("double claim is blocked, higher priority goes first, attempt row opens", async () => {
    await jobs.enqueueJob(client, { workspaceId, kind: "ocr", input: {}, priority: 0 });
    const hi = await jobs.enqueueJob(client, { workspaceId, kind: "ocr", input: {}, priority: 5 });
    const [c1, c2, c3] = await Promise.all([
      jobs.claimJob(client, { workerId: "w1", kinds: ["ocr"] }),
      jobs.claimJob(client, { workerId: "w2", kinds: ["ocr"] }),
      jobs.claimJob(client, { workerId: "w3", kinds: ["ocr"] }),
    ]);
    const claimed = [c1, c2, c3].filter(Boolean);
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((c) => c!.id)).size).toBe(2);
    expect(claimed.some((c) => c!.id === hi.id)).toBe(true);
    const attempts = await client`select count(*)::int as n from job_attempts`;
    expect(attempts[0].n).toBe(2);
  });

  it("a stale worker cannot complete after its lease expired and the job was reclaimed", async () => {
    await jobs.enqueueJob(client, { workspaceId, kind: "ocr", input: {} });
    const first = (await jobs.claimJob(client, { workerId: "w1", kinds: ["ocr"] }))!;
    await client`update jobs set lease_expires_at = now() - interval '1 second' where id = ${first.id}`;
    const swept = await jobs.recoverExpiredJobs(client, { retrySafeKinds: ["ocr"] });
    expect(swept.requeued).toEqual([first.id]);
    const second = (await jobs.claimJob(client, { workerId: "w2", kinds: ["ocr"] }))!;
    expect(second.generation).toBe(first.generation + 1);
    await expect(jobs.completeJob(client, { id: first.id, leaseToken: first.leaseToken })).rejects.toBeInstanceOf(jobs.JobStaleWriteError);
    await jobs.completeJob(client, { id: second.id, leaseToken: second.leaseToken, result: { ok: true } });
    const [row] = await client`select status, result from jobs where id = ${first.id}`;
    expect(row.status).toBe("succeeded");
  });

  it("non-retry-safe expiry becomes unknown, not requeued", async () => {
    await jobs.enqueueJob(client, { workspaceId, kind: "send", input: {} });
    const j = (await jobs.claimJob(client, { workerId: "w1", kinds: ["send"] }))!;
    await client`update jobs set lease_expires_at = now() - interval '1 second' where id = ${j.id}`;
    const swept = await jobs.recoverExpiredJobs(client, { retrySafeKinds: ["ocr"] });
    expect(swept.unknown).toEqual([j.id]);
    expect(await jobs.claimJob(client, { workerId: "w2", kinds: ["send"] })).toBeNull();
  });

  it("failures retry up to max_attempts then fail; cancel stops a queued job and flags a running one", async () => {
    await jobs.enqueueJob(client, { workspaceId, kind: "ocr", input: {}, maxAttempts: 2 });
    const a = (await jobs.claimJob(client, { workerId: "w", kinds: ["ocr"] }))!;
    expect(await jobs.failJob(client, { id: a.id, leaseToken: a.leaseToken, error: "boom" })).toEqual({ willRetry: true });
    const b = (await jobs.claimJob(client, { workerId: "w", kinds: ["ocr"] }))!;
    expect(await jobs.failJob(client, { id: b.id, leaseToken: b.leaseToken, error: "boom2" })).toEqual({ willRetry: false });
    const [dead] = await client`select status, attempts from jobs where id = ${a.id}`;
    expect(dead).toMatchObject({ status: "failed", attempts: 2 });

    const q = await jobs.enqueueJob(client, { workspaceId, kind: "ocr", input: {} });
    expect(await jobs.requestJobCancel(client, { id: q.id, workspaceId })).toEqual({ status: "cancelled" });
    const r = await jobs.enqueueJob(client, { workspaceId, kind: "ocr", input: {} });
    const running = (await jobs.claimJob(client, { workerId: "w", kinds: ["ocr"] }))!;
    await jobs.requestJobCancel(client, { id: r.id, workspaceId });
    expect(await jobs.heartbeatJob(client, { id: running.id, leaseToken: running.leaseToken })).toEqual({ cancelRequested: true });
    await jobs.cancelClaimedJob(client, { id: running.id, leaseToken: running.leaseToken });
  });
});
