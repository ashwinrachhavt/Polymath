import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/file-validation";

/*
 * TD-12: the ceiling the app enforces and the ceiling the copy promises must be
 * the same number. Vercel rejects a request body over 4.5 MB before the route
 * runs, so a constant above it - or copy above it - is a promise the product
 * cannot keep: the person gets a bare platform 413 the app never formats.
 */

const SRC = path.resolve(__dirname, "../../src");

/** Every source file under src/, so a new screen that restates the limit is caught. */
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe("the upload ceiling", () => {
  it("is 4 MB, below Vercel's 4.5 MB request-body limit", () => {
    expect(MAX_UPLOAD_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_UPLOAD_BYTES).toBeLessThan(4.5 * 1024 * 1024);
    expect(MAX_UPLOAD_LABEL).toBe("4 MB");
  });

  it("is the only byte count the source states, and the label agrees with it", () => {
    const labelMb = Number(MAX_UPLOAD_LABEL.replace(" MB", ""));
    expect(labelMb * 1024 * 1024).toBe(MAX_UPLOAD_BYTES);
  });

  it("no user-facing copy promises 25 MB", () => {
    const offenders = walk(SRC).filter((file) => fs.readFileSync(file, "utf8").includes("25 MB"));
    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });
});
