import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";

/*
 * Next 16 renamed middleware to proxy; this file is the old middleware.ts.
 *
 * A fresh clone and CI both run without Clerk keys, and the app has to boot
 * without them. So authentication is opt-in on configuration: once both keys
 * are set, Clerk owns every matched request. Nothing downstream may assume an
 * unauthenticated request is legitimate — the server resolves the owner from
 * Clerk, and a client never supplies it.
 */

const clerkConfigured =
  Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) &&
  Boolean(process.env.CLERK_SECRET_KEY);

export default clerkConfigured
  ? clerkMiddleware()
  : (_request: NextRequest) => NextResponse.next();

export const config = {
  matcher: [
    // Everything except Next internals and static files.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|zip|webmanifest)).*)",
    // Always run for API routes, including the ones the pattern above skips.
    "/(api|trpc)(.*)",
  ],
};
