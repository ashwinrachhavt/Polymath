import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import proxy from "@/proxy";

vi.mock("@/lib/clerk", () => ({ clerkConfigured: true }));
vi.mock("@clerk/nextjs/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("@clerk/nextjs/server")>(),
  clerkMiddleware: (handler: unknown) => handler,
}));

const runProxy = proxy as unknown as (
  auth: { protect: ReturnType<typeof vi.fn> }, request: NextRequest,
) => Promise<void>;

describe("Clerk proxy token boundary", () => {
  it.each(["/api/v1", "/api/v1/runs", "/api/v1/files", "/api/v1/documents/id/extract"])(
    "accepts only the API guard's supported token types on %s", async (path) => {
      const protect = vi.fn();
      await runProxy({ protect }, new NextRequest(`https://axiom.test${path}`));
      expect(protect).toHaveBeenCalledExactlyOnceWith({ token: ["session_token", "m2m_token", "api_key"] });
    },
  );

  it.each(["/alfred", "/alfred/knowledge", "/reviews", "/api/v10/runs", "/api/runs/id/events"])(
    "keeps %s session-only rather than allowing a machine token to render workspace UI", async (path) => {
      const protect = vi.fn();
      await runProxy({ protect }, new NextRequest(`https://axiom.test${path}`));
      expect(protect).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it.each(["/sign-in", "/sign-up", "/api/webhooks/provider"])("leaves %s to its public or signature-verification boundary", async (path) => {
    const protect = vi.fn();
    await runProxy({ protect }, new NextRequest(`https://axiom.test${path}`));
    expect(protect).not.toHaveBeenCalled();
  });
});
