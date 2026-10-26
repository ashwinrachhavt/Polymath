import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { actionAttempts, actionProposals, actionRevisions, actionReviews } from "@/domains/actions/schema";
import { auditEvents } from "@/domains/audit/schema";
import { externalAccounts } from "@/domains/integrations/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Revoking a connected account is the owner's stop button. What it must do:
 *
 *  1. flip the row to `revoked`, bump its version, and write an audit row;
 *  2. make `resolveConnectedAccount` answer `not_connected` from then on;
 *  3. refuse a caller holding a stale version;
 *  4. be idempotent - revoking twice is a success, not a failure;
 *  5. refuse a row that is still `connecting`;
 *  6. keep the row, and never call Composio to revoke remotely.
 *
 * The executor's own enforcement is proven in effect-executor.test.ts ("refuses
 * a revoked account before any provider call"); this file proves the command
 * side that test's seed stands in for.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let executor: typeof import("@/domains/actions/executor");
// Imported after makeTestDb points DATABASE_URL at the scratch database: the
// domain modules read it once at load, so a static import would connect to the
// developer's default URL.
let commands: typeof import("@/domains/integrations/commands");
let queries: typeof import("@/domains/integrations/queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  process.env.COMPOSIO_API_KEY = "test-composio-key";
  executor = await import("@/domains/actions/executor");
  commands = await import("@/domains/integrations/commands");
  queries = await import("@/domains/integrations/queries");
});

afterAll(async () => {
  delete process.env.COMPOSIO_API_KEY;
  await handle?.client.end();
});

let counter = 0;

async function seedAccount(options: { status?: "active" | "connecting" }) {
  counter += 1;
  const { userId, workspaceId } = await seedWorkspace(db, `revoke-${Date.now()}-${counter}`);
  const auth = ownerAuth(userId, workspaceId);
  const [account] = await db
    .insert(externalAccounts)
    .values({
      workspaceId,
      provider: "gmail",
        accessTier: "read_send",
      alias: `revoke-gmail-${counter}`,
      status: options.status ?? "active",
      composioConnectedAccountId: options.status === "connecting" ? null : `ca_${crypto.randomUUID()}`,
      createdBy: userId,
      updatedBy: userId,
    })
    .returning();
  return { auth, account, workspaceId, userId };
}

suite("revokeConnectedAccount (real Postgres)", () => {
  it("flips the status, bumps the version, and writes the audit row", async () => {
    const { auth, account } = await seedAccount({});

    const result = await commands.revokeConnectedAccount(auth, {
      accountId: account.id,
      expectedVersion: account.version,
    });
    expect(result).toMatchObject({ revoked: true, version: account.version + 1 });

    const [row] = await db.select().from(externalAccounts).where(eq(externalAccounts.id, account.id));
    expect(row.status).toBe("revoked");
    expect(row.version).toBe(account.version + 1);
    // Revocation is a lifecycle state: the row is kept.
    expect(row.id).toBe(account.id);

    const audits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "integration.account_revoked"),
          eq(auditEvents.subjectId, account.id),
        ),
      );
    expect(audits).toHaveLength(1);
  });

  it("makes resolveConnectedAccount answer not_connected", async () => {
    const { auth, account } = await seedAccount({});
    expect((await queries.resolveConnectedAccount(auth, "gmail", account.alias)).ok).toBe(true);

    await commands.revokeConnectedAccount(auth, { accountId: account.id, expectedVersion: account.version });

    const resolved = await queries.resolveConnectedAccount(auth, "gmail", account.alias);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("unreachable");
    expect(resolved.code).toBe("not_connected");

    // And the un-aliased inference does not fall back to it either.
    const inferred = await queries.resolveConnectedAccount(auth, "gmail");
    expect(inferred.ok).toBe(false);
  });

  it("throws StaleWriteError for a stale version", async () => {
    const { auth, account } = await seedAccount({});

    // Never a silent overwrite: a caller holding a version other than the
    // row's current one is refused, whatever the row's status happens to be.
    await expect(
      commands.revokeConnectedAccount(auth, { accountId: account.id, expectedVersion: account.version + 3 }),
    ).rejects.toBeInstanceOf(commands.StaleWriteError);

    // A row changed out of band after the caller loaded it.
    await db
      .update(externalAccounts)
      .set({ status: "expired", version: sql`${externalAccounts.version} + 1` })
      .where(eq(externalAccounts.id, account.id));
    await expect(
      commands.revokeConnectedAccount(auth, { accountId: account.id, expectedVersion: account.version }),
    ).rejects.toBeInstanceOf(commands.StaleWriteError);

    const [row] = await db.select().from(externalAccounts).where(eq(externalAccounts.id, account.id));
    expect(row.status).toBe("expired");
  });

  it("is idempotent on an already-revoked row", async () => {
    const { auth, account } = await seedAccount({});
    const first = await commands.revokeConnectedAccount(auth, {
      accountId: account.id,
      expectedVersion: account.version,
    });
    const second = await commands.revokeConnectedAccount(auth, {
      accountId: account.id,
      expectedVersion: first.version,
    });
    expect(second.revoked).toBe(false);
    expect(second.version).toBe(first.version);

    const [row] = await db.select().from(externalAccounts).where(eq(externalAccounts.id, account.id));
    expect(row.status).toBe("revoked");
    // Exactly one audit row: idempotency must not log a second revoke.
    const audits = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "integration.account_revoked"),
          eq(auditEvents.subjectId, account.id),
        ),
      );
    expect(audits).toHaveLength(1);
  });

  it("refuses a connecting row", async () => {
    const { auth, account } = await seedAccount({ status: "connecting" });
    await expect(
      commands.revokeConnectedAccount(auth, { accountId: account.id, expectedVersion: account.version }),
    ).rejects.toBeInstanceOf(commands.ConflictError);

    const [row] = await db.select().from(externalAccounts).where(eq(externalAccounts.id, account.id));
    expect(row.status).toBe("connecting");
  });

  it("never calls Composio to revoke remotely", async () => {
    const { auth, account } = await seedAccount({});
    const spy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", spy);
    try {
      await commands.revokeConnectedAccount(auth, { accountId: account.id, expectedVersion: account.version });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an executor run against the revoked account makes no provider call", async () => {
    const { auth, account, workspaceId, userId } = await seedAccount({});

    const [proposal] = await db
      .insert(actionProposals)
      .values({
        workspaceId,
        capability: "gmail.send",
        riskClass: "external_write",
        status: "approved",
        accountAlias: account.alias,
        title: "Send email to ada@example.test",
        expectedEffect: "Sends a message.",
        dedupeKey: `revoke-exec:${proposalSlug()}`,
        decidedAt: new Date(),
        decidedBy: userId,
      })
      .returning();
    const [revision] = await db
      .insert(actionRevisions)
      .values({
        workspaceId,
        proposalId: proposal.id,
        revisionNumber: 1,
        payload: { to: "ada@example.test", subject: "Hi", body: "Hello", inReplyTo: null },
        createdBy: userId,
      })
      .returning();
    await db.insert(actionReviews).values({
      workspaceId,
      proposalId: proposal.id,
      revisionId: revision.id,
      decision: "approved",
      reviewedBy: userId,
    });

    await commands.revokeConnectedAccount(auth, { accountId: account.id, expectedVersion: account.version });

    const spy = vi.fn(async () => new Response(JSON.stringify({ data: { id: "msg_1" } }), { status: 200 }));
    vi.stubGlobal("fetch", spy);
    try {
      await expect(
        executor.executeApprovedEffect(auth, { proposalId: proposal.id }),
      ).rejects.toBeInstanceOf(executor.SendNotAllowedError);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }

    // No attempt was claimed: nothing was sent, so there is nothing to reconcile.
    const attempts = await db
      .select()
      .from(actionAttempts)
      .where(eq(actionAttempts.proposalId, proposal.id));
    expect(attempts).toHaveLength(0);
  });
});

let slugCounter = 0;
function proposalSlug() {
  slugCounter += 1;
  return `${Date.now()}-${slugCounter}`;
}
