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
Ada,Lovelace,https://linkedin.com/in/ada,ada@example.com,Analytical Engines,Engineer,01 Jan 2026\r
Grace,Hopper,,grace@example.org,"Navy, Federal",Rear Admiral,02 Jan 2026\r
Alan,Turing,https://linkedin.com/in/alan,,Bletchley Park,,03 Jan 2026\r
`;

describe("parseCsv", () => {
  it("strips the BOM, handles CRLF and quoted commas", () => {
    const rows = parseCsv(LINKEDIN);
    // Header + 3 connections; the BOM is gone from the first header cell.
    expect(rows).toHaveLength(4);
    expect(rows[0][0]).toBe("First Name");
    expect(rows[2][4]).toBe("Navy, Federal");
    expect(rows[3][3]).toBe("");
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

/*
 * The real export begins with a `Notes:` preamble and a blank line before the
 * header. Reading row 1 as the header made every connection look like it had no
 * name: a 3,571-row file imported as 3,571 skips, which reads as bad data
 * rather than a misread file.
 */
describe("rowsFromCsv", () => {
  const WITH_PREAMBLE = [
    ["Notes:"],
    ['"When exporting your connection data, you may notice that some email addresses are missing.'],
    [],
    ["First Name", "Last Name", "URL", "Email Address", "Company", "Position", "Connected On"],
    ["Barry", "Kirby", "https://linkedin.com/in/barry", "", "Linear Search", "Director", "20 Oct 2026"],
    ["Wei ", "Lu", "https://linkedin.com/in/weiqlu", "", "Sift", "Software Engineer", "18 Sep 2026"],
  ];

  it("finds the header after a LinkedIn preamble", () => {
    const rows = rowsFromCsv(WITH_PREAMBLE);
    expect(rows).toHaveLength(2);
    expect(rows[0]["first name"]).toBe("Barry");
    expect(rows[0]["company"]).toBe("Linear Search");
    expect(rows[1]["last name"]).toBe("Lu");
  });

  it("returns no rows when the file names no person columns", () => {
    expect(rowsFromCsv([["a", "b"], ["1", "2"]])).toEqual([]);
  });

  it("still reads a header on the first line", () => {
    const rows = rowsFromCsv([["First Name", "Last Name"], ["Ada", "Lovelace"]]);
    expect(rows[0]["first name"]).toBe("Ada");
  });
});
