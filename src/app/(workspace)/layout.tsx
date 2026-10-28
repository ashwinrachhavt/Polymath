import { createHash } from "node:crypto";
import { io } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ClerkAuthProvider } from "@/components/auth/clerk-auth-provider";
import { AppShell } from "@/components/shell/app-shell";
import { clerkConfigured, devAuthBypass } from "@/lib/clerk";
import { getAuthContext } from "@/lib/auth";
import { getPreferences, resolveInterfaceMode } from "@/domains/identity/preferences";
import { listNotifications, type NotificationFeed } from "@/domains/notifications/feed";

/*
 * Every destination shares the shell. A route group rather than a path
 * segment, so the shell never appears in a URL.
 *
 * Authorization is checked here, not in the proxy: Clerk's middleware only
 * populates auth context, so without this guard every workspace route is
 * readable by anyone who reaches the URL. Default-deny — an unauthenticated
 * request never renders a destination, whatever the proxy did.
 *
 * The gate is keyed on `clerkConfigured`, deliberately not on devAuthBypass.
 * The bypass exists to resolve a fixed dev owner for data writes, and letting
 * it also disable this guard made every workspace route render to an
 * unauthenticated visitor the moment the flag was set — the app looked signed
 * in with no session behind it. With Clerk keys present, no session means no
 * destination.
 *
 * When Clerk is unconfigured the app is a local shell with no data behind it,
 * and `auth()` would throw for want of keys, so the guard stands down.
 *
 * The bypass therefore has one honest configuration: no Clerk keys at all.
 * Setting POLYMATH_DEV_AUTH=1 while Clerk keys are present used to leave the
 * guard armed with no session to satisfy it, so every page redirected to
 * sign-in mid-stream — an e2e suite that ran against such an environment
 * watched every page replace itself under it.
 */
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  let storageScope = "anonymous";
  // The notifications panel is chrome, so its feed is read here once for the
  // whole workspace rather than per page. A read failure must never take the
  // shell down with it: an empty feed is honest, a blank app is not.
  let notifications: NotificationFeed = { items: [], counts: { decision: 0, run: 0, audit: 0 }, needsAction: 0 };
  // ASH-312: the interface language is an account preference resolved on the
  // server, so every destination renders in the owner's mode on first paint -
  // no client flash, and "auto" settles in the owner's timezone. The public
  // shell (no authenticated workspace) renders the library default: there is
  // no owner timezone to settle "auto" in, and the clock is never read where
  // a route may prerender.
  let interfaceMode: "library" | "action" = "library";
  try {
    // Resolving the preference is per-request I/O (the row, and the clock for
    // "auto"): opt the shell out of prerendering before either is read, so a
    // statically evaluated route never samples `new Date()` at build time.
    await io();
    const authContext = await getAuthContext();
    if (authContext) {
      const [preferences, feed] = await Promise.all([
        getPreferences(authContext),
        listNotifications(authContext).catch(() => notifications),
      ]);
      interfaceMode = resolveInterfaceMode(preferences.interfaceMode, preferences.timezone);
      notifications = feed;
    }
  } catch {
    // A preference read failure never blocks the workspace; default mode.
  }
  if (clerkConfigured && !devAuthBypass) {
    const { userId } = await auth();
    if (!userId) redirect("/landing");
    storageScope = createHash("sha256").update(userId).digest("hex");
  }
  // clerkConfigured && devAuthBypass is a misconfiguration, not a mode: the
  // bypass asks for a fixed owner, but this guard would then demand a session
  // nobody holds and every page would redirect to sign-in mid-stream. Failing
  // loudly beats a suite that cannot boot.

  // Clerk's client runtime mounts here, not in the root layout: the public
  // landing route renders no Clerk UI, so it should not pay clerk-js's
  // ~220 KB first-load. Sign-in and sign-up wrap themselves because their
  // Clerk components need the same context.
  if (!clerkConfigured) {
    return <AppShell storageScope={storageScope} clerkConfigured={false} interfaceMode={interfaceMode} notifications={notifications}>{children}</AppShell>;
  }
  return (
    <ClerkAuthProvider>
      <AppShell storageScope={storageScope} clerkConfigured interfaceMode={interfaceMode} notifications={notifications}>{children}</AppShell>
    </ClerkAuthProvider>
  );
}
