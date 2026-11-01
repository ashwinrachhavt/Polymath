/*
 * Route-space knowledge for the proxy: which URL paths belong to the App
 * Router (the page and route files under src/app) and which are genuinely
 * unmatched. QA F8 turns on that distinction — an unauthenticated visitor to
 * an unmatched path gets the real 404 instead of a landing redirect that
 * masks it, while every real route keeps gating exactly as before.
 *
 * Enumerated at the top-level-segment granularity (api: second segment), so
 * a new page under an existing segment is covered without touching this
 * file. tests/unit/proxy-redirect-chain.test.ts walks the actual src/app
 * tree and fails CI when a new top-level segment appears unlisted here —
 * the classification errs toward "known" (gate as before), never toward
 * serving an unlisted path.
 *
 * Edge-only: no imports, so the proxy runtime can bundle it.
 */

// Gated workspace segments — the (workspace) route group's URL space.
export const workspaceSegments: readonly string[] = [
  "activity",
  "apps",
  "artifacts",
  "command-center",
  "dev",
  "more",
  "neuralflow",
  "onboarding",
  "polymath",
  "projects",
  "reviews",
  "settings",
];

// Public page segments (also mirrored as publicPatterns in src/proxy.ts).
// /404 is the real-404 renderer the proxy rewrites unmatched paths to.
export const publicPageSegments: readonly string[] = ["landing", "sign-in", "sign-up", "404"];

// Second-segment granularity: /api/v1/... and friends. /api/<other> (e.g. a
// mistyped /api/healthz) is unmatched and gets the 404.
export const apiSubTrees: readonly string[] = ["api/v1", "api/internal", "api/mcp", "api/integrations"];

/** True when the path lives inside the App Router's URL space. */
export function isKnownRoute(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  const first = segments[0];
  if (first === undefined) return true; // "/" itself; the proxy decides the root before this check
  if (first === "api") {
    return apiSubTrees.includes(segments.slice(0, 2).join("/"));
  }
  return workspaceSegments.includes(first) || publicPageSegments.includes(first);
}
