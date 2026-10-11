"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { PreviewStorageWarning, WorkspaceProvider } from "@/components/workspace/workspace-provider";
import { AppNav } from "@/components/shell/app-nav";
import { MobileNav } from "@/components/shell/mobile-nav";
import { TopBar } from "@/components/shell/top-bar";
import { PreviewBanner } from "@/components/shell/preview-banner";
import { appForPath } from "@/lib/navigation";

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
export function AppShell({ children, storageScope = "anonymous" }: { children: ReactNode; storageScope?: string }) {
  const pathname = usePathname();
  const app = appForPath(pathname);

  return (
    <WorkspaceProvider key={storageScope} storageScope={storageScope}>
      <a href="#content" className="skip-link">Skip to content</a>
      <div data-app={app?.slug} className="flex min-h-dvh flex-1 flex-col">
        <TopBar />
        {app ? <AppNav app={app} /> : null}
        <div className="flex flex-1">
          <main id="content" tabIndex={-1} className="flex min-w-0 flex-1 flex-col">
            <PreviewBanner />
            <PreviewStorageWarning />
            {children}
          </main>
        </div>
        <MobileNav />
      </div>
    </WorkspaceProvider>
  );
}
