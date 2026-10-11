import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { clerkConfigured } from "@/lib/clerk";

/*
 * Every destination shares the shell. A route group rather than a path
 * segment, so the shell never appears in a URL.
 *
 * Authorization is checked here, not in the proxy: Clerk's middleware only
 * populates auth context, so without this guard every workspace route is
 * readable by anyone who reaches the URL. Default-deny — an unauthenticated
 * request never renders a destination, whatever the proxy did.
 *
 * When Clerk is unconfigured the app is a local shell with no data behind it,
 * and `auth()` would throw for want of keys, so the guard stands down.
 */
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  if (clerkConfigured) {
    const { userId } = await auth();
    if (!userId) redirect("/sign-in");
  }

  return <AppShell>{children}</AppShell>;
}
