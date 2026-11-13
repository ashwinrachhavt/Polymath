import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The auth layer's half of invite-only: an unlisted Clerk user is refused
 * before resolveAuthContext runs, because that is where a first sign-in
 * provisions a user row and a Personal workspace.
 */
const resolveAuthContext = vi.fn(async () => ({ userId: "u", workspaceId: "w", role: "owner" }));
vi.mock("@/domains/identity/resolve", () => ({ resolveAuthContext }));
vi.mock("@/domains/identity/machine", () => ({ resolveMachineClient: vi.fn() }));
vi.mock("next/cache", () => ({ io: vi.fn(async () => {}) }));
vi.mock("@/lib/clerk", () => ({ clerkConfigured: true, devAuthBypass: false, proxyArmed: true }));
vi.mock("@/lib/access-allowlist", () => ({ isClerkUserAllowed: vi.fn(async (id: string) => id === "user_owner") }));

let userId = "user_stranger";
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async (options?: { acceptsToken?: string[] }) =>
    options?.acceptsToken ? { isAuthenticated: true, userId, tokenType: "session_token" } : { userId },
  ),
}));

type AuthModule = typeof import("@/lib/auth");
let auth: AuthModule;

beforeEach(async () => {
  vi.resetModules();
  resolveAuthContext.mockClear();
  auth = await import("@/lib/auth");
});

describe("invite-only in the auth layer", () => {
  it("refuses an unlisted session before anything is provisioned", async () => {
    userId = "user_stranger";
    await expect(auth.getAuthContext()).rejects.toBeInstanceOf(auth.ForbiddenError);
    expect(resolveAuthContext).not.toHaveBeenCalled();
  });

  it("refuses an unlisted session on API routes too", async () => {
    userId = "user_stranger";
    await expect(auth.getAnyAuthContext(new Request("https://axiom.test/api/v1/x"))).rejects.toBeInstanceOf(
      auth.ForbiddenError,
    );
    expect(resolveAuthContext).not.toHaveBeenCalled();
  });

  it("resolves a listed session as before", async () => {
    userId = "user_owner";
    await expect(auth.getAuthContext()).resolves.toMatchObject({ workspaceId: "w" });
    expect(resolveAuthContext).toHaveBeenCalledWith("user_owner");
  });
});
