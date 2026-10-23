import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentProfiles } from "@/domains/agents/schema";
import { makeTestDb, seedWorkspace, truncateAll } from "../helpers/test-workspace";

/*
 * Role contract for the assistant-brief server actions (ASH-220 review): the
 * brief is written by onboarding into the person's own workspace and carries
 * personal working/writing preferences; no pre-existing policy grants members
 * or viewers a raw-brief read, so both the read and the write sit at owner
 * scope until the owner decides otherwise. Tenant scoping
 * is by the caller's own workspace, so no role can read another
 * workspace's profile at all.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
const authHolder: { ctx: { userId: string; workspaceId: string; role: "owner" | "member" | "viewer" } } = {
  ctx: { userId: "none", workspaceId: "none", role: "owner" },
};
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/auth", () => ({ getAuthContext: vi.fn(async () => authHolder.ctx) }));
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

import { loadAssistantProfileAction, saveAssistantProfileAction } from "@/app/(workspace)/settings/actions";

beforeAll(async () => { holder.db = handle?.db; });
afterAll(async () => { await handle?.client.end(); });

suite("assistant-brief action authorization", () => {
  it.each(["viewer", "member"] as const)("rejects %s on both the read and the write", async (role) => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `briefauth-${crypto.randomUUID()}`);
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role };
    const load = await loadAssistantProfileAction();
    expect(load.ok).toBe(false);
    if (!load.ok) expect(load.error).toMatch(/owner/i);
    const save = await saveAssistantProfileAction({ description: "x", instructions: "y", expectedVersion: 0 });
    expect(save.ok).toBe(false);
    if (!save.ok) expect(save.error).toMatch(/owner/i);
  });

  it("lets the owner read and write their own workspace's profile", async () => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `briefauth-${crypto.randomUUID()}`);
    await holder.db!.insert(agentProfiles).values({
      workspaceId: seed.workspaceId, name: "Polymath", description: "d", instructions: "i",
      isDefault: true, createdBy: seed.userId, updatedBy: seed.userId,
    });
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "owner" };
    const load = await loadAssistantProfileAction();
    expect(load.ok).toBe(true);
    if (load.ok) expect(load.profile?.name).toBe("Polymath");
    const save = await saveAssistantProfileAction({ instructions: "shorter replies", expectedVersion: load.ok ? (load.profile?.version ?? 0) : 0 });
    expect(save.ok).toBe(true);
  });

  it("never returns another workspace's profile: the read is scoped to the caller's own tenant", async () => {
    await truncateAll(handle!.client);
    const a = await seedWorkspace(holder.db!, `briefauth-${crypto.randomUUID()}`);
    const b = await seedWorkspace(holder.db!, `briefauth-${crypto.randomUUID()}`);
    await holder.db!.insert(agentProfiles).values({
      workspaceId: b.workspaceId, name: "Polymath", description: "b only", instructions: "b only",
      isDefault: true, createdBy: b.userId, updatedBy: b.userId,
    });
    authHolder.ctx = { userId: a.userId, workspaceId: a.workspaceId, role: "owner" };
    const seen = await loadAssistantProfileAction();
    expect(seen.ok).toBe(true);
    if (seen.ok) expect(seen.profile).toBeNull();
  });
});
