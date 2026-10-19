"use client";

import { Suspense, useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { PreviewStorageWarning, WorkspaceProvider } from "@/components/workspace/workspace-provider";
import { SideNav } from "@/components/shell/side-nav";
import { MobileNav } from "@/components/shell/mobile-nav";
import { TopBar } from "@/components/shell/top-bar";
import { PreviewBanner } from "@/components/shell/preview-banner";
import { appForPath, isBrowserPreviewPath } from "@/lib/navigation";
import { FocusDock } from "@/components/shell/focus-dock";
import { Skeleton } from "@/components/ui/skeleton";

const subscribeToHydration = () => () => {};

/*
 * The shell is global chrome: header, the app's own nav, the canvas, and the
 * mobile bar. Nothing here knows what a destination is.
 *
 * `data-app` is set per app rather than per page, and that attribute is what
 * scopes `--app-accent` — so every component inside an app inherits that app's
 * personality without any of them knowing which app they are in.
 *
 * A client component only because the app is derived from the pathname; the
 * layout above it stays a server component, so the auth guard there is
 * unaffected.
 */
export function AppShell({ children, storageScope = "anonymous", clerkConfigured = false }: { children: ReactNode; storageScope?: string; clerkConfigured?: boolean }) {
  const pathname = usePathname();
  const app = appForPath(pathname);
  const hydrated = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  // Browser-preview records live in localStorage; rendering the server's sample
  // snapshot first flashed stale rows before the stored workspace replaced them.
  const waitingForStorage = !hydrated && isBrowserPreviewPath(pathname);

  return (
    <WorkspaceProvider key={storageScope} storageScope={storageScope}>
      <a href="#content" className="skip-link">Skip to content</a>
      <div data-app={app?.slug} className="flex min-h-dvh flex-1">
        <SideNav />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar clerkConfigured={clerkConfigured} />
          <main id="content" tabIndex={-1} className="flex min-w-0 flex-1 flex-col">
            <Suspense fallback={null}><PreviewBanner /></Suspense>
            {isBrowserPreviewPath(pathname) ? <PreviewStorageWarning /> : null}
            {waitingForStorage ? <PreviewSkeleton /> : null}
            {/* Still rendered while hidden so the segment stays server-rendered for instant navigation. */}
            <div hidden={waitingForStorage} className="flex min-w-0 flex-1 flex-col">{children}</div>
            <FocusDock />
          </main>
          <MobileNav />
        </div>
      </div>
    </WorkspaceProvider>
  );
}

function PreviewSkeleton() {
  return <div role="status" aria-label="Loading your browser preview" className="suite-screen">
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2"><Skeleton className="h-6 w-40" /><Skeleton className="h-4 w-full max-w-xl" /></div>
      <Skeleton className="h-24 w-full" />
      <div className="grid gap-3 md:grid-cols-2"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>
    </div>
  </div>;
}
