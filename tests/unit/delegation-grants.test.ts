import { describe, expect, it } from "vitest";
import { canonicalGrantContent, MAX_DELEGATION_DEPTH, MAX_GRANT_LIFETIME_MS, NEVER_DELEGABLE } from "@/domains/agents/delegation";

/*
 * GA02 hash discipline, DB-free: the content hash is the tamper tripwire the
 * gateway re-checks, so the canonical form must be deterministic regardless
 * of caller array ordering - and must change when any bound changes.
 */
const base = {
  workspaceId: "00000000-0000-0000-0000-000000000001",
  delegatorMembershipId: "00000000-0000-0000-0000-000000000002",
  agentPrincipalId: "00000000-0000-0000-0000-000000000003",
  parentGrantId: null,
  delegationDepth: 0,
  profileRevisionId: null,
  contextManifestId: null,
  scope: { operations: ["document.read", "person.read"], resources: ["person:abc"], accounts: ["work-gmail"], destinations: undefined as string[] | undefined },
  catalogVersion: 1,
  expiresAt: "2026-10-20T00:00:00.000Z",
};

describe("canonicalGrantContent", () => {
  it("is order-independent across every scope array", () => {
    const reordered = {
      ...base,
      scope: { operations: ["person.read", "document.read"], resources: ["person:abc"], accounts: ["work-gmail"], destinations: undefined as string[] | undefined },
    };
    expect(canonicalGrantContent(reordered)).toBe(canonicalGrantContent(base));
  });
  it("changes when any bound changes", () => {
    expect(canonicalGrantContent({ ...base, delegationDepth: 1 })).not.toBe(canonicalGrantContent(base));
    expect(canonicalGrantContent({ ...base, scope: { ...base.scope, operations: ["document.read"] } })).not.toBe(canonicalGrantContent(base));
    expect(canonicalGrantContent({ ...base, expiresAt: "2026-10-21T00:00:00.000Z" })).not.toBe(canonicalGrantContent(base));
  });
});

describe("grant bounds", () => {
  it("keeps the never-delegable list on the GA01 acceptance set", () => {
    expect([...NEVER_DELEGABLE].sort()).toEqual(["action.approve", "ownership.transfer", "role.assign", "role.define"].sort());
  });
  it("caps lifetime and depth", () => {
    expect(MAX_GRANT_LIFETIME_MS).toBe(7 * 24 * 3600 * 1000);
    expect(MAX_DELEGATION_DEPTH).toBe(3);
  });
});
