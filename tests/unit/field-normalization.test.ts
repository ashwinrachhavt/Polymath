import { describe, expect, it } from "vitest";
import {
  fieldDedupeKey,
  flagConflicts,
  normalizeDate,
  normalizeFieldValue,
  normalizeMoney,
} from "@/domains/knowledge/fields";
import type { ExtractedField } from "@/integrations/extraction/provider";

/*
 * Normalization is conservative by design: ambiguity is recorded, never
 * guessed. These pin the cases the spec calls out by name.
 */

describe("normalizeDate", () => {
  it("leaves an ambiguous dd/mm-vs-mm/dd date unresolved with a note", () => {
    const r = normalizeDate("03/04/2026");
    expect(r.normalizedValue).toBeNull();
    expect(r.note).toBe("date format ambiguous (dd/mm vs mm/dd)");
  });

  it("normalizes an unambiguous ISO date", () => {
    expect(normalizeDate("2026-03-04")).toEqual({ normalizedValue: "2026-03-04", note: null });
  });

  it("resolves a slash date only when one side exceeds 12", () => {
    expect(normalizeDate("25/12/2026")).toEqual({ normalizedValue: "2026-12-25", note: null });
    expect(normalizeDate("12/25/2026")).toEqual({ normalizedValue: "2026-12-25", note: null });
  });

  it("normalizes a month-name date", () => {
    expect(normalizeDate("March 4, 2026")).toEqual({
      normalizedValue: "2026-03-04",
      note: null,
    });
  });
});

describe("normalizeMoney", () => {
  it("keeps currency null when the raw text carries none and no hint is given", () => {
    expect(normalizeMoney("1200.00")).toEqual({
      normalizedValue: { amount: 1200.0, currency: null },
      note: null,
    });
  });

  it("normalizes $1,200.00 to 1200.00 USD", () => {
    expect(normalizeMoney("$1,200.00")).toEqual({
      normalizedValue: { amount: 1200.0, currency: "USD" },
      note: null,
    });
  });

  it("uses the supplied hint only when the raw text has no currency", () => {
    expect(normalizeMoney("1234.00", "EUR").normalizedValue).toEqual({
      amount: 1234,
      currency: "EUR",
    });
    // Explicit evidence wins over the hint.
    expect(normalizeMoney("£500", "EUR").normalizedValue).toEqual({
      amount: 500,
      currency: "GBP",
    });
  });

  it("never defaults to USD", () => {
    expect(normalizeMoney("99").normalizedValue).toMatchObject({ currency: null });
  });
});

describe("normalizeFieldValue", () => {
  it("trims a clean identifier but refuses a multiline one", () => {
    expect(normalizeFieldValue(field("identifier", "ref", " id-42 ")).normalizedValue).toBe("id-42");
    const multiline = normalizeFieldValue(field("text", "notes", "line one\nline two"));
    expect(multiline.normalizedValue).toBeNull();
    expect(multiline.note).toBeTruthy();
  });

  it("normalizes a date field through its kind", () => {
    expect(normalizeFieldValue(field("date", "effective", "2026-01-02")).normalizedValue).toBe(
      "2026-01-02",
    );
  });
});

describe("fieldDedupeKey", () => {
  it("is stable across calls and distinct across kinds", () => {
    const a = fieldDedupeKey(field("money", "total", "$10"));
    expect(fieldDedupeKey(field("money", "total", "$10"))).toBe(a);
    expect(fieldDedupeKey(field("date", "total", "$10"))).not.toBe(a);
    expect(fieldDedupeKey(field("money", "subtotal", "$10"))).not.toBe(a);
  });
});

describe("flagConflicts", () => {
  it("flags a line-item sum that disagrees with the stated total", () => {
    const fields = [
      field("money", "line_item_1", "$100.00"),
      field("money", "line_item_2", "$250.00"),
      field("money", "total", "$400.00"),
    ];
    const flagged = flagConflicts(fields);
    expect(flagged.find((f) => f.fieldName === "total")?.normalizationNote).toContain(
      "line items sum to 350 but stated total is 400",
    );
    // Never repairs: raw values untouched.
    expect(flagged.find((f) => f.fieldName === "total")?.rawValue).toBe("$400.00");
  });

  it("leaves a consistent invoice untouched", () => {
    const fields = [
      field("money", "line_item_1", "$100.00"),
      field("money", "line_item_2", "$250.00"),
      field("money", "total", "$350.00"),
    ];
    expect(flagConflicts(fields)).toEqual(fields);
  });
});

function field(
  fieldKind: ExtractedField["fieldKind"],
  fieldName: string,
  rawValue = "value",
): ExtractedField {
  return { fieldKind, fieldName, rawValue, evidenceSpans: [{ page: 1, start: 0, end: 5 }] };
}
