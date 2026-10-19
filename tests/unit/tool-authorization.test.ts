import { describe, expect, it } from "vitest";
import { authorizeToolInvocation, TOOL_OPERATION_REGISTRY, type GrantForAuthorization } from "@/domains/agents/authorization";

/*
 * ASH-122 GA03 confused-deputy coverage, DB-free. Every acceptance rule is
 * one denial path: unknown operations, the recorded catalog gap, revoked,
 * expired and tampered grants, capabilities the grant does not carry,
 * account/resource/destination bounds that are unset (null = not delegated),
 * profile ceilings that only narrow, and the approval gate on external
 * effects. The approved authorized path must succeed too - a gateway that
 * denies everything is not a gateway.
 */

const NOW = new Date("2026-10-19T20:00:00Z");
const HASH = "a".repeat(64);

const grant = (over: Partial<GrantForAuthorization> = {}): GrantForAuthorization => ({
  revokedAt: null,
  expiresAt: new Date("2026-10-20T20:00:00Z"),
  contentHash: HASH,
  allowedOperations: ["document.read", "integration.use", "action.execute"],
  allowedResources: ["person:111"],
  allowedAccounts: ["work-gmail"],
  allowedDestinations: ["ashwinr@vt.edu"],
  delegationDepth: 0,
  ...over,
});

const req = (over: Partial<Parameters<typeof authorizeToolInvocation>[1]> = {}) => ({
  operation: "documents.search",
  now: NOW,
  expectedContentHash: HASH,
  ...over,
});

describe("authorizeToolInvocation", () => {
  it("admits the authorized path, flagging approval-gated effects", () => {
    expect(authorizeToolInvocation(grant(), req())).toEqual({ allowed: true, requiresApproval: false });
    expect(
      authorizeToolInvocation(grant(), req({ operation: "gmail.send", accountAlias: "work-gmail", destination: "ashwinr@vt.edu" })),
    ).toEqual({ allowed: true, requiresApproval: true });
  });

  it("denies by default: unknown operations and the recorded catalog gap", () => {
    expect(authorizeToolInvocation(grant(), req({ operation: "gmail.delete_all" }))).toEqual({
      allowed: false,
      reasons: ["unknown_operation"],
    });
    // tasks.read has no honest catalog-v1 capability; it denies until the catalog grows one.
    expect(authorizeToolInvocation(grant(), req({ operation: "tasks.read" }))).toEqual({
      allowed: false,
      reasons: ["no_capability_mapping"],
    });
  });

  it("denies revoked, expired, and tampered grants", () => {
    expect(authorizeToolInvocation(grant({ revokedAt: new Date("2026-10-19T19:00:00Z") }), req())).toMatchObject({
      allowed: false,
      reasons: ["grant_revoked"],
    });
    expect(authorizeToolInvocation(grant({ expiresAt: NOW }), req())).toMatchObject({ allowed: false, reasons: ["grant_expired"] });
    // The confused-deputy core: a row whose content was edited after issuance
    // no longer matches its pinned hash, and dies.
    expect(authorizeToolInvocation(grant(), req({ expectedContentHash: "b".repeat(64) }))).toMatchObject({
      allowed: false,
      reasons: ["grant_tampered"],
    });
  });

  it("denies capabilities the grant does not carry", () => {
    const narrow = grant({ allowedOperations: ["document.read"] });
    expect(authorizeToolInvocation(narrow, req({ operation: "web.search" }))).toEqual({
      allowed: false,
      reasons: ["operation_not_granted"],
    });
  });

  it("treats unset bounds as not delegated, never as unrestricted", () => {
    const noAccounts = grant({ allowedAccounts: null });
    expect(
      authorizeToolInvocation(noAccounts, req({ operation: "gmail.send", accountAlias: "work-gmail" })),
    ).toMatchObject({ allowed: false, reasons: ["account_not_granted"] });
    // Account substitution: a personal account standing in for the approved work account fails.
    expect(
      authorizeToolInvocation(grant(), req({ operation: "gmail.send", accountAlias: "personal-gmail" })),
    ).toMatchObject({ allowed: false, reasons: ["account_not_granted"] });
    // Restricted data to an unapproved recipient fails.
    expect(
      authorizeToolInvocation(grant(), req({ operation: "gmail.send", accountAlias: "work-gmail", destination: "attacker@example.com" })),
    ).toMatchObject({ allowed: false, reasons: ["destination_not_granted"] });
    expect(
      authorizeToolInvocation(grant({ allowedResources: null }), req({ resourceRef: "person:111" })),
    ).toMatchObject({ allowed: false, reasons: ["resource_not_granted"] });
    expect(
      authorizeToolInvocation(grant(), req({ resourceRef: "person:999" })),
    ).toMatchObject({ allowed: false, reasons: ["resource_not_granted"] });
  });

  it("profile visibility is not authorization: the ceiling only narrows", () => {
    // Operation visible in the profile but not granted still denies.
    expect(
      authorizeToolInvocation(grant({ allowedOperations: ["document.read"] }), req({ operation: "web.search", profileCeiling: ["web.search"] })),
    ).toMatchObject({ allowed: false, reasons: ["operation_not_granted"] });
    // Granted but outside the profile ceiling denies too.
    expect(
      authorizeToolInvocation(grant(), req({ profileCeiling: ["gmail.send"] })),
    ).toMatchObject({ allowed: false, reasons: ["outside_profile_ceiling"] });
  });

  it("collects every reason, so an audit row explains the whole denial", () => {
    const dead = grant({ revokedAt: new Date(), allowedOperations: [] });
    const decision = authorizeToolInvocation(dead, req({ operation: "nope", accountAlias: "x" }));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reasons).toEqual(expect.arrayContaining(["unknown_operation", "grant_revoked", "account_not_granted"]));
    }
  });

  it("keeps the registry's approval gate on every external effect", () => {
    for (const [operation, spec] of Object.entries(TOOL_OPERATION_REGISTRY)) {
      if (spec.effectClass === "external_effect" || spec.effectClass === "paid") {
        expect(spec.requiresApproval, operation).toBe(true);
      }
    }
  });
});
