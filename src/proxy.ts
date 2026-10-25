import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { clerkConfigured, devAuthBypass } from "@/lib/clerk";

/*
 * Next 16 renamed middleware to proxy; this file is the old middleware.ts.
 *
 * Once both keys are set, Clerk owns every matched request. Public routes
 * (sign-in, sign-up, webhooks) stay open; everything else requires a session
 * at the edge via auth.protect(). Workspace layouts still default-deny as a
 * second line of defense.
 *
 * Webhooks use HMAC (webhook_inbox), not Clerk sessions — they must stay public.
 *
 * createRouteMatcher is deprecated (path matching in middleware is drifting
 * away from how Next routes requests); these are plain pattern checks so the
 * same classification keeps working until the checks move into the routes
 * themselves per Clerk's migration guide.
 */

function matches(pathname: string, patterns: string[]) {
  return patterns.some((pattern) =>
    pattern.endsWith("(.*)")
      ? pathname === pattern.slice(0, -4) || pathname.startsWith(pattern.slice(0, -4))
      : pathname === pattern,
  );
}

const apiPatterns = ["/api/v1", "/api/v1/(.*)"];

const publicPatterns = [
  // The one public marketing route (GTM funnel surface).
  "/landing",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks(.*)",
  // Own bearer secret (OUTBOX_DISPATCH_SECRET); 404 when unset.
  "/api/internal/outbox",
  "/api/internal/cron",
  // The provider gateway authenticates a run-scoped HMAC token, minted by the
  // agent, not a Clerk session. Clerk here would 307 the agent's own tool call
  // to the sign-in page, which is what "fetch failed" looked like from eve.
  "/api/mcp",
];

// The proxy enforces whenever Clerk is configured, regardless of
// devAuthBypass. The bypass only selects which owner data writes resolve to
// (src/lib/auth.ts); letting it also switch protection off here left every
// route open, and under cacheComponents a statically prerendered route never
// re-runs its layout guard, so nothing else would have caught it.
//
// One exception: the bypass with Clerk keys present is a misconfiguration, not
// a mode. auth.protect() would 307 every page to Clerk's hosted sign-in for a
// session the bypass by definition does not hold, so local e2e watched every
// page replace itself mid-stream. In development that combination answers
// next() and lets the layout's dev-owner path decide; in production it stays
// armed, because production never runs the bypass on purpose.
export default clerkConfigured && !(devAuthBypass && process.env.NODE_ENV !== "production")
  ? clerkMiddleware(async (auth, request) => {
      // A CORS preflight carries no credentials by design (the browser has not
      // sent the token yet), so protecting it makes every cross-origin call
      // impossible. The route's own OPTIONS handler answers it.
      if (request.method === "OPTIONS") return;
      const pathname = new URL(request.url).pathname;
      if (!matches(pathname, publicPatterns)) {
        if (matches(pathname, apiPatterns)) {
          // Match getAnyAuthContext's supported identities. An API caller gets
          // a 401 problem, not a sign-in redirect: a redirect carries no CORS
          // headers and surfaces to a fetch as an opaque network failure.
          //
          // An Polymath-issued companion bearer is verified by the route itself
          // (src/lib/auth.ts), not by Clerk, so the edge lets it through and
          // the route is the one that decides.
          const companionBearer = /^Bearer\s+\S+$/.test(request.headers.get("authorization") ?? "");
          const session = companionBearer
            ? { isAuthenticated: true }
            : await auth({ acceptsToken: ["session_token", "m2m_token", "api_key"] });
          if (!session.isAuthenticated) {
            return NextResponse.json(
              {
                type: "https://axiom.dev/problems/unauthorized",
                code: "unauthorized",
                title: "Sign in to use this endpoint.",
                status: 401,
              },
              { status: 401, headers: { "content-type": "application/problem+json" } },
            );
          }
        } else {
          await auth.protect();
        }
      }
    })
  : () => NextResponse.next();

export const config = {
  matcher: [
    // Everything except Next internals and static files.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|zip|webmanifest)).*)",
    // Always run for API routes, including the ones the pattern above skips.
    "/(api|trpc)(.*)",
  ],
};
