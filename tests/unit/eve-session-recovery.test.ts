import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEveDriver } from "@/domains/agents/eve-driver";
import { isEveSessionStranded, replayContextForRun, startReplacementSession } from "@/domains/agents/eve-recovery";

const mocks = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn() }));
const SECRET = "t".repeat(40);
const auth = { userId: "user-1", workspaceId: "ws-1", role: "member" as const };

vi.mock("@/lib/db", () => ({ db: { select: mocks.select, update: mocks.update } }));

const RUNS: unknown[] = [];
const EVENTS: unknown[] = [];

/** A drizzle chain: selects end in `.limit` for runs, `.orderBy` for events. */
function chain() {
  const builder = {
    from: () => builder,
    where: () => builder,
    orderBy: async () => EVENTS,
    limit: async () => RUNS,
  };
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  RUNS.length = 0;
  EVENTS.length = 0;
  vi.stubEnv("EVE_BASE_URL", "http://eve.fixture");
  vi.stubEnv("EVE_BRIDGE_SECRET", SECRET);
  mocks.select.mockImplementation(() => chain());
  mocks.update.mockReturnValue({ set: () => ({ where: async () => [] }) });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const ndjson = (...events: unknown[]) => new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n");

describe("Eve session recovery", () => {
  it("treats a 404 session as stranded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    expect(await isEveSessionStranded({ agentName: "polymath", sessionRef: "wrun_old", auth })).toBe(true);
  });

  it("treats a history whose tail waits for a message as stranded", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        ndjson({ type: "session.started" }, { type: "session.waiting", data: { wait: "next-user-message" } }),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await isEveSessionStranded({ agentName: "polymath", sessionRef: "wrun_old", auth })).toBe(true);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://eve.fixture/eve/v1/session/wrun_old/stream?follow=false");
    expect((init.headers as Record<string, string>).authorization).toMatch(/^Bearer /);
  });

  it("does not treat a failed session as stranded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjson({ type: "session.waiting" }, { type: "session.failed" })));
    expect(await isEveSessionStranded({ agentName: "polymath", sessionRef: "wrun_old", auth })).toBe(false);
  });

  it("replaces a stranded session with the replay as context and repoints the run", async () => {
    RUNS.push({ id: "run-uuid" });
    EVENTS.push(
      { sequence: 1, type: "message", data: { role: "user", content: "Plan the trip" } },
      { sequence: 2, type: "reasoning", data: { text: "Checking dates" } },
      { sequence: 3, type: "message", data: { role: "assistant", content: "Which month?" } },
    );
    const fetch = vi.fn().mockResolvedValue(Response.json({ sessionId: "wrun_new" }, { status: 202 }));
    vi.stubGlobal("fetch", fetch);

    const result = await startReplacementSession({
      runId: "run-uuid",
      auth,
      agentName: "polymath",
      message: "June",
      model: "mercury-3",
    });

    expect(result).toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://eve.fixture/eve/v1/session");
    const body = JSON.parse(String(init.body)) as { message: string; operationId: string };
    expect(body.message).toContain("User: Plan the trip");
    expect(body.message).toContain("Assistant: Which month?");
    expect(body.message.endsWith("June")).toBe(true);
    expect(body.operationId).toMatch(/^axiom-recover-run-uuid-/);
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it("sends the follow-up that found the session stranded once, not in the replay and again after it", async () => {
    RUNS.push({ id: "run-uuid" });
    // The follow-up is stored before the replacement starts, so it is the
    // replay's last row (the duplicate seen in run c359de81, 2026-11-12).
    EVENTS.push(
      { sequence: 1, type: "message", data: { role: "user", content: "Research Intangible" } },
      { sequence: 2, type: "message", data: { role: "assistant", content: "Here is the brief." } },
      { sequence: 3, type: "message", data: { role: "user", content: "Name the three key players" } },
    );
    const fetch = vi.fn().mockResolvedValue(Response.json({ sessionId: "wrun_new" }, { status: 202 }));
    vi.stubGlobal("fetch", fetch);

    await startReplacementSession({
      runId: "run-uuid",
      auth,
      agentName: "polymath",
      message: "Name the three key players",
    });

    const body = JSON.parse(String((fetch.mock.calls[0] as [string, RequestInit])[1].body)) as { message: string };
    expect(body.message.split("Name the three key players")).toHaveLength(2);
    expect(body.message).toContain("User: Research Intangible");
  });

  it("replay caps at the most recent content", async () => {
    EVENTS.push(
      { sequence: 1, type: "message", data: { role: "user", content: `OLD${"x".repeat(9000)}` } },
      { sequence: 2, type: "message", data: { role: "assistant", content: "RECENT" } },
    );
    const replay = await replayContextForRun("run-uuid", "ws-1");
    expect(replay).toContain("RECENT");
    expect(replay).not.toContain("OLD");
    expect(replay.length).toBeLessThan(8300);
  });

  it("signal recovers a stranded run instead of throwing", async () => {
    RUNS.push({ sessionRef: "wrun_old", policySnapshot: { model: "mercury-3" } });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Failed to send the session message." }), { status: 500 }),
      )
      .mockResolvedValueOnce(ndjson({ type: "session.waiting" }))
      .mockResolvedValueOnce(Response.json({ sessionId: "wrun_new" }, { status: 202 }));
    vi.stubGlobal("fetch", fetch);

    await expect(createEveDriver().signal("run-uuid", "June", auth)).resolves.toBeUndefined();
    expect((fetch.mock.calls[1] as [string])[0]).toContain("/session/wrun_old/stream");
    expect((fetch.mock.calls[2] as [string])[0]).toBe("http://eve.fixture/eve/v1/session");
  });
});
