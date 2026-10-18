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

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks(.*)",
]);

export default clerkConfigured
  ? clerkMiddleware(async (auth, request) => {
      if (!isPublicRoute(request)) {
        await auth.protect();
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
