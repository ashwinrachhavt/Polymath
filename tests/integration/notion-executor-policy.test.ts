import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { actionAttempts, actionPolicies, actionProposals, actionReviews, actionRevisions } from "@/domains/actions/schema";
import { externalAccounts } from "@/domains/integrations/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Executor account-pin enforcement for provider proposals: an approved write
 * must still refuse when its bound account is revoked, reconnected, never
 * bound, or its alias grant is tightened after approval - before any provider
 * call. Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

let db: NonNullable<typeof handle>["db"];
let notion: typeof import("@/domains/knowledge/notion-proposals");
let executor: typeof import("@/domains/actions/executor");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  process.env.COMPOSIO_API_KEY = "test-composio-key";
  notion = await import("@/domains/knowledge/notion-proposals");
  executor = await import("@/domains/actions/executor");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  delete process.env.COMPOSIO_API_KEY;
  await handle?.client.end();
});

const PAGE = "0123456789abcdef0123456789abcdef";

async function revisionOf(proposalId: string) {
  const [row] = await db.select().from(actionRevisions).where(eq(actionRevisions.proposalId, proposalId));
  return row;
}

suite("notion executor account-pin enforcement", () => {
  let counter = 0;

  async function seedApproved(options: { connected?: boolean } = {}) {
    counter += 1;
    const { userId, workspaceId } = await seedWorkspace(db, `notion-exec-${crypto.randomUUID().slice(0, 8)}-${counter}`);
    const auth = ownerAuth(userId, workspaceId);
    const alias = `notion-${counter}`;
    let account: typeof externalAccounts.$inferSelect | null = null;
    if (options.connected !== false) {
      [account] = await db
        .insert(externalAccounts)
        .values({ workspaceId, provider: "notion", alias, status: "active", composioConnectedAccountId: `ca_${crypto.randomUUID()}`, createdBy: userId, updatedBy: userId })
        .returning();
    }
    const proposed = await notion.proposeNotionPageUpdate(auth, {
      mode: "append",
      pageId: PAGE,
      title: "Log",
      markdown: "approved text",
      dedupeKey: `n-${crypto.randomUUID()}`,
    });
    const revision = await revisionOf(proposed.proposalId);
    await db.update(actionProposals).set({ status: "approved", decidedAt: new Date(), decidedBy: userId }).where(eq(actionProposals.id, proposed.proposalId));
    await db.insert(actionReviews).values({ workspaceId, proposalId: proposed.proposalId, revisionId: revision.id, decision: "approved", reviewedBy: userId });
    return { auth, workspaceId, userId, account, alias, proposalId: proposed.proposalId, revision };
  }

  function spyOnProvider() {
    const spy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  async function expectRefusedBeforeDispatch(seeded: { auth: ReturnType<typeof ownerAuth>; proposalId: string }, spy: ReturnType<typeof spyOnProvider>) {
    await expect(executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId })).rejects.toBeInstanceOf(executor.SendNotAllowedError);
    expect(spy).not.toHaveBeenCalled();
    expect(await db.select().from(actionAttempts).where(eq(actionAttempts.proposalId, seeded.proposalId))).toHaveLength(0);
  }

  it("refuses an approval written before a Notion account was bound to it", async () => {
    const seeded = await seedApproved({ connected: false });
    // Connecting afterwards must not retroactively bind the approved revision.
    await db.insert(externalAccounts).values({ workspaceId: seeded.workspaceId, provider: "notion", alias: "late", status: "active", composioConnectedAccountId: `ca_${crypto.randomUUID()}`, createdBy: seeded.userId, updatedBy: seeded.userId });
    await expectRefusedBeforeDispatch(seeded, spyOnProvider());
  });

  it("refuses when the bound account is revoked", async () => {
    const seeded = await seedApproved();
    await db.update(externalAccounts).set({ status: "revoked", composioConnectedAccountId: null }).where(eq(externalAccounts.id, seeded.account!.id));
    await expectRefusedBeforeDispatch(seeded, spyOnProvider());
  });

  it("refuses when the account was reconnected under a new connection id", async () => {
    const seeded = await seedApproved();
    await db.update(externalAccounts).set({ composioConnectedAccountId: `ca_${crypto.randomUUID()}` }).where(eq(externalAccounts.id, seeded.account!.id));
    await expectRefusedBeforeDispatch(seeded, spyOnProvider());
  });

  it("refuses when the workspace later tightens the authorized aliases", async () => {
    const seeded = await seedApproved();
    await db.insert(actionPolicies).values({
      workspaceId: seeded.workspaceId,
      capability: "notion.page.append",
      riskClass: "external_write",
      constraints: { allowedSenderAliases: ["some-other-alias"] },
    });
    await expectRefusedBeforeDispatch(seeded, spyOnProvider());
  });

  it("refuses a proposal that was never approved", async () => {
    const seeded = await seedApproved();
    await db.update(actionProposals).set({ status: "pending" }).where(eq(actionProposals.id, seeded.proposalId));
    const spy = spyOnProvider();
    await expect(executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId })).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("settles a payload edited after approval as failed without calling Notion", async () => {
    const seeded = await seedApproved();
    await db
      .update(actionRevisions)
      .set({ payload: { ...(seeded.revision.payload as object), markdown: "changed after review" } })
      .where(eq(actionRevisions.id, seeded.revision.id));
    const spy = spyOnProvider();
    const outcome = await executor.executeApprovedEffect(seeded.auth, { proposalId: seeded.proposalId });
    expect(outcome.status).toBe("failed");
    expect(spy).not.toHaveBeenCalled();
  });
});
