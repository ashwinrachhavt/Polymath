import { createHash } from "node:crypto";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { clerkConfigured, devAuthBypass } from "@/lib/clerk";

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
 */
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  let storageScope = "anonymous";
  const clerkSession = clerkConfigured;
  if (clerkSession && !devAuthBypass) {
    const { userId } = await auth();
    if (!userId) redirect("/sign-in");
    storageScope = createHash("sha256").update(userId).digest("hex");
  }

  return <AppShell storageScope={storageScope} clerkConfigured={clerkSession}>{children}</AppShell>;
}
