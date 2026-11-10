import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Value: protects=quick capture saves the words even when its context is malformed, and forwards
 * a valid context; fails_when=a bad context throws or blocks the save, or a valid one is dropped;
 * why_new=the schema and createCapture are tested, the action's safeParse branch is not;
 * seam=none; no_claim=storage (createCapture mocked; unit only)
 */

const getAuthContext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>();
  return { ...original, getAuthContext };
});
vi.mock("@/lib/auth/guards", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth/guards")>();
  return { ...original, requireRole: vi.fn() };
});
vi.mock("next/cache", () => ({ updateTag: vi.fn(), revalidatePath: vi.fn() }));
const createCapture = vi.hoisted(() => vi.fn());
vi.mock("@/domains/capture/commands", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/domains/capture/commands")>();
  return { ...original, createCapture };
});

import { quickCapture } from "@/components/shell/shell-actions";

const auth = { userId: "u1", workspaceId: "w1", role: "member" as const };

beforeEach(() => {
  vi.clearAllMocks();
  getAuthContext.mockResolvedValue(auth);
  createCapture.mockResolvedValue({ id: "c1" });
});

describe("quickCapture context", () => {
  it("forwards a valid context with the words", async () => {
    const context = { passage: "kept words", why: { kind: "unknown" } };
    const result = await quickCapture("kept words", "11111111-1111-4111-8111-111111111111", context);
    expect(result.ok).toBe(true);
    expect(createCapture).toHaveBeenCalledWith(auth, expect.objectContaining({ text: "kept words", context }));
  });

  it("still saves the words when the context is malformed, without it", async () => {
    const result = await quickCapture("just words", "22222222-2222-4222-8222-222222222222", {
      why: { kind: "answer", text: "x".repeat(5_000), via: "voice" },
    });
    expect(result.ok).toBe(true);
    expect(createCapture).toHaveBeenCalledTimes(1);
    expect(createCapture.mock.calls[0][1].context).toBeUndefined();
  });

  it("captures with no context exactly as before", async () => {
    await quickCapture("plain", "33333333-3333-4333-8333-333333333333");
    expect(createCapture.mock.calls[0][1].context).toBeUndefined();
  });
});
