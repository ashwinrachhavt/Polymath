import { describe, expect, it } from "vitest";
import { flagConflicts } from "@/domains/knowledge/fields";
import { canonicalFieldName, classifyDocument, normalizeFieldKey } from "@/domains/knowledge/vocabulary";
import type { ExtractedField } from "@/integrations/extraction/provider";

/*
 * ASH-133 items 1-2 + ASH-143: one field-name vocabulary at the boundary,
 * and the rules classifier that proposes (never auto-accepts) a doc type.
 */

const field = (name: string, rawValue: string, kind: ExtractedField["fieldKind"] = "money"): ExtractedField => ({
  fieldKind: kind,
  fieldName: name,
  rawValue,
  evidenceSpans: [{ start: 0, end: rawValue.length }],
});

describe("canonicalFieldName", () => {
  it("aliases provider spellings to the one vocabulary", () => {
    expect(canonicalFieldName("Invoice Total")).toBe("invoice_total");
    expect(canonicalFieldName("grand_total")).toBe("invoice_total");
    expect(canonicalFieldName("Amount Due")).toBe("invoice_total");
    expect(canonicalFieldName("VAT")).toBe("tax");
    expect(canonicalFieldName("payment due date")).toBe("due_date");
    expect(canonicalFieldName("Bill To")).toBe("recipient");
  });

  it("keeps unknown names normalized, never dropped or invented", () => {
    expect(canonicalFieldName("Purchase Order Number")).toBe("purchase_order_number");
    expect(canonicalFieldName("invoice_total")).toBe("invoice_total");
    expect(normalizeFieldKey("  Weird--Field // Name ")).toBe("weird_field_name");
  });
});

describe("flagConflicts with canonical names", () => {
  it("finds the total whether the provider called it total or invoice_total", () => {
    const fields = [
      field("subtotal", "1,100.00"),
      field("tax", "148.50"),
      field("invoice_total", "1,248.50"),
    ];
    const flagged = flagConflicts(fields);
    expect(flagged.every((f) => !f.normalizationNote)).toBe(true);

    const mismatch = flagConflicts([
      field("subtotal", "1,100.00"),
      field("tax", "148.50"),
      field("Invoice Total", "9,999.00"),
    ]);
    expect(mismatch.find((f) => f.rawValue === "9,999.00")?.normalizationNote).toMatch(/line items sum/);
  });
});

describe("classifyDocument", () => {
  it("invoice fields classify as invoice with the signals named", () => {
    const result = classifyDocument({ text: "thank you", fieldNames: ["invoice_number", "Invoice Total"] });
    expect(result.docType).toBe("invoice");
    expect(result.confidence).toBe("high");
    expect(result.signals).toContain("invoice_number");
  });

  it("agreement language plus party structure proposes agreement", () => {
    const result = classifyDocument({
      text: "This Services Agreement is entered into between the parties.",
      fieldNames: ["effective_date"],
    });
    expect(result.docType).toBe("agreement");
  });

  it("resume sections propose resume", () => {
    const result = classifyDocument({
      text: "Experience\nBuilt things.\nEducation\nDegree.\nSkills\nMany.",
      fieldNames: [],
    });
    expect(result.docType).toBe("resume");
  });

  it("an unmatched document is other with low confidence and no signals", () => {
    const result = classifyDocument({ text: "a nice walk in the park", fieldNames: [] });
    expect(result).toEqual({ docType: "other", confidence: "low", signals: [] });
  });
});
