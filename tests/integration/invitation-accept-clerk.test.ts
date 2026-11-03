import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { users } from "@/domains/identity/schema";
import { makeTestDb, seedWorkspace, truncateAll } from "../helpers/test-workspace";

/*
 * The Clerk branch of the acceptance route's session-email rule (spec D4):
 * with Clerk configured, the pending invitation's email must match the
 * primary email the provider has VERIFIED - never a self-asserted address,
 * and never an address read out of the local users row.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof import("drizzle-orm/postgres-js").drizzle> | undefined } = { db: undefined };
const authHolder: { ctx: { userId: string; workspaceId: string; role: "owner" | "member" } } = {
  ctx: { userId: "none", workspaceId: "none", role: "member" },
};
const clerkHolder: { user: unknown } = { user: null };

vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_placeholder");
vi.stubEnv("CLERK_SECRET_KEY", "sk_test_placeholder");
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({
  get currentUser() {
    return async () => clerkHolder.user;
  },
}));
vi.mock("@/lib/auth", () => ({ getAuthContext: vi.fn(async () => authHolder.ctx) }));
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

let acceptInvitationAction: typeof import("@/app/(workspace)/invitations/[token]/actions").acceptInvitationAction;
let createInvitationAction: typeof import("@/app/(workspace)/settings/actions").createInvitationAction;

beforeAll(async () => {
  holder.db = handle?.db;
  ({ acceptInvitationAction } = await import("@/app/(workspace)/invitations/[token]/actions"));
  ({ createInvitationAction } = await import("@/app/(workspace)/settings/actions"));
});
afterAll(async () => {
  await handle?.client.end();
});

const INVALID = "This invitation is not valid.";

function clerkUser(email: string, verified: boolean) {
  return {
    primaryEmailAddressId: "email_1",
    emailAddresses: [{ id: "email_1", emailAddress: email, verification: verified ? { status: "verified" } : null }],
  };
}

suite("invitation acceptance through a Clerk session", () => {
  it("accepts when the provider's verified primary email matches the invitation", async () => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `invclerk-${crypto.randomUUID()}`);
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "owner" };
    const created = await createInvitationAction({ email: "clerkuser@polymath.test" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const [joiner] = await holder
      .db!.insert(users)
      .values({ clerkUserId: `tw_${crypto.randomUUID()}` })
      .returning();
    authHolder.ctx = { userId: joiner.id, workspaceId: seed.workspaceId, role: "member" };
    clerkHolder.user = clerkUser("clerkuser@polymath.test", true);

    const result = await acceptInvitationAction(created.token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspaceId).toBe(seed.workspaceId);
  });

  it("refuses an unverified primary email even when the address matches", async () => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `invclerk-${crypto.randomUUID()}`);
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "owner" };
    const created = await createInvitationAction({ email: "unverified@polymath.test" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const [joiner] = await holder
      .db!.insert(users)
      .values({ clerkUserId: `tw_${crypto.randomUUID()}` })
      .returning();
    authHolder.ctx = { userId: joiner.id, workspaceId: seed.workspaceId, role: "member" };
    clerkHolder.user = clerkUser("unverified@polymath.test", false);

    const result = await acceptInvitationAction(created.token);
    expect(result).toEqual({ ok: false, error: INVALID });
  });

  it("refuses when there is no Clerk session user at all", async () => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `invclerk-${crypto.randomUUID()}`);
    authHolder.ctx = { userId: seed.userId, workspaceId: seed.workspaceId, role: "owner" };
    const created = await createInvitationAction({ email: "anyone@polymath.test" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    clerkHolder.user = null;

    const result = await acceptInvitationAction(created.token);
    expect(result).toEqual({ ok: false, error: INVALID });
  });
});
