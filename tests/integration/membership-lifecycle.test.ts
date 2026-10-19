import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memberships, users } from "@/domains/identity/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-121 AC02 against real Postgres: invitations are single-use, expiring,
 * revocable and email-bound; acceptance needs a verified email; the last
 * active owner survives concurrent demotion.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let lifecycle: typeof import("@/domains/identity/invitations");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  lifecycle = await import("@/domains/identity/invitations");
});

afterAll(async () => {
  await handle?.client.end();
});

async function newUser(tag: string) {
  const [u] = await db.insert(users).values({ clerkUserId: `inv_${tag}_${crypto.randomUUID()}` }).returning();
  return u.id;
}

suite("membership lifecycle", () => {
  it("accepts once, binds to the verified email, and replays safely for the same user", async () => {
    const seeded = await seedWorkspace(db, `inv-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const invite = await lifecycle.createInvitation(auth, { email: "Dad@Example.com", role: "member" });
    const invitee = await newUser("a");

    await expect(lifecycle.acceptInvitation({ token: invite.token, userId: invitee, verifiedEmail: null })).rejects.toMatchObject({ code: "invitation_invalid" });
    await expect(lifecycle.acceptInvitation({ token: invite.token, userId: invitee, verifiedEmail: "other@example.com" })).rejects.toMatchObject({ code: "invitation_invalid" });

    const accepted = await lifecycle.acceptInvitation({ token: invite.token, userId: invitee, verifiedEmail: "dad@example.com" });
    expect(accepted).toMatchObject({ workspaceId: seeded.workspaceId, role: "member", replayed: false });
    const replay = await lifecycle.acceptInvitation({ token: invite.token, userId: invitee, verifiedEmail: "dad@example.com" });
    expect(replay).toMatchObject({ membershipId: accepted.membershipId, replayed: true });

    const stranger = await newUser("b");
    await expect(lifecycle.acceptInvitation({ token: invite.token, userId: stranger, verifiedEmail: "dad@example.com" })).rejects.toMatchObject({ code: "invitation_invalid" });
  });

  it("revoked and expired invitations fail; one pending invite per address", async () => {
    const seeded = await seedWorkspace(db, `invr-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const first = await lifecycle.createInvitation(auth, { email: "x@example.com" });
    await expect(lifecycle.createInvitation(auth, { email: "x@example.com" })).rejects.toMatchObject({ code: "invitation_exists" });
    expect(await lifecycle.revokeInvitation(auth, first.invitationId)).toEqual({ revoked: true });
    const user = await newUser("c");
    await expect(lifecycle.acceptInvitation({ token: first.token, userId: user, verifiedEmail: "x@example.com" })).rejects.toMatchObject({ code: "invitation_invalid" });

    const second = await lifecycle.createInvitation(auth, { email: "x@example.com", ttlHours: 1 });
    await db.execute(sql`update invitations set expires_at = now() - interval '1 minute' where id = ${second.invitationId}`);
    await expect(lifecycle.acceptInvitation({ token: second.token, userId: user, verifiedEmail: "x@example.com" })).rejects.toMatchObject({ code: "invitation_invalid" });
    // An expired pending invite does not block re-inviting.
    await expect(lifecycle.createInvitation(auth, { email: "x@example.com" })).resolves.toBeTruthy();
  });

  it("never lets the last active owner be demoted, suspended or removed, even concurrently", async () => {
    const seeded = await seedWorkspace(db, `invo-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const [mine] = await db.select().from(memberships).where(eq(memberships.userId, seeded.userId));
    await expect(lifecycle.changeMembership(auth, { membershipId: mine.id, role: "admin" })).rejects.toMatchObject({ code: "last_owner" });
    await expect(lifecycle.changeMembership(auth, { membershipId: mine.id, status: "suspended" })).rejects.toMatchObject({ code: "last_owner" });

    const second = await newUser("d");
    const [other] = await db.insert(memberships).values({ workspaceId: seeded.workspaceId, userId: second, role: "owner", status: "active" }).returning();
    const results = await Promise.allSettled([
      lifecycle.changeMembership(auth, { membershipId: mine.id, status: "removed" }),
      lifecycle.changeMembership(auth, { membershipId: other.id, status: "removed" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});
