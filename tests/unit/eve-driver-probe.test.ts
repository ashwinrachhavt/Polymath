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

// The driver loads child_process with require() at call time, which resolves
// to the same CJS exports object this spy patches.
const cp = createRequire(import.meta.url) as NodeRequire;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("eve liveness probe", () => {
  it("GETs the health route, not the session route", () => {
    const spy = vi.spyOn(cp("child_process") as typeof import("child_process"), "execFileSync").mockReturnValue("200");
    expect(isEveAlive("http://127.0.0.1:59999")).toBe(true);
    const [command, args = []] = spy.mock.calls[0];
    expect(command).toBe("curl");
    const url = args.find((a: string) => a.startsWith("http"));
    expect(url).toBe("http://127.0.0.1:59999/eve/v1/health");
    expect(url).not.toContain("/session");
    // A GET: no -X POST in the argv.
    expect(args).not.toContain("-X");
  });

  it("reports a dead server when the probe fails", () => {
    vi.spyOn(cp("child_process") as typeof import("child_process"), "execFileSync").mockImplementation(() => {
      throw new Error("connect ECONNREFUSED");
    });
    expect(isEveAlive("http://127.0.0.1:59999")).toBe(false);
  });
});
