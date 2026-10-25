import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { actionPolicies, actionProposals, actionReviews, actionRevisions } from "@/domains/actions/schema";
import { auditEvents } from "@/domains/audit/schema";
import { externalAccounts } from "@/domains/integrations/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-289 against real Postgres: a sending grant scopes gmail.send to
 * explicitly authorized aliases. An unauthorized alias never binds into a
 * revision; an unnamed sender resolves inside the list only, never by
 * substituting the one connected account; tightening the grant revokes an
 * already-approved proposal at execution, before the provider is touched.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let actions: typeof import("@/domains/actions/commands");
let executor: typeof import("@/domains/actions/executor");
let policy: typeof import("@/domains/actions/policy");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  process.env.COMPOSIO_API_KEY = "test-composio-key";
  actions = await import("@/domains/actions/commands");
  executor = await import("@/domains/actions/executor");
  policy = await import("@/domains/actions/policy");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  delete process.env.COMPOSIO_API_KEY;
  await handle?.client.end();
});

let counter = 0;

async function seed(slug: string, aliases: string[]) {
  counter += 1;
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}-${counter}`);
  const auth = ownerAuth(userId, workspaceId);
  const accounts = [];
  for (const alias of aliases) {
    const [account] = await db
      .insert(externalAccounts)
      .values({
        workspaceId,
        provider: "gmail",
        alias,
        status: "active",
        composioConnectedAccountId: `ca_${crypto.randomUUID()}`,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
    accounts.push(account);
  }
  return { auth, workspaceId, userId, accounts };
}

suite("sender grants", () => {
  it("an unauthorized alias never binds into a revision, and the reason names it", async () => {
    const { auth } = await seed("pin-refused", ["personal"]);
    await policy.setSenderAliasGrant(auth, "gmail.send", ["work"]);

    const pin = await actions.senderAccountPin(auth, "gmail.send", "personal");
    expect(pin).toMatchObject({ resolved: false, alias: "personal" });
    if (pin && !pin.resolved) expect(pin.reason).toContain('"personal" is not an authorized sender');
  });

  it("an unnamed sender resolves inside the list only - the other account is never substituted", async () => {
    const { auth } = await seed("pin-unnamed", ["personal", "work"]);
    await policy.setSenderAliasGrant(auth, "gmail.send", ["work"]);

    const pin = await actions.senderAccountPin(auth, "gmail.send", null);
    expect(pin).toMatchObject({ resolved: true, alias: "work" });
  });

  it("an unnamed sender with no authorized account connected fails honestly", async () => {
    const { auth } = await seed("pin-none", ["personal"]);
    await policy.setSenderAliasGrant(auth, "gmail.send", ["work"]);

    const pin = await actions.senderAccountPin(auth, "gmail.send", null);
    expect(pin).toMatchObject({ resolved: false });
    if (pin && !pin.resolved) expect(pin.reason).toContain("None of the authorized gmail senders (work) is connected");
  });

  it("tightening the grant revokes an approved proposal at execution, before the provider is touched", async () => {
    const { auth, workspaceId, userId, accounts } = await seed("grant-revoked", ["work"]);
    const account = accounts[0];

    const [proposal] = await db
      .insert(actionProposals)
      .values({
        workspaceId,
        capability: "gmail.send",
        riskClass: "external_write",
        status: "approved",
        accountAlias: "work",
        title: "Send email to ada@example.test",
        expectedEffect: "Sends a message.",
        dedupeKey: `gmail.mcp:${workspaceId}:ada@example.test:Hi:`,
        decidedAt: new Date(),
        decidedBy: userId,
      })
      .returning();
    const pin = {
      resolved: true,
      externalAccountId: account.id,
      connectedAccountId: account.composioConnectedAccountId,
      alias: "work",
      sender: "work",
    };
    const [revision] = await db
      .insert(actionRevisions)
      .values({
        workspaceId,
        proposalId: proposal.id,
        revisionNumber: 1,
        payload: { to: "ada@example.test", subject: "Hi", body: "Hello", inReplyTo: null, accountPin: pin },
        preview: { to: "ada@example.test", subject: "Hi", accountPin: pin },
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

    // The grant lands AFTER the approval: the send must die at the executor.
    await policy.setSenderAliasGrant(auth, "gmail.send", ["founder"]);

    const spy = vi.fn(async () => new Response(JSON.stringify({ data: { id: "msg_1" } }), { status: 200 }));
    vi.stubGlobal("fetch", spy);
    await expect(executor.executeApprovedEffect(auth, { proposalId: proposal.id })).rejects.toThrow(
      '"work" is not an authorized sender',
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("the grant upserts one row per capability, writes its audit row, and clearing lifts the restriction", async () => {
    const { auth, workspaceId } = await seed("grant-crud", ["work"]);

    await policy.setSenderAliasGrant(auth, "gmail.send", ["work"]);
    await policy.setSenderAliasGrant(auth, "gmail.send", ["work", "founder"]);
    const rows = await db
      .select()
      .from(actionPolicies)
      .where(eq(actionPolicies.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect((rows[0].constraints as { allowedSenderAliases: string[] }).allowedSenderAliases).toEqual([
      "founder",
      "work",
    ]);
    expect(rows[0].version).toBe(2);

    const audits = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.workspaceId, workspaceId));
    expect(audits.map((row) => row.action)).toContain("policy.sender_aliases_set");

    await policy.setSenderAliasGrant(auth, "gmail.send", []);
    const pin = await actions.senderAccountPin(auth, "gmail.send", "work");
    expect(pin).toMatchObject({ resolved: true, alias: "work" });
  });
});
