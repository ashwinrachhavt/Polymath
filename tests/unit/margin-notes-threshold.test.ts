import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MARGIN_MODE_PROPERTY } from "@/components/products/polymath/margin-notes";

/*
 * Value: protects=margin mode has one source of truth: the container query that hides the inline notes is
 * the one that tells margin-notes.tsx to draw the column, and its width is the reading measure plus the
 * column; fails_when=the script reads a property the query does not set, the query stops hiding the inline
 * notes, or the token and the query drift apart; why_new=a second threshold in the script disagreed with the
 * CSS at a non-16px root font; seam=none; no_claim=rendering (jsdom does not evaluate container queries)
 */
describe("margin notes threshold", () => {
  const css = readFileSync("src/app/globals.css", "utf8");
  const rule = /@container \(min-width: calc\((\d+)px \+ 17\.5rem\)\) \{([\s\S]*?)\n\}/.exec(css);

  it("is the reading measure plus the 16rem column and its gap", () => {
    const measure = Number(/--measure-prose:\s*(\d+)px/.exec(css)?.[1]);
    expect(Number(rule?.[1])).toBe(measure);
  });

  it("sets the property the script reads in the rule that hides the inline notes", () => {
    const body = rule?.[2] ?? "";
    expect(body).toMatch(/\.note-margin-inline \{\s*display: none;/);
    expect(body).toContain(`${MARGIN_MODE_PROPERTY}: on;`);
  });
});
