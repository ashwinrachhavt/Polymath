import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { apiSubTrees, isKnownRoute, publicPageSegments, workspaceSegments } from "@/lib/proxy-routing";
import { nextConfigRedirects } from "../../redirects";
import proxy from "@/proxy";

vi.mock("@/lib/clerk", () => ({ clerkConfigured: true, devAuthBypass: false, proxyArmed: true }));
vi.mock("@clerk/nextjs/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("@clerk/nextjs/server")>(),
  clerkMiddleware: (handler: unknown) => handler,
}));

type AuthFn = {
  protect: ReturnType<typeof vi.fn>;
  (options?: unknown): Promise<{ isAuthenticated: boolean }>;
};

const runProxy = proxy as unknown as (auth: AuthFn, request: NextRequest) => Promise<Response | void>;

function runAs(path: string, isAuthenticated: boolean): Promise<Response | void> {
  const check = vi.fn().mockResolvedValue({ isAuthenticated });
  return runProxy(Object.assign(check, { protect: vi.fn() }), new NextRequest(`https://axiom.test${path}`));
}

describe("signed-out root redirect (QA F9)", () => {
  it("redirects / once to the landing funnel, keeping the post-sign-in destination the old two-hop chain ended at", async () => {
    const response = await runAs("/", false);
    expect(response?.status).toBe(307);
    expect(response?.headers.get("location")).toBe(`https://axiom.test/landing?returnTo=${encodeURIComponent("/polymath")}`);
  });

  it("sends a signed-in root on to the workspace", async () => {
    const response = await runAs("/", true);
    expect(response?.status).toBe(307);
    expect(response?.headers.get("location")).toBe("https://axiom.test/polymath");
  });

  it("keeps the static / redirect only while the proxy is a pass-through", () => {
    // Config redirects run before the proxy — a "/" entry here would
    // recreate the two-hop signed-out chain the proxy case above removes.
    const armed = nextConfigRedirects({ includeStaticRootRedirect: false });
    expect(armed.some((entry) => entry.source === "/")).toBe(false);
    // The legacy bookmark redirects are untouched.
    expect(armed.some((entry) => entry.source === "/alfred/:path*")).toBe(true);
    expect(armed.some((entry) => entry.source === "/inbox")).toBe(true);
    // Pass-through mode (no Clerk keys, dev bypass) keeps serving "/" via
    // the config redirect — nothing else handles it there.
    expect(nextConfigRedirects({ includeStaticRootRedirect: true }).some((entry) => entry.source === "/")).toBe(true);
  });
});

describe("unmatched paths get the real 404 (QA F8)", () => {
  it.each(["/this-path-does-not-exist-qa-sweep", "/api/healthz", "/trpc/anything", "/api", "//evil.test"])(
    "rewrites a signed-out visitor to the 404 renderer instead of the landing funnel on %s",
    async (path) => {
      const response = await runAs(path, false);
      // A rewrite, not a fall-through: the requested path is never served, so
      // a route missing from the route space degrades to a 404 — an
      // annoyance, never an auth bypass. Next emits the rewrite target as an
      // absolute URL.
      expect(response?.headers.get("x-middleware-rewrite")?.endsWith("/404")).toBe(true);
      // No redirect, so no returnTo echo — the non-same-origin cases
      // ("//evil.test") cannot leak into the funnel either.
      expect(response?.headers.get("location")).toBeNull();
    },
  );

  it("leaves a signed-in visitor to the real not-found surface", async () => {
    const response = await runAs("/this-path-does-not-exist-qa-sweep", true);
    expect(response).toBeUndefined();
  });
});

describe("real routes still gate exactly as before", () => {
  it.each(["/onboarding", "/polymath", "/polymath/knowledge/zettels/a/b/c", "/reviews", "/settings/access", "/dev/onboarding-fixtures", "/apps/neuralflow/work", "/command-center/inbox", "/more", "/artifacts/some-id"])(
    "redirects a signed-out visitor to the landing funnel on %s", async (path) => {
      const response = await runAs(path, false);
      expect(response?.status).toBe(307);
      expect(response?.headers.get("location")).toBe(`https://axiom.test/landing?returnTo=${encodeURIComponent(path)}`);
    },
  );

  it.each(["/api/v1", "/api/v1/runs", "/api/internal", "/api/mcp", "/api/integrations/callback"])(
    "classifies %s as a real route (gated or public — never 404)", (path) => {
      expect(isKnownRoute(path)).toBe(true);
    },
  );
});

describe("the proxy's route space covers the App Router tree", () => {
  // A directory counts as a route when it or any descendant holds a
  // page/route file. Route groups ((workspace)) are transparent: they never
  // appear in URLs.
  function hasRouteFile(dir: string): boolean {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && /^(page|route)\.(ts|tsx)$/.test(entry.name)) return true;
      if (entry.isDirectory() && hasRouteFile(join(dir, entry.name))) return true;
    }
    return false;
  }

  function routeSegmentPaths(dir: string, prefix: readonly string[] = []): string[][] {
    const out: string[][] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const next = entry.name.startsWith("(") ? prefix : [...prefix, entry.name];
      if (!entry.name.startsWith("(") && hasRouteFile(join(dir, entry.name))) out.push([...next]);
      out.push(...routeSegmentPaths(join(dir, entry.name), next));
    }
    return out;
  }

  it("lists every top-level segment the app tree defines", () => {
    const appDir = fileURLToPath(new URL("../../src/app", import.meta.url));
    const paths = routeSegmentPaths(appDir);
    const topLevel = paths.filter((p) => p.length === 1).map(([segment]) => segment);
    const apiChildren = new Set(paths.filter((p) => p.length >= 2 && p[0] === "api").map((p) => `api/${p[1]}`));

    // Sanity guards against the walk itself rotting into a vacuous pass.
    expect(topLevel).toContain("polymath");
    expect(topLevel).toContain("onboarding");
    expect(topLevel).toContain("landing");
    expect(apiChildren).toContain("api/v1");

    for (const segment of topLevel.filter((segment) => segment !== "api")) {
      expect([...workspaceSegments, ...publicPageSegments], `top-level segment /${segment}`).toContain(segment);
    }
    for (const tree of apiChildren) {
      expect(apiSubTrees, `api subtree /${tree}`).toContain(tree);
    }
  });
});
