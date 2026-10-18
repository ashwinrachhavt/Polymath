import { describe, expect, it } from "vitest";
import { fieldLabel, fieldValueText } from "@/app/(workspace)/alfred/knowledge/field-display";

describe("field display", () => {
  it("shows money as money, not JSON", () => {
    expect(fieldValueText({ amount: 1248.5, currency: "EUR" }, null)).toBe("€1,248.50");
    expect(fieldValueText({ amount: 1100 }, null)).toBe("1,100.00");
    expect(fieldValueText({ amount: 5, currency: "ZZZZ" }, null)).toBe("ZZZZ 5.00");
  });

  it("explains an unreadable value with its note", () => {
    expect(fieldValueText(null, "date format ambiguous (dd/mm vs mm/dd)")).toBe("date format ambiguous (dd/mm vs mm/dd)");
    expect(fieldValueText(undefined, undefined)).toBe("unreadable");
  });

  it("names fields in words", () => {
    expect(fieldLabel("due_date")).toBe("due date");
    expect(fieldLabel("issuer-email")).toBe("issuer email");
  });
});
