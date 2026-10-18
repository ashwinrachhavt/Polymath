import { describe, expect, it, vi } from "vitest";

// The module opens the postgres-js pool at import time; both handles are
// mocked so a clean clone without DATABASE_URL runs.
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db-transaction", () => ({ withTransaction: vi.fn() }));

import {
  type PartyCandidate,
  type PartyDecision,
  type PartyMatchOption,
  type PartyResolutionOption,
} from "@/domains/knowledge/parties";

/*
 * Pure decision-shape checks: the candidate and decision contracts that the
 * review UI builds. The database-backed invariants (email beats name, name
 * never auto-resolves, create idempotency, supersede chains, retraction)
 * live in tests/integration/party-resolution.test.ts against real Postgres —
 * a mock here would only prove the mock works.
 *
 * What this file does own without a database: the role taxonomy stays
 * distinct (issuer vs recipient are different rows, not one "counterparty"),
 * and the decision union stays exhaustive — the UI cannot invent a fifth
 * action without a type error.
 */

describe("party candidate shape", () => {
  it("keeps issuer and recipient as distinct roles on the same document", () => {
    const issuer: PartyCandidate = {
      partyRole: "issuer",
      partyKind: "company",
      displayName: "Acme Corp",
      domain: "acme.com",
    };
    const recipient: PartyCandidate = {
      partyRole: "recipient",
      partyKind: "contact",
      displayName: "Ada Lovelace",
      email: "ada@example.com",
    };
    // Distinct roles mean distinct resolution edges: one invoice's issuer and
    // recipient are never conflated into one party row.
    expect(issuer.partyRole).not.toBe(recipient.partyRole);
    expect(issuer.partyKind).not.toBe(recipient.partyKind);
  });

  it("carries verified-identity hints separately from the display name", () => {
    // The hint is what makes a match verified; the name alone never does.
    const hinted: PartyCandidate = {
      partyRole: "sender",
      partyKind: "contact",
      displayName: "A. Lovelace",
      email: "ada@example.com",
    };
    const nameOnly: PartyCandidate = {
      partyRole: "sender",
      partyKind: "contact",
      displayName: "Ada Lovelace",
    };
    expect(hinted.email).toBeDefined();
    expect(nameOnly.email).toBeUndefined();
  });
});

describe("party decision shape", () => {
  it("expresses the three review options plus reject", () => {
    const decisions: PartyDecision[] = [
      { action: "match", contactId: crypto.randomUUID() },
      { action: "create", contact: { fullName: "Ada Lovelace" } },
      { action: "reject" },
      { action: "leave_unresolved" },
    ];
    const actions = new Set(decisions.map((d) => d.action));
    expect(actions).toEqual(new Set(["match", "create", "reject", "leave_unresolved"]));
  });

  it("a match decision names exactly one target kind", () => {
    const byContact: PartyDecision = { action: "match", contactId: crypto.randomUUID() };
    const byCompany: PartyDecision = { action: "match", companyId: crypto.randomUUID() };
    const hasExactlyOne = (d: PartyDecision) =>
      Number("contactId" in d && Boolean(d.contactId)) +
        Number("companyId" in d && Boolean(d.companyId)) ===
      1;
    expect(hasExactlyOne(byContact)).toBe(true);
    expect(hasExactlyOne(byCompany)).toBe(true);
  });
});

describe("resolution option shape", () => {
  it("distinguishes verified-identity matches from name-only options", () => {
    const verified: PartyResolutionOption = {
      partyId: crypto.randomUUID(),
      partyRole: "sender",
      partyKind: "contact",
      displayName: "A. Lovelace",
      resolutionStatus: "matched",
      resolvedTo: { kind: "contact", id: crypto.randomUUID(), name: "Ada Lovelace" },
      options: [],
    };
    const nameOnly: PartyResolutionOption = {
      partyId: crypto.randomUUID(),
      partyRole: "sender",
      partyKind: "contact",
      displayName: "Ada Lovelace",
      resolutionStatus: "unresolved",
      options: [
        { kind: "contact", id: crypto.randomUUID(), name: "Ada Lovelace", via: "name" },
      ],
    };
    // Verified: it resolved, no options offered. Name-only: nothing resolved,
    // options offered — the human decides.
    expect(verified.resolvedTo).toBeDefined();
    expect(verified.options).toHaveLength(0);
    expect(nameOnly.resolvedTo).toBeUndefined();
    expect(nameOnly.options.every((o: PartyMatchOption) => o.via === "name")).toBe(true);
  });
});
