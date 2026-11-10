import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Value: protects=the autocomplete route's contract with the editor: a suggestion, or an empty one on a
 * provider failure, and 503/429 telling the editor to stop asking; session-only and member-or-above;
 * fails_when=a provider error surfaces as a 500, an API key or a viewer can spend the allowance, or
 * the per-person brake stops applying; why_new=the route is new; seam=none; no_claim=the model call
 * (completeWriting mocked)
 */

const holder = vi.hoisted(() => ({
  auth: undefined as undefined | { userId: string; workspaceId: string; role: string; scopes?: string[] },
}));
vi.mock("@/lib/clerk", () => ({ clerkConfigured: true, devAuthBypass: false }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ isAuthenticated: true, userId: "clerk_test" })),
}));
vi.mock("@/domains/identity/resolve", () => ({ resolveAuthContext: vi.fn(async () => holder.auth) }));
const completeWriting = vi.hoisted(() => vi.fn());
vi.mock("@/domains/knowledge/writing-completion", () => ({ completeWriting }));

import { POST } from "@/app/api/v1/notes/complete/route";
import { GenerationUnconfiguredError } from "@/integrations/generation/provider";
import { QuotaExhaustedError } from "@/integrations/providers/quota";

let seq = 0;
const call = (body: unknown) =>
  POST(
    new Request("https://axiom.dev/api/v1/notes/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    undefined,
  );

beforeEach(() => {
  completeWriting.mockReset();
  completeWriting.mockResolvedValue({ completion: " be atomic.", answered: true });
  // A fresh person per test, so the per-person brake starts empty.
  holder.auth = { userId: `u-${++seq}`, workspaceId: "w1", role: "member" };
});

describe("POST /api/v1/notes/complete", () => {
  it("returns the suggestion", async () => {
    const res = await call({ title: "Method", before: "Evergreen notes should", after: "" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ completion: " be atomic." });
    expect(completeWriting.mock.calls[0][1]).toEqual({ title: "Method", before: "Evergreen notes should", after: "" });
  });

  it("answers 422 without the text before the cursor", async () => {
    expect((await call({ after: "x" })).status).toBe(422);
    expect(completeWriting).not.toHaveBeenCalled();
  });

  it("tells the editor to stop asking when no provider is configured or the allowance is spent", async () => {
    completeWriting.mockRejectedValueOnce(new GenerationUnconfiguredError());
    expect((await call({ before: "Evergreen notes should" })).status).toBe(503);
    completeWriting.mockRejectedValueOnce(new QuotaExhaustedError("mercury", "lifetime", 1));
    const spent = await call({ before: "Evergreen notes should" });
    expect(spent.status).toBe(429);
    expect((await spent.json()).code).toBe("quota_exhausted");
  });

  it("answers an empty suggestion, not an error, when the provider fails, marked as no answer", async () => {
    completeWriting.mockRejectedValueOnce(new Error("upstream timed out"));
    const res = await call({ before: "Evergreen notes should" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ completion: "", answered: false });
  });

  it("marks a model that replied with no text as no answer", async () => {
    completeWriting.mockResolvedValueOnce({ completion: "", answered: false });
    expect(await (await call({ before: "Evergreen notes should" })).json()).toEqual({
      completion: "",
      answered: false,
    });
  });

  it("refuses viewers and API keys before any model call", async () => {
    holder.auth = { userId: "u-viewer", workspaceId: "w1", role: "viewer" };
    expect((await call({ before: "Evergreen notes should" })).status).toBe(403);
    holder.auth = { userId: "u-key", workspaceId: "w1", role: "member", scopes: ["captures:write"] };
    expect((await call({ before: "Evergreen notes should" })).status).toBe(403);
    expect(completeWriting).not.toHaveBeenCalled();
  });

  it("brakes one person past 40 requests a minute", async () => {
    for (let i = 0; i < 40; i++) expect((await call({ before: "Evergreen notes should" })).status).toBe(200);
    const limited = await call({ before: "Evergreen notes should" });
    expect(limited.status).toBe(429);
    expect((await limited.json()).code).toBe("rate_limited");
  });
});
