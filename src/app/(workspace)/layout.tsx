import { createHash } from "node:crypto";
import { io } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { cachedSessionVerifiedEmail } from "@/app/(workspace)/invitations/[token]/session-email";
import { ClerkAuthProvider } from "@/components/auth/clerk-auth-provider";
import { AppShell } from "@/components/shell/app-shell";
import type { WorkspaceSwitcherData } from "@/components/shell/workspace-switcher";
import type { ShellPreferenceSnapshot } from "@/components/shell/shell-preferences";
import { clerkConfigured, devAuthBypass } from "@/lib/clerk";
import { getAuthContext, UnauthorizedError } from "@/lib/auth";
import { cachedOpenInvitationsForEmail, cachedPreferences, cachedSwitchableWorkspaces } from "@/lib/cached-shell-reads";
import { listTriageFeed, type TriageFeed } from "@/domains/notifications/feed";
import { resolveInterfaceMode } from "@/domains/identity/preferences";
import type { AuthContext } from "@/domains/identity/resolve";

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
/*
 * The switcher's rows (spec D2): every workspace the session may switch to,
 * plus any open invitation addressed to the session's verified email. An
 * invitation for a workspace already held is noise — an active membership
 * always outranks a stale invite — so it is filtered out here, where both
 * lists are in hand. A read failure leaves the switcher out of the shell
 * rather than taking the layout down, the same honesty rule as the feed.
 */
async function loadWorkspaceSwitcher(auth: AuthContext): Promise<WorkspaceSwitcherData> {
  const [memberships, email] = await Promise.all([
    cachedSwitchableWorkspaces(auth.userId),
    cachedSessionVerifiedEmail(auth),
  ]);
  const held = new Set(memberships.map((membership) => membership.workspaceId));
  const invitations = email ? await cachedOpenInvitationsForEmail(email) : [];
  return {
    currentWorkspaceId: auth.workspaceId,
    memberships,
    pendingInvitations: invitations.filter((invitation) => !held.has(invitation.workspaceId)),
  };
}

export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  let storageScope = "anonymous";
  // The notifications panel is chrome, so its feed is read here once for the
  // whole workspace rather than per page. A read failure must never take the
  // shell down with it: an empty feed is honest, a blank app is not.
  let notifications: TriageFeed = { items: [], counts: { inbox: 0, inFlight: 0, activity: 0 } };
  // The workspace switcher is chrome too: the layout is the one place that
  // already resolves auth per request, so its rows ride the same read.
  let workspaceSwitcher: WorkspaceSwitcherData | null = null;
  // ASH-312: the interface language is an account preference resolved on the
  // server, so every destination renders in the owner's mode on first paint -
  // no client flash, and "auto" settles in the owner's timezone. The public
  // shell (no authenticated workspace) renders the library default: there is
  // no owner timezone to settle "auto" in, and the clock is never read where
  // a route may prerender.
  let interfaceMode: "library" | "action" = "library";
  let shellPreferences: ShellPreferenceSnapshot = { scope: "anonymous", kind: "unavailable", authenticated: false };
  let authContext: AuthContext | null = null;
  try {
    // Resolving the preference is per-request I/O (the row, and the clock for
    // "auto"): opt the shell out of prerendering before either is read, so a
    // statically evaluated route never samples `new Date()` at build time.
    await io();
    authContext = await getAuthContext();
    if (authContext) {
      const preferenceScope = createHash("sha256")
        .update(`${authContext.userId}:${authContext.workspaceId}`)
        .digest("hex");
      shellPreferences = { scope: preferenceScope, kind: "unavailable", authenticated: true };
      const [preferences, feed, switcher] = await Promise.all([
        cachedPreferences(authContext),
        listTriageFeed(authContext).catch(() => notifications),
        loadWorkspaceSwitcher(authContext).catch(() => null),
      ]);
      interfaceMode = resolveInterfaceMode(preferences.interfaceMode, preferences.timezone);
      shellPreferences = {
        scope: preferenceScope,
        kind: "ready",
        version: preferences.version,
        appearance: preferences.appearance,
      };
      notifications = feed;
      workspaceSwitcher = switcher;
    }
  } catch (error) {
    // Default deny, preserved: getAuthContext throws exactly one error when a
    // session is required and absent, and that is the redirect. It propagates
    // from inside this catch - nothing has rendered yet, the same point the
    // guard below would have reached. Every other failure (a preference read,
    // a cached read) falls through to default mode.
    if (error instanceof UnauthorizedError) redirect("/landing");
    // A preference read failure never blocks the workspace; default mode.
  }
  if (clerkConfigured && !devAuthBypass) {
    if (authContext?.clerkUserId) {
      // The context getAuthContext resolved already proves the session, and
      // its Clerk user id is the same value auth() returned here - this layout
      // no longer spends a second session resolution per request. Any context
      // without one (a machine session, or resolution that failed above) falls
      // through to the original probe below, byte-for-byte.
      storageScope = createHash("sha256").update(authContext.clerkUserId).digest("hex");
    } else {
      const { userId } = await auth();
      if (!userId) redirect("/landing");
      storageScope = createHash("sha256").update(userId).digest("hex");
    }
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
    return (
      <AppShell
        storageScope={storageScope}
        clerkConfigured={false}
        interfaceMode={interfaceMode}
        notifications={notifications}
        shellPreferences={shellPreferences}
        workspaceSwitcher={workspaceSwitcher}
      >
        {children}
      </AppShell>
    );
  }
  return (
    <ClerkAuthProvider>
      <AppShell
        storageScope={storageScope}
        clerkConfigured
        interfaceMode={interfaceMode}
        notifications={notifications}
        shellPreferences={shellPreferences}
        workspaceSwitcher={workspaceSwitcher}
      >
        {children}
      </AppShell>
    </ClerkAuthProvider>
  );
}
