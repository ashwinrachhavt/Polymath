import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuns } from "@/domains/agents/schema";
import { verifyWorkspaceBinding } from "@/domains/identity/resolve";
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

import { POST } from "@/app/api/v1/runs/route";
import { GET } from "@/app/api/v1/runs/[runId]/route";

let a: { userId: string; workspaceId: string };
let b: { userId: string; workspaceId: string };
const as = (w: { userId: string; workspaceId: string }) => { holder.auth = { ...w, role: "owner" }; };
const post = (body: unknown, key?: string) =>
  POST(new Request("https://axiom.test/api/v1/runs", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    body: JSON.stringify(body),
  }), undefined as never);
const KEY = "5f0c9f4e-8b0e-4f3e-9a55-0c1d2e3f4a5b";
let eveCalls: Array<{ url: string; init: RequestInit }> = [];

beforeAll(async () => {
  holder.db = handle?.db;
  a = await seedWorkspace(handle!.db, "pr4a");
  b = await seedWorkspace(handle!.db, "pr4b");
});
afterAll(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await handle?.client.end(); });
beforeEach(() => {
  eveCalls = [];
  vi.stubEnv("EVE_BASE_URL", "http://eve.fixture");
  vi.stubEnv("EVE_BRIDGE_SECRET", "q".repeat(40));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    eveCalls.push({ url, init });
    return Response.json({ sessionId: `wrun_${eveCalls.length}` }, { status: 202 });
  }));
  as(a);
});

suite("signed-in run start", () => {
  it("returns 201, stores the Eve session id in session_ref, and sends a bearer, not a spike header", async () => {
    const res = await post({ objective: "Summarise my tasks" });
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    const [run] = await handle!.db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run.workspaceId).toBe(a.workspaceId);
    expect(run.sessionRef).toBe("wrun_1");
    const headers = eveCalls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Bearer v1\./);
    expect(headers["x-spike-clerk-user-id"]).toBeUndefined();
    expect(JSON.parse(String(eveCalls[0].init.body)).operationId).toBe(`axiom-run-${runId}`);
  });

  it("a second POST with the same Idempotency-Key creates no second run or Eve session", async () => {
    const first = await post({ objective: "Once only" }, KEY);
    const second = await post({ objective: "Once only" }, KEY);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
    expect(eveCalls).toHaveLength(1);
  });

  it("the same key with a different body is a 422 and starts nothing", async () => {
    const key = "6a1d0a5f-9c1f-4a4f-8b66-1d2e3f4a5b6c";
    await post({ objective: "Original" }, key);
    const before = eveCalls.length;
    const res = await post({ objective: "Different" }, key);
    expect(res.status).toBe(422);
    expect(eveCalls).toHaveLength(before);
  });

  it("a malformed key is 400 and a missing bridge secret is 503 with no run created", async () => {
    expect((await post({ objective: "x" }, "not-a-uuid")).status).toBe(400);
    vi.stubEnv("EVE_BRIDGE_SECRET", "");
    const res = await post({ objective: "x" });
    expect(res.status).toBe(503);
    expect(eveCalls).toHaveLength(0);
  });

  it("a failed Eve create frees the key so a retry can start, and answers with a problem, not a bare 500", async () => {
    const key = "7b2e1b6a-ad20-4b5a-9c77-2e3f4a5b6c7d";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const failed = await post({ objective: "Will fail" }, key);
    expect(failed.status).toBe(502);
    expect(failed.headers.get("content-type")).toContain("application/problem+json");
    expect(await failed.json()).toMatchObject({ code: "agent_start_failed" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ sessionId: "wrun_ok" }, { status: 202 })));
    expect((await post({ objective: "Will fail" }, key)).status).toBe(201);
  });

  it("without EVE_BASE_URL on Vercel, Eve is called on the deployment's own origin at /eve/polymath/v1", async () => {
    vi.stubEnv("EVE_BASE_URL", "");
    vi.stubEnv("VERCEL_BRANCH_URL", "axiom-git-feat-pr4.example.vercel.app");
    const res = await post({ objective: "Same origin" });
    expect(res.status).toBe(201);
    expect(eveCalls[0].url).toBe("https://axiom-git-feat-pr4.example.vercel.app/eve/polymath/v1/session");
    vi.stubEnv("VERCEL_BRANCH_URL", "");
  });
});

suite("workspace isolation", () => {
  it("a user in another workspace cannot read the run", async () => {
    const { runId } = (await (await post({ objective: "Private" })).json()) as { runId: string };
    const ctx = { params: Promise.resolve({ runId }) };
    const own = await GET(new Request("https://axiom.test/x"), ctx as never);
    expect(own.status).toBe(200);
    as(b);
    const foreign = await GET(new Request("https://axiom.test/x"), ctx as never);
    expect(foreign.status).toBe(404);
  });

  it("verifyWorkspaceBinding only accepts an active member with the stated role", async () => {
    expect(await verifyWorkspaceBinding({ ...a, role: "owner" })).toEqual({ ...a, role: "owner" });
    expect(await verifyWorkspaceBinding({ userId: a.userId, workspaceId: b.workspaceId, role: "owner" })).toBeNull();
    expect(await verifyWorkspaceBinding({ ...a, role: "viewer" })).toBeNull();
  });
});
