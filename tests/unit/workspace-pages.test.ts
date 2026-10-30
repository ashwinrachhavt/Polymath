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
  "src/app/(workspace)/polymath/page.tsx",
  "src/app/(workspace)/polymath/[runId]/page.tsx",
  "src/app/(workspace)/projects/page.tsx",
  "src/app/(workspace)/artifacts/page.tsx",
  "src/app/(workspace)/polymath/knowledge/page.tsx",
  "src/app/(workspace)/command-center/spending/page.tsx",
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

  it("the root sends the owner to the conversation", () => {
    // The root is a static config redirect in next.config.ts ("/" → "/polymath"):
    // a rendered redirect inside the dynamic layout made every never-cacheable
    // prefetch of "/" hit a full dynamic render and looped the router (the
    // GET / loop). So the workspace has no root page, and src/app/page.tsx
    // must not exist either.
    expect(fs.existsSync(path.join(ROOT, "src/app/page.tsx"))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "src/app/(workspace)/page.tsx"))).toBe(false);
    const config = fs.readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
    expect(config).toContain('source: "/"');
    expect(config).toContain('destination: "/polymath"');
  });

  it("page shells do not hardcode legacy /apps routes", () => {
    for (const rel of PAGE_SHELLS) {
      const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(source, rel).not.toContain('"/apps/');
    }
  });
});
