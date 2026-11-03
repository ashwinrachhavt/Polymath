import { revalidatePath, updateTag } from "next/cache";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { memberships } from "@/domains/identity/schema";
import { makeTestDb, seedWorkspace, truncateAll } from "../helpers/test-workspace";

/*
 * switchWorkspaceAction (tenancy activation, spec D1): any active member may
 * switch to a workspace it belongs to — the action re-proves the membership
 * in the database, moves the per-device cookie, and flushes the shell for
 * the new context; a workspace the caller does not belong to is refused
 * without touching the cookie or the cache.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof import("drizzle-orm/postgres-js").drizzle> | undefined } = { db: undefined };
const authHolder: {
  ctx: { userId: string; workspaceId: string; role: "owner" | "admin" | "member" | "viewer" } | null;
} = {
  ctx: { userId: "none", workspaceId: "none", role: "owner" },
};
const writeCookie = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthContext: vi.fn(async () => authHolder.ctx) }));
vi.mock("@/lib/active-workspace", () => ({ writeActiveWorkspaceCookie: writeCookie }));
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

import { switchWorkspaceAction } from "@/app/(workspace)/settings/workspaces/actions";

beforeAll(async () => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

suite("switch workspace action (spec D1)", () => {
  it("switches a member of the workspace: cookie written, new-context tags bumped, layout revalidated", async () => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `sw-${crypto.randomUUID()}`);
    const target = await seedWorkspace(holder.db!, `sw-${crypto.randomUUID()}`);
    await holder.db!.insert(memberships).values({
      workspaceId: target.workspaceId,
      userId: seed.userId,
      role: "member",
      status: "active",
    });
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "owner" };

    const result = await switchWorkspaceAction({ workspaceId: target.workspaceId });

    expect(result).toMatchObject({ ok: true, workspaceId: target.workspaceId });
    expect(writeCookie).toHaveBeenCalledWith(target.workspaceId);
    expect(updateTag).toHaveBeenCalledWith(expect.stringContaining(target.workspaceId));
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("refuses a workspace the caller does not belong to and writes nothing", async () => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `sw-${crypto.randomUUID()}`);
    const foreign = await seedWorkspace(holder.db!, `sw-${crypto.randomUUID()}`);
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "owner" };

    const result = await switchWorkspaceAction({ workspaceId: foreign.workspaceId });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a member/i);
    expect(writeCookie).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller with the authored error", async () => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `sw-${crypto.randomUUID()}`);
    authHolder.ctx = null;

    const result = await switchWorkspaceAction({ workspaceId: seed.workspaceId });

    expect(result.ok).toBe(false);
    expect(writeCookie).not.toHaveBeenCalled();
  });
});
