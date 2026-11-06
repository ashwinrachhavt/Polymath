import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentProfiles, agentRuns, runEvents } from "@/domains/agents/schema";
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
  GET(
    new Request(`https://axiom.test/api/v1/runs/${runId}/stream`, { headers: { "x-chat-cursor": String(cursor) } }),
    ctx(runId),
  );

/** A run row bound to the seeded profile, optionally already holding a session. */
async function makeRun(
  workspaceId: string,
  state: "running" | "succeeded" | "cancelled" | "failed",
  sessionRef: string | null,
): Promise<string> {
  const [run] = await holder
    .db!.insert(agentRuns)
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
  const [profile] = await holder
    .db!.insert(agentProfiles)
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          eveBody([
            { type: "message.received", data: { message: "How much is my rent?" } },
            { type: "message.appended", data: { messageDelta: "Rent is ", turnId: "t1", stepIndex: 0 } },
            {
              type: "message.completed",
              data: { message: "Rent is 2,400.", turnId: "t1", stepIndex: 0, finishReason: "stop" },
            },
            { type: "session.completed" },
            // After the terminal event this must not be forwarded.
            { type: "message.appended", data: { messageDelta: "leak", turnId: "t1", stepIndex: 1 } },
          ]),
          { headers: { "content-type": "application/x-ndjson" } },
        );
      }),
    );

    const response = await streamOf(runId, 4);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const out = await frames(response);

    // The resume cursor is Eve's absolute index, and `follow` stays on for a live run.
    expect(calls[0].url).toContain("/eve/v1/session/wrun_abc/stream?startIndex=4");
    expect((calls[0].init.headers as Record<string, string>).accept).toBe("application/x-ndjson");

    expect(out.map((frame) => frame.type)).toEqual(["run", "message", "delta", "block", "end"]);
    // Every connection opens with the run's own durable stage facts.
    expect(out[0]).toMatchObject({ type: "run", runId, state: "running", lastTurnFailed: false });
    expect(out[1]).toMatchObject({ type: "message", role: "user", text: "How much is my rent?", cursor: 4 });
    expect(out[2]).toMatchObject({ type: "delta", blockId: "assistant:t1:0", text: "Rent is ", cursor: 5 });
    // The completed block is authoritative and carries the finish reason.
    expect(out[3]).toMatchObject({
      type: "block",
      blockId: "assistant:t1:0",
      text: "Rent is 2,400.",
      finishReason: "stop",
      cursor: 6,
    });
    expect(out[4]).toMatchObject({ type: "end", state: "succeeded", cursor: 7 });
    // No frame after the terminal event: the client would otherwise reconnect.
    expect(out.some((frame) => frame.type === "delta" && (frame as { text: string }).text === "leak")).toBe(false);

    // A socket read can end mid-JSON; an event split across chunks must still
    // arrive whole, or a slow connection silently loses the tail of the reply.
    const splitRun = await makeRun(a.workspaceId, "running", "wrun_split");
    const event = `${JSON.stringify({ type: "message.appended", data: { messageDelta: "split text", turnId: "t", stepIndex: 0 } })}\n`;
    const encoder = new TextEncoder();
    const cut = Math.floor(event.length / 2);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
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
      ),
    );
    const split = await frames(await streamOf(splitRun));
    expect(split).toHaveLength(2);
    expect(split[1]).toMatchObject({ type: "delta", text: "split text" });
  });

  it("turns a missing session and a failing upstream into frames, not transport errors", async () => {
    // Eve never allocated a session: the surface must show the reason inside
    // the chat, and a cancelled run must not be reported as succeeded.
    const noSession = await makeRun(a.workspaceId, "cancelled", null);
    const first = await frames(await streamOf(noSession));
    expect(first).toHaveLength(3);
    expect(first[0]).toMatchObject({ type: "run", state: "cancelled" });
    expect(first[1]).toMatchObject({ type: "error", code: "stream_unavailable" });
    expect(first[1]).toMatchObject({ message: expect.stringContaining("no agent session") });
    expect(first[2]).toMatchObject({ type: "end", state: "cancelled" });

    // Eve answers non-2xx (a stranded session answers 409): still a frame.
    const live = await makeRun(a.workspaceId, "running", "wrun_down");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const second = await frames(await streamOf(live));
    expect(second).toHaveLength(2);
    expect(second[0]).toMatchObject({ type: "run", state: "running" });
    expect(second[1]).toMatchObject({
      type: "error",
      code: "stream_unavailable",
      message: expect.stringContaining("500"),
    });

    // Eve unreachable (connection refused) is also a frame: the surface shows
    // "unreachable" inside the chat and reconnects, rather than crashing.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const thirdLive = await frames(await streamOf(live));
    expect(thirdLive).toHaveLength(2);
    // The run frame rides the error path too: a reconnect over an unreachable
    // bridge still opens with what the rows know.
    expect(thirdLive[0]).toMatchObject({ type: "run", state: "running" });
    expect(thirdLive[1]).toMatchObject({
      type: "error",
      code: "stream_unavailable",
      message: expect.stringContaining("unreachable"),
    });

    // A finished run that answers non-2xx also gets the end frame, so a replay
    // of a completed run does not leave the surface waiting.
    const done = await makeRun(a.workspaceId, "succeeded", "wrun_done");
    const replayUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        replayUrls.push(url);
        return new Response("gone", { status: 409 });
      }),
    );
    const third = await frames(await streamOf(done));
    expect(third.map((frame) => frame.type)).toEqual(["run", "error", "end"]);
    expect(third[2]).toMatchObject({ type: "end", state: "succeeded" });
    // A finished run is read to its durable tail, never followed: `follow=false`
    // is what keeps the proxy from holding a connection open on a done run.
    expect(replayUrls[0]).toContain("follow=false");
  });

  it("replays a machinery run's durable rows when it has no session", async () => {
    // The cutover's composer-started runs never allocate a session: the engine
    // writes run_events directly. Their answers are durable rows, and the
    // surface must read them instead of reporting a broken start. (Verified on
    // the live QA drive: every person-message run has session_ref null while
    // the judge and ticket workers hold sessions.)
    const runId = await makeRun(a.workspaceId, "succeeded", null);
    await holder.db!.insert(runEvents).values([
      {
        workspaceId: a.workspaceId,
        runId,
        sequence: 1,
        type: "message",
        data: { role: "user", content: "How much is my rent?" },
      },
      {
        workspaceId: a.workspaceId,
        runId,
        sequence: 2,
        type: "message.completed",
        data: { turnId: "superagent:a", message: "Ask the owner for the lease.", stepIndex: 0 },
      },
      {
        workspaceId: a.workspaceId,
        runId,
        sequence: 3,
        type: "message.completed",
        data: { turnId: "superagent:b", message: "Nothing covers this yet.", stepIndex: 1 },
      },
    ]);

    const out = await frames(await streamOf(runId));
    // The stored user turn replays too: the thread writer's bare `message` row
    // is the person's question, so a reload keeps it ahead of the answers it
    // asked for instead of showing only the reply lane.
    expect(out.map((frame) => frame.type)).toEqual(["run", "message", "block", "block", "end"]);
    expect(out[1]).toMatchObject({ type: "message", role: "user", text: "How much is my rent?", cursor: 1 });
    // The block ids match what threadBlocks derives from the stored side, so a
    // replay replaces the SSR blocks instead of duplicating them.
    expect(out[2]).toMatchObject({
      type: "block",
      blockId: "assistant:superagent:a:0",
      text: "Ask the owner for the lease.",
    });
    expect(out[3]).toMatchObject({
      type: "block",
      blockId: "assistant:superagent:b:1",
      text: "Nothing covers this yet.",
    });
    expect(out[4]).toMatchObject({ type: "end", state: "succeeded", cursor: 3 });
    expect(out.some((frame) => frame.type === "error")).toBe(false);

    // A resume from the applied cursor folds only the newer rows.
    const resume = await frames(await streamOf(runId, 2));
    expect(resume.map((frame) => frame.type)).toEqual(["run", "block", "end"]);
    expect(resume[1]).toMatchObject({ blockId: "assistant:superagent:b:1", cursor: 3 });
  });

  it("follows a live machinery run by polling its rows and ends at the real terminal state", async () => {
    const runId = await makeRun(a.workspaceId, "running", null);
    await holder.db!.insert(runEvents).values({
      workspaceId: a.workspaceId,
      runId,
      sequence: 1,
      type: "message.completed",
      data: { turnId: "superagent:a", message: "Working on it.", stepIndex: 0 },
    });
    // The engine finishes the run between polls: another row lands and the
    // state flips. waiting_input must never be reported as ended — the
    // surface's "conversation has ended" banner came from exactly that lie.
    const engineFinishes = setTimeout(() => {
      void holder
        .db!.insert(runEvents)
        .values({
          workspaceId: a.workspaceId,
          runId,
          sequence: 2,
          type: "message.completed",
          data: { turnId: "superagent:b", message: "Done.", stepIndex: 1 },
        })
        .then(() => holder.db!.update(agentRuns).set({ state: "succeeded" }).where(eq(agentRuns.id, runId)));
    }, 2500);

    try {
      const out = await frames(await streamOf(runId));
      expect(out.map((frame) => frame.type)).toEqual(["run", "block", "block", "end"]);
      expect(out.some((frame) => frame.type === "error")).toBe(false);
      expect(out[3]).toMatchObject({ type: "end", state: "succeeded" });
    } finally {
      clearTimeout(engineFinishes);
    }
  });

  it("follows a starting run that has no frames yet instead of erroring", async () => {
    // A fresh composer submit: the person's message is stored, the machinery
    // hasn't written anything, and there is no session (the judge's run owns
    // one — the person's never does). The stream must hold silently; the
    // first cut of the replay guard errored here ("This run has no agent
    // session.") and told the surface the conversation had ended before the
    // machinery could answer. (Caught on the live cutover drive.)
    const runId = await makeRun(a.workspaceId, "running", null);
    await holder.db!.insert(runEvents).values({
      workspaceId: a.workspaceId,
      runId,
      sequence: 1,
      type: "message",
      data: { role: "user", content: "What daybook entries exist for today? Reply in one sentence." },
    });

    const response = await streamOf(runId);
    const reader = response.body!.getReader();
    let got = "";
    const bail = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
    }, 3000);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += new TextDecoder().decode(value);
      }
    } catch {
      // Cancelled by the bail timer — the stream held silently past the head.
    } finally {
      clearTimeout(bail);
    }
    // The head carries the run's durable stage facts, then the stored person
    // turn; nothing terminates the wait — no error frame. (The first cut of the
    // replay guard errored here — "This run has no agent session." — and told
    // the surface the conversation had ended before the machinery could answer.)
    const out = got
      .split("\n")
      .map((line) => decodeFrame(line))
      .filter((frame): frame is NonNullable<typeof frame> => frame !== null);
    expect(out.map((frame) => frame.type)).toEqual(["run", "message"]);
    expect(out[1]).toMatchObject({ type: "message", role: "user", cursor: 1 });
    expect(out[0]).toMatchObject({ state: "running", lastTurnFailed: false });
  });

  it("opens every connection with the run's durable failure facts, dead bridge included", async () => {
    // The facts a chip needs are the rows': a failed run row, and whether the
    // run's newest turn boundary is a failure — a newer human message or turn
    // supersedes an older failure, the supervision panel's rule.
    const failed = await makeRun(a.workspaceId, "failed", null);
    await holder.db!.insert(runEvents).values([
      {
        workspaceId: a.workspaceId,
        runId: failed,
        sequence: 1,
        type: "message",
        data: { role: "user", content: "How much is my rent?" },
      },
      {
        workspaceId: a.workspaceId,
        runId: failed,
        sequence: 2,
        type: "turn.failed",
        data: { reason: "The bridge died mid-turn." },
      },
    ]);
    const out = await frames(await streamOf(failed));
    expect(out[0]).toMatchObject({ type: "run", state: "failed", lastTurnFailed: true });

    // The person spoke again after the failure: the newest boundary supersedes it.
    const superseded = await makeRun(a.workspaceId, "failed", null);
    await holder.db!.insert(runEvents).values([
      {
        workspaceId: a.workspaceId,
        runId: superseded,
        sequence: 1,
        type: "message",
        data: { role: "user", content: "Try again." },
      },
      {
        workspaceId: a.workspaceId,
        runId: superseded,
        sequence: 2,
        type: "turn.failed",
        data: {},
      },
      {
        workspaceId: a.workspaceId,
        runId: superseded,
        sequence: 3,
        type: "message",
        data: { role: "user", content: "How about now?" },
      },
    ]);
    const again = await frames(await streamOf(superseded));
    expect(again[0]).toMatchObject({ type: "run", state: "failed", lastTurnFailed: false });

    // The bridge dialect (machinery runs) writes the person's turn as
    // `message.received` rather than a bare `message`; it supersedes the same
    // way — one run's frame fact, two writers.
    const echoed = await makeRun(a.workspaceId, "failed", null);
    await holder.db!.insert(runEvents).values([
      {
        workspaceId: a.workspaceId,
        runId: echoed,
        sequence: 1,
        type: "turn.failed",
        data: {},
      },
      {
        workspaceId: a.workspaceId,
        runId: echoed,
        sequence: 2,
        type: "message.received",
        data: { message: "Try again." },
      },
    ]);
    const echoedFrames = await frames(await streamOf(echoed));
    expect(echoedFrames[0]).toMatchObject({ type: "run", state: "failed", lastTurnFailed: false });

    // A live run whose bridge is unreachable still opens with the facts — the
    // reconnect must not retry blind.
    const live = await makeRun(a.workspaceId, "running", "wrun_dark");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const dark = await frames(await streamOf(live));
    expect(dark.map((frame) => frame.type)).toEqual(["run", "error"]);
    expect(dark[0]).toMatchObject({ type: "run", state: "running", lastTurnFailed: false });

    // A finished run over a dead bridge still settles: the row's terminal
    // state rides the end frame, so the surface pins the failure instead of
    // reconnecting forever against a bridge that will never answer.
    const finishedDark = await makeRun(a.workspaceId, "failed", "wrun_gone");
    const settled = await frames(await streamOf(finishedDark));
    expect(settled.map((frame) => frame.type)).toEqual(["run", "error", "end"]);
    expect(settled[0]).toMatchObject({ type: "run", state: "failed", lastTurnFailed: false });
    expect(settled[2]).toMatchObject({ type: "end", state: "failed" });
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
