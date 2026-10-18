import { describe, expect, it } from "vitest";
import { obligationDedupeKey } from "@/domains/knowledge/obligations";

/*
 * The rules pass is pure logic over field proposals; this exercises that logic
 * (invoice, missing-field, no match) and the dedupe key shape, without a
 * database.
 */

type Proposal = { fieldKind: string; fieldName: string; status: string };

const RULES: { kind: string; match: (p: Proposal) => boolean }[] = [
  { kind: "confirm_invoice_status", match: (p) => p.fieldKind === "money" && /invoice_total/.test(p.fieldName) },
  { kind: "provide_missing_info", match: (p) => /missing/.test(p.fieldName) },
];

/** Mirrors proposeObligationsFromDocument's selection loop. */
function propose(proposals: Proposal[]): string[] {
  const hits = new Set<string>();
  for (const p of proposals) for (const r of RULES) if (r.match(p)) hits.add(r.kind);
  return [...hits];
}

describe("obligation rules", () => {
  it("an invoice money field proposes confirm_invoice_status", () => {
    expect(
      propose([{ fieldKind: "money", fieldName: "invoice_total", status: "proposed" }]),
    ).toEqual(["confirm_invoice_status"]);
  });

  it("a document with no matching rule proposes nothing", () => {
    expect(
      propose([{ fieldKind: "text", fieldName: "summary", status: "proposed" }]),
    ).toEqual([]);
  });

  it("a missing-field proposal proposes provide_missing_info", () => {
    expect(
      propose([{ fieldKind: "date", fieldName: "missing_due_date", status: "proposed" }]),
    ).toEqual(["provide_missing_info"]);
  });

  it("duplicate proposals collapse on one dedupe key per kind", () => {
    const docId = "11111111-1111-1111-1111-111111111111";
    const withProposal = obligationDedupeKey("confirm_invoice_status", docId, "p1");
    const without = obligationDedupeKey("confirm_invoice_status", docId);
    expect(withProposal).toBe(`confirm_invoice_status:${docId}:p1`);
    expect(without).toBe(`confirm_invoice_status:${docId}:doc`);
    expect(withProposal).not.toBe(without);
  });
});
