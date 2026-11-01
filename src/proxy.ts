import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { proxyArmed } from "@/lib/clerk";
import { isKnownRoute } from "@/lib/proxy-routing";

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
  // The real-404 renderer the proxy rewrites unmatched paths to (QA F8).
  "/404",
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
export default proxyArmed
  ? clerkMiddleware(async (auth, request) => {
      // A CORS preflight carries no credentials by design (the browser has not
      // sent the token yet), so protecting it makes every cross-origin call
      // impossible. The route's own OPTIONS handler answers it.
      if (request.method === "OPTIONS") return;
      const url = new URL(request.url);
      const pathname = url.pathname;

      // The root has no page of its own: a page rendering redirect() inside
      // the dynamic workspace layout caused an infinite prefetch loop, which
      // is why next.config.ts owns the static "/" redirect while this proxy
      // is a pass-through. Config redirects run before the proxy, so while
      // armed they must not exist for "/" (they would recreate the two-hop
      // signed-out chain, QA F9) and the root is decided here in one hop
      // either way: signed out, once to the landing funnel with the
      // post-sign-in destination that chain ended at; signed in, on to the
      // workspace.
      if (pathname === "/") {
        const search = url.search;
        const session = await auth({ acceptsToken: ["session_token"] });
        return session.isAuthenticated
          ? NextResponse.redirect(new URL(`/polymath${search}`, request.url))
          : NextResponse.redirect(
              new URL(`/landing?returnTo=${encodeURIComponent(`/polymath${search}`)}`, request.url),
            );
      }

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
          // Pages are session-only: a machine token never renders workspace UI.
          // Unauthenticated visitors see the marketing landing, not a bare
          // sign-in form — the funnel surface is the front door (owner
          // direction 2026-10-28). Sign-in stays one click from it, and the
          // destination survives the hop: returnTo carries the path so landing
          // can hand it to sign-in. Only safe same-origin paths qualify — it
          // must start with a single slash, never "//" (protocol-relative).
          const session = await auth({ acceptsToken: ["session_token"] });
          if (!session.isAuthenticated) {
            // QA F8: a genuinely unmatched path gets the real 404 (rendered
            // by /404) instead of a landing redirect that masks the miss.
            // The rewrite never serves the requested path, so a route that
            // is missing from the route space (src/lib/proxy-routing.ts,
            // enforced against the app tree by a unit test) degrades to a
            // 404 for signed-out visitors — an annoyance, never an auth
            // bypass; known routes keep gating exactly as before.
            if (!isKnownRoute(pathname)) {
              return NextResponse.rewrite(new URL("/404", request.url));
            }
            const destination = pathname + url.search;
            const returnTo =
              pathname.startsWith("/") && !pathname.startsWith("//") ? `?returnTo=${encodeURIComponent(destination)}` : "";
            return NextResponse.redirect(new URL(`/landing${returnTo}`, request.url));
          }
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
