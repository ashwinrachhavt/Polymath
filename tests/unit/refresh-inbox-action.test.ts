import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Regression pin for the CI-caught missing-authorization regression:
 * refreshInbox shipped without a role guard and the authorization sweep
 * failed it. Beyond the guard, the action's side effects must stay
 * tenant-scoped: it may invalidate only the CALLER'S OWN workspace captures
 * tag and the inbox path - never another workspace's cache, never a write.
 */

const getAuthContext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>();
  return { ...original, getAuthContext };
});

const requireRole = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/guards", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth/guards")>();
  return { ...original, requireRole };
});

const cache = vi.hoisted(() => ({ updateTag: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("next/cache", () => cache);

import { refreshInbox } from "@/components/shell/shell-actions";
import { capturesTag } from "@/lib/cache-tags";

const viewerAuth = { userId: "u-viewer", workspaceId: "w-own", role: "viewer" as const };

beforeEach(() => {
  vi.clearAllMocks();
  getAuthContext.mockResolvedValue(viewerAuth);
});

describe("refreshInbox", () => {
  it("passes the viewer guard with the caller's auth", async () => {
    await refreshInbox();
    expect(requireRole).toHaveBeenCalledWith(viewerAuth, "viewer");
  });

  it("invalidates only the caller's own workspace tag and the inbox path", async () => {
    await refreshInbox();
    expect(cache.updateTag).toHaveBeenCalledTimes(1);
    expect(cache.updateTag).toHaveBeenCalledWith(capturesTag(viewerAuth));
    expect(cache.updateTag.mock.calls[0][0]).toBe("captures:w-own");
    expect(cache.revalidatePath).toHaveBeenCalledTimes(1);
    expect(cache.revalidatePath).toHaveBeenCalledWith("/command-center/inbox");
  });
});
