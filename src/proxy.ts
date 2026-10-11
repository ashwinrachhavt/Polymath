import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { clerkConfigured } from "@/lib/clerk";

/*
 * Next 16 renamed middleware to proxy; this file is the old middleware.ts.
 *
 * Once both keys are set, Clerk owns every matched request. Nothing downstream
 * may assume an unauthenticated request is legitimate — the server resolves
 * the owner from Clerk, and a client never supplies it.
 */

export default clerkConfigured
  ? clerkMiddleware()
  : () => NextResponse.next();

export const config = {
  matcher: [
    // Everything except Next internals and static files.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|zip|webmanifest)).*)",
    // Always run for API routes, including the ones the pattern above skips.
    "/(api|trpc)(.*)",
  ],
};
