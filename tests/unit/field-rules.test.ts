import { describe, expect, it } from "vitest";
import { proposeFromText } from "@/domains/knowledge/field-rules";
import { normalizeFieldValue } from "@/domains/knowledge/fields";

/*
 * The rules proposer over text shaped like what the extractors return: the
 * pdf text layer (one line per text run, blank lines dropped) and LlamaParse
 * markdown (bold labels, table rows). Fictional data only.
 */

const TEXT_LAYER = [
  "INVOICE",
  "Invoice number: INV-2026-0142",
  "Issue date: 2026-10-01",
  "Due date: 11/10/2026",
  "Currency: EUR",
  "From:",
  "Harbor Lane Carpentry Ltd",
  "billing@harborlane.example",
  "Bill to:",
  "Maeve Brennan",
  "maeve.brennan@example.org",
  "Kitchen cabinet repair EUR 840.00",
  "Materials EUR 260.00",
  "Subtotal: EUR 1,100.00",
  "VAT 13.5%: EUR 148.50",
  "Total due: EUR 1,248.50",
].join("\n");

const byName = (fields: ReturnType<typeof proposeFromText>["fields"], name: string) =>
  fields.filter((f) => f.fieldName === name);

describe("rules field proposer", () => {
  it("reads labelled invoice fields with exact evidence spans", () => {
    const { fields, currencyHint } = proposeFromText(TEXT_LAYER, [{ page: 1, start: 0, end: TEXT_LAYER.length }]);
    expect(currencyHint).toBe("EUR");
    expect(fields.map((f) => [f.fieldName, f.rawValue, f.confidence])).toEqual([
      ["invoice_number", "INV-2026-0142", "high"],
      ["issue_date", "2026-10-01", "high"],
      ["due_date", "11/10/2026", "low"],
      ["issuer_email", "billing@harborlane.example", "high"],
      ["recipient_email", "maeve.brennan@example.org", "high"],
      ["subtotal", "EUR 1,100.00", "high"],
      ["tax", "EUR 148.50", "high"],
      ["invoice_total", "EUR 1,248.50", "high"],
    ]);
    // Every span points at exactly the raw value in the source text.
    for (const field of fields) {
      const [span] = field.evidenceSpans;
      expect(TEXT_LAYER.slice(span.start, span.end)).toBe(field.rawValue);
      expect(span.page).toBe(1);
    }
  });

  it("keeps an ambiguous date unresolved so the reviewer must type it", () => {
    const [due] = byName(proposeFromText(TEXT_LAYER).fields, "due_date");
    expect(normalizeFieldValue(due)).toEqual({
      normalizedValue: null,
      note: "date format ambiguous (dd/mm vs mm/dd)",
    });
  });

  it("attributes party values by block, never across parties", () => {
    const { fields, parties } = proposeFromText(TEXT_LAYER);
    expect(parties).toEqual([
      expect.objectContaining({ partyRole: "issuer", partyKind: "company", displayName: "Harbor Lane Carpentry Ltd" }),
      expect.objectContaining({
        partyRole: "recipient",
        partyKind: "contact",
        displayName: "Maeve Brennan",
        email: "maeve.brennan@example.org",
      }),
    ]);
    expect(byName(fields, "issuer_email")[0].partyRole).toBe("issuer");
    expect(byName(fields, "recipient_email")[0].partyRole).toBe("recipient");
    // Document-level facts belong to no party.
    expect(byName(fields, "invoice_total")[0].partyRole).toBeUndefined();
  });

  it("reads markdown labels and table rows from a hosted parser", () => {
    const markdown = [
      "# Invoice",
      "**Invoice #:** 7781",
      "**Bill to:** Oisin Kelly",
      "| Description | Amount |",
      "| --- | --- |",
      "| Total | $412.00 |",
    ].join("\n");
    const { fields, parties } = proposeFromText(markdown);
    expect(fields.map((f) => [f.fieldName, f.rawValue])).toEqual([
      ["invoice_number", "7781"],
      ["invoice_total", "$412.00"],
    ]);
    expect(parties).toEqual([expect.objectContaining({ partyRole: "recipient", displayName: "Oisin Kelly" })]);
  });

  it("does not guess from prose, unlabelled amounts, or non-money values", () => {
    const { fields, parties } = proposeFromText(
      ["To be paid within 30 days.", "Kitchen repair EUR 840.00", "Tax ID: IE1234567T", "Totals are shown below."].join("\n"),
    );
    expect(fields).toEqual([]);
    expect(parties).toEqual([]);
  });

  it("marks a label read twice with different values as low confidence", () => {
    const { fields } = proposeFromText("Total: $10.00\nTotal: $12.00");
    expect(fields.map((f) => f.confidence)).toEqual(["low", "low"]);
    expect(fields[0].normalizationNote).toContain("more than once");
  });

  it("places evidence on the page that holds it", () => {
    const text = "Invoice number: A-1\nDue date: 2026-11-30";
    const { fields } = proposeFromText(text, [
      { page: 1, start: 0, end: 19 },
      { page: 2, start: 20, end: text.length },
    ]);
    expect(fields.map((f) => f.evidenceSpans[0].page)).toEqual([1, 2]);
  });
});
