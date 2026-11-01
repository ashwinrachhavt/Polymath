import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import proxy from "@/proxy";

vi.mock("@/lib/clerk", () => ({ clerkConfigured: true, devAuthBypass: false, proxyArmed: true }));
vi.mock("@clerk/nextjs/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("@clerk/nextjs/server")>(),
  clerkMiddleware: (handler: unknown) => handler,
}));

const runProxy = proxy as unknown as (
  auth: {
    protect: ReturnType<typeof vi.fn>;
    (options?: unknown): Promise<{ isAuthenticated: boolean }>;
  },
  request: NextRequest,
) => Promise<Response | void>;

describe("Clerk proxy token boundary", () => {
  it.each(["/api/v1", "/api/v1/runs", "/api/v1/files", "/api/v1/documents/id/extract"])(
    "accepts only the API guard's supported token types on %s", async (path) => {
      const protect = vi.fn();
      const check = vi.fn().mockResolvedValue({ isAuthenticated: true });
      await runProxy(Object.assign(check, { protect }), new NextRequest(`https://axiom.test${path}`));
      expect(check).toHaveBeenCalledExactlyOnceWith({ acceptsToken: ["session_token", "m2m_token", "api_key"] });
      expect(protect).not.toHaveBeenCalled();
    },
  );

  it.each(["/api/v1", "/api/v1/captures"])(
    "answers a signed-out API caller with 401 rather than a sign-in redirect on %s", async (path) => {
      const check = vi.fn().mockResolvedValue({ isAuthenticated: false });
      const response = await runProxy(Object.assign(check, { protect: vi.fn() }), new NextRequest(`https://axiom.test${path}`));
      expect(response?.status).toBe(401);
    },
  );

  it("lets an Polymath companion bearer reach the route, which verifies it", async () => {
    const check = vi.fn();
    const response = await runProxy(
      Object.assign(check, { protect: vi.fn() }),
      new NextRequest("https://axiom.test/api/v1/captures", {
        headers: { authorization: "Bearer axm_test" },
      }),
    );
    expect(check).not.toHaveBeenCalled();
    expect(response).toBeUndefined();
  });

  it("answers a CORS preflight without requiring credentials", async () => {
    const check = vi.fn();
    const response = await runProxy(
      Object.assign(check, { protect: vi.fn() }),
      new NextRequest("https://axiom.test/api/v1/captures", { method: "OPTIONS" }),
    );
    expect(check).not.toHaveBeenCalled();
    expect(response).toBeUndefined();
  });

  it.each(["/polymath", "/polymath/knowledge", "/reviews", "/api/v10/runs", "/api/runs/id/events"])(
    "keeps %s session-only rather than allowing a machine token to render workspace UI", async (path) => {
      // Page requests no longer call protect(); they accept only session
      // tokens through auth({ acceptsToken }) and the route's own layout is
      // the default-deny second line.
      const check = vi.fn().mockResolvedValue({ isAuthenticated: true });
      await runProxy(Object.assign(check, { protect: vi.fn() }), new NextRequest(`https://axiom.test${path}`));
      expect(check).toHaveBeenCalledExactlyOnceWith({ acceptsToken: ["session_token"] });
    },
  );

  it.each(["/polymath", "/reviews"])("redirects a signed-out page visitor to the landing page on %s", async (path) => {
    const check = vi.fn().mockResolvedValue({ isAuthenticated: false });
    const response = await runProxy(Object.assign(check, { protect: vi.fn() }), new NextRequest(`https://axiom.test${path}`));
    expect(response?.status).toBe(307);
    // The destination survives the hop: returnTo carries the path so landing
    // can hand it to sign-in.
    expect(response?.headers.get("location")).toBe(`https://axiom.test/landing?returnTo=${encodeURIComponent(path)}`);
  });

  // The protocol-relative returnTo cases moved to
  // tests/unit/proxy-redirect-chain.test.ts: since QA F8 an unmatched path
  // gets the 404 rewrite rather than a landing redirect, which also cannot
  // echo a non-same-origin path into returnTo.
  it.each(["/sign-in", "/sign-up", "/api/webhooks/provider"])("leaves %s to its public or signature-verification boundary", async (path) => {
    const protect = vi.fn();
    await runProxy(Object.assign(vi.fn(), { protect }), new NextRequest(`https://axiom.test${path}`));
    expect(protect).not.toHaveBeenCalled();
  });
});
