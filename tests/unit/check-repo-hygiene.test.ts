import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SIZE_CEILING_BYTES, checkRepoHygiene, readTrackedBlobs } from "../../scripts/check-repo-hygiene";

/*
 * The bloat guard: generated output and oversized blobs never re-enter the
 * repo (13.4 MB of migration snapshots rode in every checkout for months
 * before PR-1). These tests pin the two rules — the deny-by-default size
 * ceiling and the generated-artifact blocklist — on both sides of the 256 KB
 * boundary, and drive readTrackedBlobs against a real fixture repo so the
 * git index plumbing (NUL-separated stages, batch size resolution) is
 * exercised, not mocked.
 */

const over = SIZE_CEILING_BYTES + 1;

describe("checkRepoHygiene", () => {
  it("passes the current shape of the repo: small sources plus allowlisted large blobs", () => {
    const errors = checkRepoHygiene({
      files: [
        { path: "src/app/(workspace)/polymath/knowledge/vault.tsx", bytes: 53_528 },
        { path: "pnpm-lock.yaml", bytes: 479_142 },
        { path: "src/db/migrations/0266_converge_push_schema.sql", bytes: 372_986 },
        { path: "src/db/migrations/meta/0270_snapshot.json", bytes: 729_248 },
        { path: "tests/fixtures/statements/icici-savings-mixed-header.json", bytes: 60_371 },
        { path: "extensions/chrome/libs/readability.js", bytes: 89_980 },
      ],
    });
    expect(errors).toEqual([]);
  });

  it("fails a blob over the ceiling outside the allowlist, naming path, size, and the recipe", () => {
    const errors = checkRepoHygiene({ files: [{ path: "src/generated/model-dump.json", bytes: over }] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("src/generated/model-dump.json");
    expect(errors[0]).toContain("262,145 bytes");
    expect(errors[0]).toContain("SIZE_ALLOWLIST");
  });

  it("passes a blob exactly at the ceiling — one byte over fails", () => {
    expect(checkRepoHygiene({ files: [{ path: "src/edge.json", bytes: SIZE_CEILING_BYTES }] })).toEqual([]);
    const errors = checkRepoHygiene({ files: [{ path: "src/edge.json", bytes: over }] });
    expect(errors).toHaveLength(1);
  });

  it("exempts only allowlisted paths of the same size, line by line", () => {
    const same = { path: "", bytes: over };
    for (const path of [
      "pnpm-lock.yaml",
      "src/db/migrations/0001_greedy_whistler.sql",
      "src/db/migrations/meta/0270_snapshot.json",
      "tests/fixtures/statements/deep-fixture.json",
      "extensions/chrome/libs/vendor-bundle.js",
    ]) {
      expect(checkRepoHygiene({ files: [{ ...same, path }] })).toEqual([]);
    }
    // A sibling one segment off is not covered by the line.
    expect(checkRepoHygiene({ files: [{ ...same, path: "tests/fixtures-snapshots/other.json" }] })).toHaveLength(1);
    expect(checkRepoHygiene({ files: [{ ...same, path: "src/generated/vendor-bundle.js" }] })).toHaveLength(1);
  });

  it("fails a blocklisted path at any size, at any depth", () => {
    for (const path of [
      "dist/bundle.js",
      "packages/app/dist/index.js",
      ".next/cache/webpack.js",
      "src/a/build/output.css",
      "deep/.turbo/trace.json",
      "next-env.tsbuildinfo",
      ".DS_Store",
      "nested/.DS_Store",
    ]) {
      const errors = checkRepoHygiene({ files: [{ path, bytes: 10 }] });
      expect(errors, path).toHaveLength(1);
      expect(errors[0]).toContain(`git rm --cached ${path}`);
    }
  });

  it("does not swallow legitimate neighbours of blocklisted names", () => {
    const errors = checkRepoHygiene({
      files: [
        { path: "src/build-system/tool.ts", bytes: 1024 },
        { path: "src/distributed/x.ts", bytes: 1024 },
        { path: "tests/coverage-map.test.ts", bytes: 1024 },
      ],
    });
    expect(errors).toEqual([]);
  });
});

describe("readTrackedBlobs", () => {
  let fixtureRepo: string;

  beforeEach(() => {
    fixtureRepo = mkdtempSync(join(tmpdir(), "repo-hygiene-"));
    execFileSync("git", ["init", "-q"], { cwd: fixtureRepo });
  });

  afterEach(() => {
    rmSync(fixtureRepo, { recursive: true, force: true });
  });

  it("resolves tracked blobs and sizes from a fixture repo's index, and the guard fails the oversize one", () => {
    writeFileSync(join(fixtureRepo, "small.ts"), "export const x = 1;\n");
    mkdirSync(join(fixtureRepo, "sub"));
    writeFileSync(join(fixtureRepo, "sub", "moderate.json"), JSON.stringify({ padding: "x".repeat(1000) }));
    writeFileSync(join(fixtureRepo, "big.bin"), Buffer.alloc(over, 0));
    execFileSync("git", ["add", "-A"], { cwd: fixtureRepo });

    const files = readTrackedBlobs(fixtureRepo);
    expect(files.map((f) => f.path)).toEqual(["big.bin", "small.ts", "sub/moderate.json"]);

    const byPath = new Map(files.map((f) => [f.path, f.bytes]));
    expect(byPath.get("big.bin")).toBe(over);
    expect(byPath.get("small.ts")).toBe("export const x = 1;\n".length);

    const errors = checkRepoHygiene({ files });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("big.bin");
  });

  it("reads an empty index as an empty, passing state", () => {
    const files = readTrackedBlobs(fixtureRepo);
    expect(files).toEqual([]);
    expect(checkRepoHygiene({ files })).toEqual([]);
  });
});
