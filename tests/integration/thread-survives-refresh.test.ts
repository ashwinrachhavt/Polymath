import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuns } from "@/domains/agents/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined; auth: { userId: string; workspaceId: string; role: "owner" } | undefined } = {
  db: undefined,
  auth: undefined,
};
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));
vi.mock("@/lib/auth", () => ({
  authedHandler: (handler: (auth: NonNullable<typeof holder.auth>, request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request, ctx: unknown) => handler(holder.auth!, request, ctx),
}));

import { POST as startRun } from "@/app/api/v1/runs/route";
import { POST as follow } from "@/app/api/v1/runs/[runId]/messages/route";
import { POST as cancel } from "@/app/api/v1/runs/[runId]/cancel/route";
import { POST as retry } from "@/app/api/v1/runs/[runId]/retry/route";
import { listRecentRuns } from "@/domains/agents/queries";
import { listThreads } from "@/domains/agents/thread";
import { recordRoundEvent } from "@/domains/agents/event-bridge";

let a: { userId: string; workspaceId: string };
let b: { userId: string; workspaceId: string };
const as = (w: { userId: string; workspaceId: string }) => { holder.auth = { ...w, role: "owner" }; };
let eve: Array<{ url: string; body: unknown }> = [];
const json = (body: unknown) => new Request("https://axiom.test/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = (runId: string) => ({ params: Promise.resolve({ runId }) }) as never;
async function start(objective: string) {
  const res = await startRun(json({ objective }), undefined as never);
  return ((await res.json()) as { runId: string }).runId;
}

beforeAll(async () => {
  holder.db = handle?.db;
  a = await seedWorkspace(handle!.db, "thr-a");
  b = await seedWorkspace(handle!.db, "thr-b");
});
afterAll(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await handle?.client.end(); });
beforeEach(() => {
  eve = [];
  vi.stubEnv("EVE_BASE_URL", "http://eve.fixture");
  vi.stubEnv("EVE_BRIDGE_SECRET", "z".repeat(40));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    eve.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ sessionId: `wrun_${crypto.randomUUID()}` }, { status: 202 });
  }));
  as(a);
});

suite("thread survives refresh", () => {
  it("persists the objective as the first message and reads it back from listRecentRuns plus events", async () => {
    const runId = await start("Find the rent in my lease");
    await recordRoundEvent({ runId, workspaceId: a.workspaceId, type: "message", data: { role: "assistant", content: "Rent is $1,200." } });
    await recordRoundEvent({ runId, workspaceId: a.workspaceId, type: "usage", data: { usd: "0.01" } });
    // "reload": nothing but the database
    const runs = await listRecentRuns(a.workspaceId, 8);
    expect(runs.map((r) => r.id)).toContain(runId);
    const thread = (await listThreads(a.workspaceId, runs.map((r) => r.id))).get(runId)!;
    expect(thread.map((t) => [t.kind, t.text])).toEqual([
      ["user", "Find the rent in my lease"],
      ["assistant", "Rent is $1,200."],
    ]);
    expect(thread[0].sequence).toBe(1);
  });

  it("a thread is never visible from another workspace", async () => {
    const runId = await start("Private objective");
    expect((await listThreads(b.workspaceId, [runId])).size).toBe(0);
  });

  it("keeps visible reasoning and the compaction boundary on reload", async () => {
    const runId = await start("Summarize my leases");
    await recordRoundEvent({
      runId,
      workspaceId: a.workspaceId,
      type: "reasoning",
      data: { text: "The leases are filed by month.", turnId: "t1", stepIndex: 0 },
    });
    await recordRoundEvent({ runId, workspaceId: a.workspaceId, type: "message", data: { role: "assistant", content: "Done." } });
    await recordRoundEvent({
      runId,
      workspaceId: a.workspaceId,
      type: "compaction",
      data: { turnId: "t1", stepIndex: 2, modelId: "gemini-3.5-flash-lite" },
    });

    const thread = (await listThreads(a.workspaceId, [runId])).get(runId)!;
    expect(thread.map((t) => [t.kind, t.text])).toEqual([
      ["user", "Summarize my leases"],
      ["reasoning", "The leases are filed by month."],
      ["assistant", "Done."],
      ["status", "Earlier turns were summarized to keep the conversation in the model's window."],
    ]);
  });

  it("a follow-up on a live run is stored and signalled to Eve", async () => {
    const runId = await start("Start");
    const res = await follow(json({ message: "Also check the deposit" }), ctx(runId));
    expect(res.status).toBe(202);
    const sent = eve.find((c) => /\/session\/wrun_[^/]+$/.test(c.url));
    expect(sent?.body).toEqual({ message: "Also check the deposit" });
    const thread = (await listThreads(a.workspaceId, [runId])).get(runId)!;
    expect(thread.map((t) => t.text)).toEqual(["Start", "Also check the deposit"]);
  });

  it("a user in another workspace gets 404 on follow-up, cancel and retry", async () => {
    const runId = await start("Mine");
    as(b);
    expect((await follow(json({ message: "hi" }), ctx(runId))).status).toBe(404);
    expect((await cancel(json({}), ctx(runId))).status).toBe(404);
    expect((await retry(json({}), ctx(runId))).status).toBe(404);
  });

  it("cancel calls Eve cancel and writes a cancelled event", async () => {
    const runId = await start("Long task");
    const res = await cancel(json({}), ctx(runId));
    expect(res.status).toBe(200);
    expect(eve.some((c) => c.url.endsWith("/cancel"))).toBe(true);
    const [run] = await holder.db!.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run.state).toBe("cancelled");
    const thread = (await listThreads(a.workspaceId, [runId])).get(runId)!;
    expect(thread.at(-1)).toMatchObject({ kind: "cancelled" });
    expect((await cancel(json({}), ctx(runId))).status).toBe(409);
  });

  it("a finished run rejects further messages, and retry makes a new run id", async () => {
    const runId = await start("Do a thing");
    await cancel(json({}), ctx(runId));
    const before = eve.length;
    const rejected = await follow(json({ message: "more" }), ctx(runId));
    expect(rejected.status).toBe(409);
    expect(eve).toHaveLength(before);

    const res = await retry(json({}), ctx(runId));
    expect(res.status).toBe(201);
    const { runId: next } = (await res.json()) as { runId: string };
    expect(next).not.toBe(runId);
    const [row] = await holder.db!.select().from(agentRuns).where(eq(agentRuns.id, next));
    expect(row).toMatchObject({ retryOfRunId: runId, objective: "Do a thing", state: "running" });
    const thread = (await listThreads(a.workspaceId, [next])).get(next)!;
    expect(thread[0]).toMatchObject({ kind: "user", text: "Do a thing" });
  });

  it("retry on a live run is refused", async () => {
    const runId = await start("Still going");
    expect((await retry(json({}), ctx(runId))).status).toBe(409);
  });

  it("rejects an empty or oversized follow-up", async () => {
    const runId = await start("x");
    expect((await follow(json({ message: "" }), ctx(runId))).status).toBe(422);
    expect((await follow(json({ message: "y".repeat(4001) }), ctx(runId))).status).toBe(422);
  });
});
