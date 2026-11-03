import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openInvitationsForEmail } from "@/domains/identity/invitations";
import { listSwitchableWorkspaces } from "@/domains/identity/resolve";
import { invitations, memberships, workspaces } from "@/domains/identity/schema";
import { makeTestDb, seedWorkspace, truncateAll } from "../helpers/test-workspace";

/*
 * The workspace switcher's server reads (spec D2), against real Postgres:
 * listSwitchableWorkspaces lists exactly what resolution may select among —
 * active memberships in unarchived workspaces, oldest first — and
 * openInvitationsForEmail returns only open invitations addressed to the
 * email (mixed case normalized, accepted/revoked/expired/archived excluded).
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof import("drizzle-orm/postgres-js").drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

beforeAll(async () => {
  holder.db = handle?.db;
});
afterAll(async () => {
  await handle?.client.end();
});

suite("listSwitchableWorkspaces (spec D2)", () => {
  it("lists only active memberships in unarchived workspaces, oldest first", async () => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `swr-${crypto.randomUUID()}`);

    const [second] = await holder
      .db!.insert(workspaces)
      .values({ name: "Acme", slug: `acme-${crypto.randomUUID()}`, isPersonal: false })
      .returning();
    await holder
      .db!.insert(memberships)
      .values({ workspaceId: second.id, userId: seed.userId, role: "member", status: "active" });

    const [suspended] = await holder
      .db!.insert(workspaces)
      .values({ name: "Suspended", slug: `sus-${crypto.randomUUID()}`, isPersonal: false })
      .returning();
    await holder
      .db!.insert(memberships)
      .values({ workspaceId: suspended.id, userId: seed.userId, role: "admin", status: "suspended" });

    const [archived] = await holder
      .db!.insert(workspaces)
      .values({ name: "Archived", slug: `arch-${crypto.randomUUID()}`, isPersonal: false, archivedAt: new Date() })
      .returning();
    await holder
      .db!.insert(memberships)
      .values({ workspaceId: archived.id, userId: seed.userId, role: "owner", status: "active" });

    const rows = await listSwitchableWorkspaces(seed.userId);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      workspaceId: seed.workspaceId,
      role: "owner",
      isPersonal: true,
      slug: expect.stringContaining("swr-"),
    });
    expect(rows[1]).toMatchObject({ workspaceId: second.id, name: "Acme", role: "member", isPersonal: false });
  });
});

suite("openInvitationsForEmail (spec D2)", () => {
  it("returns only open, unexpired invitations addressed to the email", async () => {
    await truncateAll(handle!.client);
    const seed = await seedWorkspace(holder.db!, `swr-${crypto.randomUUID()}`);
    const future = new Date(Date.now() + 3600_000);
    await holder.db!.insert(invitations).values([
      {
        workspaceId: seed.workspaceId,
        email: "join@polymath.test",
        role: "member",
        tokenHash: `hash-open-${crypto.randomUUID()}`,
        expiresAt: future,
      },
      {
        workspaceId: seed.workspaceId,
        email: "join@polymath.test",
        role: "admin",
        tokenHash: `hash-accepted-${crypto.randomUUID()}`,
        expiresAt: future,
        acceptedAt: new Date(),
      },
      {
        workspaceId: seed.workspaceId,
        email: "join@polymath.test",
        role: "viewer",
        tokenHash: `hash-revoked-${crypto.randomUUID()}`,
        expiresAt: future,
        revokedAt: new Date(),
      },
      {
        workspaceId: seed.workspaceId,
        email: "other@polymath.test",
        role: "viewer",
        tokenHash: `hash-other-${crypto.randomUUID()}`,
        expiresAt: future,
      },
    ]);
    // An expired invitation and an open one in an archived workspace live in
    // their own workspaces: the pending partial-unique index permits one open
    // row per (workspace, email).
    const [expiredIn] = await holder
      .db!.insert(workspaces)
      .values({ name: "Expired", slug: `exp-${crypto.randomUUID()}`, isPersonal: false })
      .returning();
    await holder.db!.insert(invitations).values({
      workspaceId: expiredIn.id,
      email: "join@polymath.test",
      role: "member",
      tokenHash: `hash-expired-${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() - 1000),
    });
    const [archivedIn] = await holder
      .db!.insert(workspaces)
      .values({ name: "Archived", slug: `arch-${crypto.randomUUID()}`, isPersonal: false, archivedAt: new Date() })
      .returning();
    await holder.db!.insert(invitations).values({
      workspaceId: archivedIn.id,
      email: "join@polymath.test",
      role: "member",
      tokenHash: `hash-archived-${crypto.randomUUID()}`,
      expiresAt: future,
    });

    // Mixed case on the way in: the query normalizes like every writer did.
    const rows = await openInvitationsForEmail("Join@Polymath.TEST");

    expect(rows).toEqual([
      { workspaceId: seed.workspaceId, workspaceName: expect.stringContaining("swr-"), role: "member" },
    ]);
  });

  it("answers an empty email with no rows", async () => {
    expect(await openInvitationsForEmail("")).toEqual([]);
  });
});
