import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentProfiles, agentRuns } from "@/domains/agents/schema";
import { decodeFrame } from "@/domains/agents/stream-contract";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * GET /api/v1/runs/:runId/stream — the one transport the chat surface reads.
 *
 * Value card
 * protects: the browser-visible chat stream: Eve's protocol events become the
 *   ChatFrame vocabulary the surface renders, a run with no session or an
 *   unreachable Eve becomes frames rather than a 5xx, and a run in another
 *   workspace never reaches Eve.
 * fails_when: the route forwards Eve verbatim (no frames), returns a bare 500
 *   when Eve is down (the surface has nothing to render), streams
 *   `session.completed` without a terminal end frame (the client reconnects
 *   forever), re-frames from index 0 after a resume (duplicate text), or leaks
 *   another workspace's session_ref to Eve.
 * why_new: the route had no test at all; the contract tests only pin the pure
 *   fold, so every branch of the proxy itself was unverified.
 * seam: the route module, with the auth shell mocked at the boundary and a
 *   stubbed global fetch standing in for Eve. Real Postgres for run/profile.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: {
  db: ReturnType<typeof drizzle> | undefined;
  auth: { userId: string; workspaceId: string; role: "owner" | "viewer" } | undefined;
} = { db: undefined, auth: undefined };

vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));
vi.mock("@/lib/auth", () => ({
  authedHandler:
    (handler: (auth: NonNullable<typeof holder.auth>, request: Request, ctx: unknown) => Promise<Response>) =>
    (request: Request, ctx: unknown) =>
      handler(holder.auth!, request, ctx),
}));

import { GET } from "@/app/api/v1/runs/[runId]/stream/route";

const SECRET = "s".repeat(40);
let a: { userId: string; workspaceId: string };
let b: { userId: string; workspaceId: string };
let profileId: string;

const ctx = (runId: string) => ({ params: Promise.resolve({ runId }) }) as never;
const streamOf = (runId: string, cursor = 0) =>
  GET(new Request(`https://axiom.test/api/v1/runs/${runId}/stream`, { headers: { "x-chat-cursor": String(cursor) } }), ctx(runId));

/** A run row bound to the seeded profile, optionally already holding a session. */
async function makeRun(
  workspaceId: string,
  state: "running" | "succeeded" | "cancelled" | "failed",
  sessionRef: string | null,
): Promise<string> {
  const [run] = await holder.db!
    .insert(agentRuns)
    .values({
      workspaceId,
      agentProfileId: profileId,
      objective: "How much is my rent?",
      state,
      policySnapshot: { allowedTools: ["documents.search"] },
      sessionRef,
    })
    .returning({ id: agentRuns.id });
  return run.id;
}

/** Eve's NDJSON envelope, one event per line. */
function eveBody(events: Array<{ type: string; data?: unknown }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: event.type, data: event.data })}\n`));
      }
      controller.close();
    },
  });
}

async function frames(response: Response) {
  const text = await response.text();
  return text
    .split("\n")
    .map((line) => decodeFrame(line))
    .filter((frame): frame is NonNullable<typeof frame> => frame !== null);
}

beforeAll(async () => {
  holder.db = handle?.db;
  a = await seedWorkspace(handle!.db, `csr-${crypto.randomUUID()}`);
  b = await seedWorkspace(handle!.db, `csr-${crypto.randomUUID()}`);
  const [profile] = await holder.db!
    .insert(agentProfiles)
    .values({ workspaceId: a.workspaceId, name: "polymath" })
    .returning({ id: agentProfiles.id });
  profileId = profile.id;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await handle?.client.end();
});
beforeEach(() => {
  holder.auth = { ...a, role: "owner" };
  vi.stubEnv("EVE_BASE_URL", "http://eve.fixture");
  vi.stubEnv("EVE_BRIDGE_SECRET", SECRET);
  vi.unstubAllGlobals();
});

suite("chat stream route (real Postgres)", () => {
  it("re-frames Eve's events into chat frames and stops at the terminal event", async () => {
    const runId = await makeRun(a.workspaceId, "running", "wrun_abc");
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        eveBody([
          { type: "message.received", data: { message: "How much is my rent?" } },
          { type: "message.appended", data: { messageDelta: "Rent is ", turnId: "t1", stepIndex: 0 } },
          { type: "message.completed", data: { message: "Rent is 2,400.", turnId: "t1", stepIndex: 0, finishReason: "stop" } },
          { type: "session.completed" },
          // After the terminal event this must not be forwarded.
          { type: "message.appended", data: { messageDelta: "leak", turnId: "t1", stepIndex: 1 } },
        ]),
        { headers: { "content-type": "application/x-ndjson" } },
      );
    }));

    const response = await streamOf(runId, 4);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const out = await frames(response);

    // The resume cursor is Eve's absolute index, and `follow` stays on for a live run.
    expect(calls[0].url).toContain("/eve/v1/session/wrun_abc/stream?startIndex=4");
    expect((calls[0].init.headers as Record<string, string>).accept).toBe("application/x-ndjson");

    expect(out.map((frame) => frame.type)).toEqual(["message", "delta", "block", "end"]);
    expect(out[0]).toMatchObject({ type: "message", role: "user", text: "How much is my rent?", cursor: 4 });
    expect(out[1]).toMatchObject({ type: "delta", blockId: "assistant:t1:0", text: "Rent is ", cursor: 5 });
    // The completed block is authoritative and carries the finish reason.
    expect(out[2]).toMatchObject({ type: "block", blockId: "assistant:t1:0", text: "Rent is 2,400.", finishReason: "stop", cursor: 6 });
    expect(out[3]).toMatchObject({ type: "end", state: "succeeded", cursor: 7 });
    // No frame after the terminal event: the client would otherwise reconnect.
    expect(out.some((frame) => frame.type === "delta" && (frame as { text: string }).text === "leak")).toBe(false);

    // A socket read can end mid-JSON; an event split across chunks must still
    // arrive whole, or a slow connection silently loses the tail of the reply.
    const splitRun = await makeRun(a.workspaceId, "running", "wrun_split");
    const event = `${JSON.stringify({ type: "message.appended", data: { messageDelta: "split text", turnId: "t", stepIndex: 0 } })}\n`;
    const encoder = new TextEncoder();
    const cut = Math.floor(event.length / 2);
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(event.slice(0, cut)));
            controller.enqueue(encoder.encode(event.slice(cut)));
            controller.close();
          },
        }),
        { headers: { "content-type": "application/x-ndjson" } },
      ),
    ));
    const split = await frames(await streamOf(splitRun));
    expect(split).toHaveLength(1);
    expect(split[0]).toMatchObject({ type: "delta", text: "split text" });
  });

  it("turns a missing session and a failing upstream into frames, not transport errors", async () => {
    // Eve never allocated a session: the surface must show the reason inside
    // the chat, and a cancelled run must not be reported as succeeded.
    const noSession = await makeRun(a.workspaceId, "cancelled", null);
    const first = await frames(await streamOf(noSession));
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({ type: "error", code: "stream_unavailable" });
    expect(first[0]).toMatchObject({ message: expect.stringContaining("no agent session") });
    expect(first[1]).toMatchObject({ type: "end", state: "cancelled" });

    // Eve answers non-2xx (a stranded session answers 409): still a frame.
    const live = await makeRun(a.workspaceId, "running", "wrun_down");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const second = await frames(await streamOf(live));
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ type: "error", code: "stream_unavailable", message: expect.stringContaining("500") });

    // Eve unreachable (connection refused) is also a frame: the surface shows
    // "unreachable" inside the chat and reconnects, rather than crashing.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const thirdLive = await frames(await streamOf(live));
    expect(thirdLive).toHaveLength(1);
    expect(thirdLive[0]).toMatchObject({
      type: "error",
      code: "stream_unavailable",
      message: expect.stringContaining("unreachable"),
    });

    // A finished run that answers non-2xx also gets the end frame, so a replay
    // of a completed run does not leave the surface waiting.
    const done = await makeRun(a.workspaceId, "succeeded", "wrun_done");
    const replayUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      replayUrls.push(url);
      return new Response("gone", { status: 409 });
    }));
    const third = await frames(await streamOf(done));
    expect(third.map((frame) => frame.type)).toEqual(["error", "end"]);
    expect(third[1]).toMatchObject({ type: "end", state: "succeeded" });
    // A finished run is read to its durable tail, never followed: `follow=false`
    // is what keeps the proxy from holding a connection open on a done run.
    expect(replayUrls[0]).toContain("follow=false");
  });

  it("answers 404 for a foreign or malformed run and 503 without a bridge secret, without calling Eve", async () => {
    const runId = await makeRun(a.workspaceId, "running", "wrun_private");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // Another workspace sees the same 404 as a run that does not exist.
    holder.auth = { ...b, role: "owner" };
    const foreign = await streamOf(runId);
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get("content-type")).toContain("application/problem+json");
    expect(await foreign.json()).toMatchObject({ code: "not_found" });

    holder.auth = { ...a, role: "owner" };
    expect((await streamOf(crypto.randomUUID())).status).toBe(404);
    expect((await streamOf("not-a-uuid")).status).toBe(404);

    vi.stubEnv("EVE_BRIDGE_SECRET", "");
    const unavailable = await streamOf(runId);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: "agent_bridge_unavailable" });

    // A run the caller cannot see must not be probed upstream either.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
