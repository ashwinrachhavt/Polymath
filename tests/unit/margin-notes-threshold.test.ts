import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * Value: protects=the CSS container-query threshold matches --measure-prose + 17.5rem (margin-notes.tsx);
 * fails_when=the token or the query changes alone; why_new=CSS cannot read var() in a query; seam=none;
 * no_claim=rendering
 */
describe("margin notes threshold", () => {
  it("matches the reading measure plus the margin column", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const measure = Number(/--measure-prose:\s*(\d+)px/.exec(css)?.[1]);
    const query = Number(/@container \(min-width: (\d+)px\)/.exec(css)?.[1]);
    expect(query).toBe(measure + 17.5 * 16);
  });
});
