import { describe, expect, it, vi } from "vitest";

// Importing the module opens the postgres-js pool; both handles are mocked so a
// clean clone without DATABASE_URL runs. The parser and header mapping are pure.
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db-transaction", () => ({ withTransaction: vi.fn() }));

import { parseCsv, rowsFromCsv } from "@/domains/identity/party-csv";

/*
 * LinkedIn's own export is the fixture that matters: a BOM on the first byte,
 * CRLF line ends, quoted fields with embedded commas, and an empty cell for a
 * connection who never shared an email. Each of those broke a naive split(",")
 * parser, which is why the parser exists rather than a dependency.
 */

const LINKEDIN = `﻿First Name,Last Name,URL,Email Address,Company,Position,Connected On\r
Ada,Lovelace,https://linkedin.com/in/ada,ada@calc.dev,Analytical Engines,Engineer,01 Jan 2026\r
Grace,Hopper,,grace@navy.mil,"Navy, Federal",Rear Admiral,02 Jan 2026\r
Alan,Turing,https://linkedin.com/in/alan,,Bletchley Park,,03 Jan 2026\r
`;

describe("parseCsv", () => {
  it("strips the BOM, handles CRLF and quoted commas", () => {
    const rows = rowsFromCsv(parseCsv(LINKEDIN));
    expect(rows).toHaveLength(3);
    expect(Object.keys(rows[0])[0]).toBe("first name");
    expect(rows[1]["company"]).toBe("Navy, Federal");
    expect(rows[2]["email address"]).toBe("");
  });

  it("keeps a doubled quote inside a quoted field", () => {
    const rows = parseCsv('a,b\n"say ""hi""",2\n');
    expect(rows).toEqual([
      ["a", "b"],
      ['say "hi"', "2"],
    ]);
  });

  it("drops blank lines instead of emitting empty rows", () => {
    expect(parseCsv("a,b\n\n1,2\n\n")).toHaveLength(2);
  });

  it("parses a final row with no trailing newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});
