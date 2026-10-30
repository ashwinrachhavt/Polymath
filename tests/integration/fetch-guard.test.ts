import http from "node:http";
import { afterAll, describe, expect, it, vi } from "vitest";
import { TestNetworkViolation } from "../helpers/fetch-guard";

/*
 * tests/unit/fetch-guard.test.ts proves the guard's behavior in depth; this
 * file exists so the db project proves its OWN wiring — the setup file is
 * per-project configuration, and a project that lost it should fail here
 * rather than run unguarded silently. This project's policy is loopback-only
 * (tests/setup.fetch-guard.loopback.ts): integration tests drive real
 * production code against local mock HTTP servers, so loopback must reach the
 * transport while every external host fails closed. It needs no database and
 * imports no db helpers; Postgres connections are sockets, which the guard
 * does not touch. External hosts use the reserved `.test` TLD so even a
 * missing guard leaks nothing.
 */

let server: http.Server | undefined;

afterAll(async () => {
  const closing = server;
  if (closing !== undefined) {
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
});

describe("fetch guard is armed in the db project (loopback-only)", () => {
  it("rejects an external fetch on globalThis", async () => {
    await expect(globalThis.fetch("https://payments.evil.test/v1/x")).rejects.toThrow(TestNetworkViolation);
  });

  it("lets a loopback fetch reach the real transport", async () => {
    const created = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"loopback":true}');
    });
    server = created;
    await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
    const port = (created.address() as { port: number }).port;

    const response = await globalThis.fetch(`http://127.0.0.1:${port}/probe`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ loopback: true });
  });

  it("lets an explicit double serve, and restoring it re-arms the guard", async () => {
    const double = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", double);
    try {
      const response = await globalThis.fetch("https://payments.evil.test/v1/x");
      expect(response.status).toBe(200);
      expect(double).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
    await expect(globalThis.fetch("https://payments.evil.test/v1/x")).rejects.toThrow(TestNetworkViolation);
  });
});
