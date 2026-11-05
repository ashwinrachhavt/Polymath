import { createRequire } from "module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The dev-server liveness probe must hit the unauthenticated health route and
 * nothing else. It used to POST /eve/v1/session as its probe; in development
 * the eve channel authenticates any loopback caller as its local-dev identity,
 * so every probe CREATED a session. The probe runs on every stream open, so
 * one person reloading a live conversation spawned dozens of orphaned eve
 * sessions — the "infinite loop" on main.
 */

import { isEveAlive } from "@/domains/agents/eve-driver";

// The driver used to load child_process with require() at call time. It is
// fetch-based now; this require still resolves the same CJS exports object,
// so the no-process guard below can keep watching it.
const cp = createRequire(import.meta.url) as NodeRequire;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("eve liveness probe", () => {
  /*
   * The probe was a sync execFileSync curl; it is fetch-based with one retry
   * per failure now (a cold dev server's first health answer can miss the
   * probe budget — the 2026-11-05 ticket-run loss). The execFileSync guard
   * stays: the probe must never spawn a process again.
   */
  it("GETs the health route, not the session route", async () => {
    const cpSpy = vi.spyOn(cp("child_process") as typeof import("child_process"), "execFileSync");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    await expect(isEveAlive("http://127.0.0.1:59999")).resolves.toBe(true);
    expect(cpSpy).not.toHaveBeenCalled();
    const [url, init = {}] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:59999/eve/v1/health");
    expect(url).not.toContain("/session");
    // A GET: no method override in the init.
    expect((init as RequestInit).method).toBeUndefined();
  });

  it("reports a dead server when the probe fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(isEveAlive("http://127.0.0.1:59999")).resolves.toBe(false);
  });

  /*
   * Value: protects=the probe never declaring a broken eve server alive;
   * fails_when=a 500 counts as reachable and a stream opens onto a server
   * that cannot serve the turn; why_new=extends the ISSUE-003 regression with
   * the status-code branch the fetch-based probe kept; seam=fetch mock;
   * no_claim=eve's own health route behaviour.
   */
  it("reports a dead server on a non-2xx answer without retrying", async () => {
    // A 500 from the health route means eve is up but broken; claiming alive
    // would open a stream that cannot serve the turn. Broken is not retried.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
    await expect(isEveAlive("http://127.0.0.1:59999")).resolves.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  /*
   * Value: protects=the cold-start loss seen 2026-11-05 08:32 (ticket run
   * c46d9f22 failed "Eve is not reachable" because an idle eve server's first
   * health answer missed the old 2s sync curl budget and the failure was
   * final); fails_when=a probe that times out once but succeeds on the retry
   * still reports dead; why_new=the probe now retries before declaring death,
   * and every isEveAlive caller is async; seam=fetch mock (the probe is fetch-
   * based now, no child_process); no_claim=eve's own health route behaviour.
   */
  it("recovers when the first probe times out but the retry answers", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("The operation was aborted due to timeout"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(isEveAlive("http://127.0.0.1:59999")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stays dead when every probe attempt fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(isEveAlive("http://127.0.0.1:59999")).resolves.toBe(false);
  });

  it("stays dead on a non-2xx retry answer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
    await expect(isEveAlive("http://127.0.0.1:59999")).resolves.toBe(false);
  });
});
