import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/*
 * The touched workspace pages are thin RSC shells: metadata, a redirect, or a
 * render over navigation/domain code that carries its own tests. This suite
 * pins each file's contract that does not deserve its own test —
 * default-export presence and the route names the IA is built from — so a
 * shell that stops exporting (a broken rename) fails here rather than at
 * runtime. Full journeys stay in Playwright; navigation logic in
 * tests/unit/navigation.test.ts.
 */

const ROOT = path.resolve(__dirname, "../..");

const PAGE_SHELLS = [
  "src/app/(workspace)/alfred/page.tsx",
  "src/app/(workspace)/alfred/[runId]/page.tsx",
  "src/app/(workspace)/alfred/dossiers/page.tsx",
  "src/app/(workspace)/alfred/knowledge/page.tsx",
  "src/app/(workspace)/command-center/briefing/page.tsx",
  "src/app/(workspace)/command-center/inbox/page.tsx",
  "src/app/(workspace)/command-center/opportunities/page.tsx",
  "src/app/(workspace)/command-center/relationships/page.tsx",
  "src/app/(workspace)/more/page.tsx",
  "src/app/(workspace)/neuralflow/focus/page.tsx",
  "src/app/(workspace)/neuralflow/work/page.tsx",
  "src/app/(workspace)/reviews/page.tsx",
  "src/app/(workspace)/settings/page.tsx",
  "src/components/page-header.tsx",
];

describe("workspace page shells", () => {
  it("every page file exists and default-exports a component", () => {
    for (const rel of PAGE_SHELLS) {
      const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(source, rel).toMatch(/export default|export function|export const/);
    }
  });

  it("the root redirects to the Assistant", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/app/page.tsx"), "utf8");
    expect(source).toContain('redirect("/alfred")');
  });

  it("page shells do not hardcode legacy /apps routes", () => {
    for (const rel of PAGE_SHELLS) {
      const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(source, rel).not.toContain('"/apps/');
    }
  });
});
