import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentAuthorizationDecisions } from "@/domains/agents/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * ASH-122 GA03 + GA10 against a real workspace: the gateway records every
 * verdict, allow and deny alike, with the grant it cited; denied invocations
 * leave no effect besides their decision row; verdict rows are immutable;
 * and the tamper tripwire works end-to-end - recompute the hash from the
 * stored grant row and a mismatch denies.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let withTransaction: typeof import("@/lib/db-transaction").withTransaction;
let authorization: typeof import("@/domains/agents/authorization");
let delegation: typeof import("@/domains/agents/delegation");
let principals: typeof import("@/domains/agents/principals");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  ({ withTransaction } = await import("@/lib/db-transaction"));
  authorization = await import("@/domains/agents/authorization");
  delegation = await import("@/domains/agents/delegation");
  principals = await import("@/domains/agents/principals");
});

afterAll(async () => {
  await handle?.client.end();
});

suite("tool authorization decisions", () => {
  it("records allow and deny verdicts against the cited grant - denials cause no other effect", async () => {
    const seeded = await seedWorkspace(db, `gw-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const { principalId } = await principals.registerAgentPrincipal(auth, { key: "alfred", kind: "agent", label: "Alfred" });
    const issued = await delegation.issueDelegationGrant(auth, {
      agentPrincipalId: principalId,
      scope: { operations: ["document.read", "integration.use", "action.execute"], accounts: ["work-gmail"], destinations: ["ashwinr@vt.edu"] },
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });

    const verdicts = await withTransaction(async (tx) => {
      const grant = await delegation.getDelegationGrant(tx, seeded.workspaceId, issued.grantId);
      if (!grant) throw new Error("grant missing");
      const expectedHash = await delegation.hashDelegationGrant(grant);
      expect(expectedHash).toBe(issued.contentHash);

      const allow = await authorization.decideAndRecordToolInvocation(tx, {
        workspaceId: seeded.workspaceId,
        grantId: grant.id,
        agentPrincipalId: principalId,
        invocationId: "inv-allow",
        grant,
        request: { operation: "documents.search", now: new Date(), expectedContentHash: expectedHash },
      });
      const denyAccount = await authorization.decideAndRecordToolInvocation(tx, {
        workspaceId: seeded.workspaceId,
        grantId: grant.id,
        agentPrincipalId: principalId,
        invocationId: "inv-deny-account",
        grant,
        request: { operation: "gmail.send", accountAlias: "personal-gmail", now: new Date(), expectedContentHash: expectedHash },
      });
      const denyTampered = await authorization.decideAndRecordToolInvocation(tx, {
        workspaceId: seeded.workspaceId,
        grantId: grant.id,
        agentPrincipalId: principalId,
        invocationId: "inv-deny-tampered",
        grant,
        request: { operation: "documents.search", now: new Date(), expectedContentHash: "f".repeat(64) },
      });
      return [allow, denyAccount, denyTampered];
    });

    expect(verdicts[0]).toEqual({ allowed: true, requiresApproval: false });
    expect(verdicts[1]).toEqual({ allowed: false, reasons: ["account_not_granted"] });
    expect(verdicts[2]).toEqual({ allowed: false, reasons: ["grant_tampered"] });

    const rows = await db
      .select()
      .from(agentAuthorizationDecisions)
      .where(and(eq(agentAuthorizationDecisions.workspaceId, seeded.workspaceId), eq(agentAuthorizationDecisions.grantId, issued.grantId)));
    expect(rows).toHaveLength(3);
    const byInvocation = Object.fromEntries(rows.map((r) => [r.invocationId, r]));
    expect(byInvocation["inv-allow"].decision).toBe("allowed");
    expect(byInvocation["inv-allow"].reasons).toEqual([]);
    expect(byInvocation["inv-deny-account"].decision).toBe("denied");
    expect(byInvocation["inv-deny-account"].reasons).toEqual(["account_not_granted"]);
    expect(byInvocation["inv-deny-tampered"].decision).toBe("denied");

    // Verdicts are history: the immutable trigger rejects edits. Drizzle
    // wraps the driver error ("Failed query: ..."), so assert on the cause.
    const freezeError = await db
      .update(agentAuthorizationDecisions)
      .set({ decision: "allowed" })
      .where(eq(agentAuthorizationDecisions.invocationId, "inv-deny-account"))
      .then(() => null, (e: unknown) => e);
    expect(String((freezeError as { cause?: unknown })?.cause ?? freezeError)).toMatch(/immutable/);
  });

  it("an approval-gated operation authorizes only as requires_approval", async () => {
    const seeded = await seedWorkspace(db, `gw2-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const { principalId } = await principals.registerAgentPrincipal(auth, { key: "ops", kind: "agent", label: "Ops" });
    const issued = await delegation.issueDelegationGrant(auth, {
      agentPrincipalId: principalId,
      scope: { operations: ["action.execute"], accounts: ["work-gmail"], destinations: ["ashwinr@vt.edu"] },
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });
    const [row] = await withTransaction(async (tx) => {
      const grant = await delegation.getDelegationGrant(tx, seeded.workspaceId, issued.grantId);
      if (!grant) throw new Error("grant missing");
      const decision = await authorization.decideAndRecordToolInvocation(tx, {
        workspaceId: seeded.workspaceId,
        grantId: grant.id,
        agentPrincipalId: principalId,
        invocationId: "inv-send",
        grant,
        request: {
          operation: "gmail.send",
          accountAlias: "work-gmail",
          destination: "ashwinr@vt.edu",
          now: new Date(),
          expectedContentHash: await delegation.hashDelegationGrant(grant),
        },
      });
      return [decision];
    });
    expect(row).toEqual({ allowed: true, requiresApproval: true });
  });
});
