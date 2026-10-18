import { describe, expect, it, vi } from "vitest";

vi.mock("@/domains/identity/resolve", () => ({
  resolveAuthContext: vi.fn(async () => ({ userId: "u", workspaceId: "w", role: "owner" })),
}));
vi.mock("@/domains/identity/machine", () => ({
  resolveMachineClient: vi.fn(async (subject: string) =>
    subject === "mch_good"
      ? { ok: true, client: { clientId: "c1", workspaceId: "w-machine", role: "owner" } }
      : { ok: false as const, reason: subject === "mch_rate" ? "rate_limited" : "not_found" },
  ),
}));

/*
 * auth({acceptsToken: "any"}) returns the session auth object in this app's
 * usage; the machine path is exercised through the mocked resolveMachineClient
 * by driving getAnyAuthContext with an unauthenticated session plus a machine
 * resolvable subject — here, simulated by userId holding the subject.
 */
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async (options?: { acceptsToken?: string }) => {
    if (options?.acceptsToken === "any") {
      // A machine subject carries no userId — that is the discriminator the
      // guard uses. Subjects starting with mch_ are m2m tokens.
      if (userId?.startsWith("mch_")) {
        return { isAuthenticated: true, machineId: userId, tokenType: "m2m_token" };
      }
      return userId
        ? { isAuthenticated: true, userId }
        : { isAuthenticated: false, userId: null };
    }
    return { userId };
  }),
}));

let userId: string | undefined;
import { authedHandler, getAuthContext, UnauthorizedError } from "@/lib/auth";

describe("auth guards", () => {
  it("authedHandler returns 401 problem+json when unauthenticated", async () => {
    userId = undefined;
    const handler = authedHandler(async () => new Response("ok"));
    const res = await handler(new Request("https://axiom.dev/api/v1/x"), undefined);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    const body = await res.json();
    expect(body.code).toBe("unauthorized");
  });

  it("authedHandler passes AuthContext through when authenticated", async () => {
    userId = "clerk_x";
    const handler = authedHandler(async (auth) => new Response(auth.workspaceId));
    const res = await handler(new Request("https://axiom.dev/api/v1/x"), undefined);
    expect(await res.text()).toBe("w");
  });

  it("authedHandler maps a machine subject to its api_client workspace", async () => {
    userId = "mch_good";
    const handler = authedHandler(async (auth) => new Response(auth.workspaceId));
    const res = await handler(new Request("https://axiom.dev/api/v1/x"), undefined);
    expect(await res.text()).toBe("w-machine");
  });

  it("authedHandler returns 429 problem+json when the client hits its ceiling", async () => {
    userId = "mch_rate";
    const handler = authedHandler(async () => new Response("ok"));
    const res = await handler(new Request("https://axiom.dev/api/v1/x"), undefined);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("rate_limited");
  });

  it("authedHandler returns 403 problem+json for a revoked or unknown client", async () => {
    userId = "mch_revoked";
    const handler = authedHandler(async () => new Response("ok"));
    const res = await handler(new Request("https://axiom.dev/api/v1/x"), undefined);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("forbidden");
  });

  it("getAuthContext throws UnauthorizedError when unauthenticated", async () => {
    userId = undefined;
    await expect(getAuthContext()).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
