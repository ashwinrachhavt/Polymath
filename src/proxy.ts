import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { clerkConfigured } from "@/lib/clerk";

/*
 * Next 16 renamed middleware to proxy; this file is the old middleware.ts.
 *
 * Once both keys are set, Clerk owns every matched request. Public routes
 * (sign-in, sign-up, webhooks) stay open; everything else requires a session
 * at the edge via auth.protect(). Workspace layouts still default-deny as a
 * second line of defense.
 *
 * Webhooks use HMAC (webhook_inbox), not Clerk sessions — they must stay public.
 */

const isApiRoute = createRouteMatcher(["/api/v1", "/api/v1/(.*)"]);

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks(.*)",
  // Own bearer secret (OUTBOX_DISPATCH_SECRET); 404 when unset.
  "/api/internal/outbox",
  "/api/internal/cron",
]);

export default clerkConfigured
  ? clerkMiddleware(async (auth, request) => {
      // A CORS preflight carries no credentials by design (the browser has not
      // sent the token yet), so protecting it makes every cross-origin call
      // impossible. The route's own OPTIONS handler answers it.
      if (request.method === "OPTIONS") return;
      if (!isPublicRoute(request)) {
        if (isApiRoute(request)) {
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
