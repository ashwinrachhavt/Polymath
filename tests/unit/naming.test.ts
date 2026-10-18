import { describe, expect, it } from "vitest";
import { sentenceCase, suggestTitle } from "@/domains/knowledge/naming";

/*
 * Titles are display copy, so the tests pin the voice rules from
 * agents/product.md: missing fields are omitted (never "unknown"), separators
 * never double up, sentence case, no ALL-CAPS.
 */

describe("suggestTitle", () => {
  it("builds an invoice from all fields", () => {
    expect(
      suggestTitle("invoice", {
        issuer: "Acme",
        number: "INV-042",
        date: "2026-10-01",
      }),
    ).toBe("Acme — Invoice INV-042 — 2026-10-01");
  });

  it("omits missing fields instead of fabricating them", () => {
    const title = suggestTitle("invoice", { number: "INV-7" });
    expect(title).toBe("Invoice INV-7");
    expect(title).not.toMatch(/unknown/i);
    expect(title).not.toContain("— —");
    expect(title.startsWith("—")).toBe(false);
    expect(title.endsWith("—")).toBe(false);
  });

  it("builds an agreement with parties, type, date, and status", () => {
    expect(
      suggestTitle("services_agreement", {
        party_a: "Acme",
        party_b: "Globex",
        date: "2026-03-14",
        status: "signed",
      }),
    ).toBe("Acme — Globex — Services agreement — 2026-03-14 — signed");
  });

  it("builds a résumé title from person, role, and version", () => {
    expect(
      suggestTitle("resume", { person: "Ada Lovelace", role: "Engineer", version: "2" }),
    ).toBe("Ada Lovelace — Engineer résumé v2");
  });

  it("renders a résumé with no fields as just the type", () => {
    expect(suggestTitle("resume", {})).toBe("Résumé");
  });

  it("ignores blank and whitespace-only fields", () => {
    expect(suggestTitle("invoice", { issuer: "  ", number: null, date: "" })).toBe("Invoice");
  });
});

describe("sentenceCase", () => {
  it("lowercases a shouty name but keeps it capitalized", () => {
    expect(sentenceCase("ACME")).toBe("Acme");
  });

  it("leaves mixed-case names alone", () => {
    expect(sentenceCase("OpenAI")).toBe("OpenAI");
  });

  it("title-cases a snake_case doc type", () => {
    expect(suggestTitle("SERVICES_AGREEMENT", {})).toBe("Services agreement");
  });
});
