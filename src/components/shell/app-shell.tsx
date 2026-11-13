"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { cn } from "cn";
import { PreviewStorageWarning, WorkspaceProvider } from "@/components/workspace/workspace-provider";
import { SideNav } from "@/components/shell/side-nav";
import { MobileNav } from "@/components/shell/mobile-nav";
import { TopBar } from "@/components/shell/top-bar";
import type { TriageFeed } from "@/domains/notifications/triage";
import { isBrowserPreviewPath, isConversationSurface, isFocusSurface } from "@/lib/navigation";
import { FocusDock } from "@/components/shell/focus-dock";
import { DictationMount } from "@/components/speech/dictation-mount";
import { GenerationJobsMount } from "@/components/jobs/generation-jobs";
import { Skeleton } from "@/components/ui/skeleton";
import type { WorkspaceSwitcherData } from "@/components/shell/workspace-switcher";
import type { ShellPreferenceSnapshot } from "@/components/shell/shell-preferences";

const subscribeToHydration = () => () => {};

/*
 * The shell is global chrome: header, the rail, the canvas, and the mobile
 * bar. Nothing here knows what a destination is.
 *
 * A client component only because the browser-preview path is derived from
 * the pathname; the layout above it stays a server component, so the auth
 * guard there is unaffected.
 *
 * The conversation is home, and home reads like a chat screen (z.ai / Linear
 * Agent): the header's breadcrumb row restates the rail's active item on the
 * one destination with no page heading of its own, so it yields its row there.
 * The composer is the page.
 */
export function AppShell({
  children,
  storageScope = "anonymous",
  clerkConfigured = false,
  interfaceMode = "action",
  notifications,
  shellPreferences,
  workspaceSwitcher = null,
}: {
  children: ReactNode;
  storageScope?: string;
  clerkConfigured?: boolean;
  interfaceMode?: "library" | "action";
  notifications: TriageFeed;
  shellPreferences: ShellPreferenceSnapshot;
  workspaceSwitcher?: WorkspaceSwitcherData | null;
}) {
  const pathname = usePathname();
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  // Browser-preview records live in localStorage; rendering the server's empty
  // snapshot first flashed stale rows before the stored workspace replaced them.
  const waitingForStorage = !hydrated && isBrowserPreviewPath(pathname);
  const headerless = isConversationSurface(pathname);
  // Notes is a focus surface: the sidebar starts closed there and opens from the opener or `[`.
  const focusSurface = isFocusSurface(pathname);

  return (
    <WorkspaceProvider key={storageScope} storageScope={storageScope}>
      <a href="#content" className="skip-link">
        Skip to content
      </a>
      {/* ASH-312: the interface language scopes from one attribute; every
          density, typography and contrast token keys off it in globals.css. */}
      {/* The conversation surface scrolls inside its transcript, never as a
          page: the shell div is the definite-height anchor (see
          .shell-conversation in globals.css), and everything below it is a
          min-h-0 flex chain the transcript's own overflow container fills. */}
      <div
        className={cn("flex flex-1", headerless || focusSurface ? "shell-conversation" : "min-h-dvh")}
        data-interface-mode={interfaceMode}
      >
        <SideNav focusSurface={focusSurface} workspaceSwitcher={workspaceSwitcher} />
        <div className={cn("flex min-w-0 flex-1 flex-col", headerless && "min-h-0")}>
          {!headerless ? (
            <TopBar
              key={shellPreferences.scope}
              clerkConfigured={clerkConfigured}
              interfaceMode={interfaceMode}
              notifications={notifications}
              shellPreferences={shellPreferences}
            />
          ) : null}
          <main
            id="content"
            tabIndex={-1}
            className={cn("flex min-w-0 flex-1 flex-col", headerless && "min-h-0 overflow-hidden [flex-basis:0px]")}
            /* Sticky headers anchor below the top bar where one exists; /polymath routes
               render no top bar, so their anchor is the window's own top. */
            style={{ "--topbar-h": headerless ? "0px" : "48px" } as React.CSSProperties}
          >
            {/* Preview mutations are reachable from canonical routes, so the storage warning must be too. It renders null when empty. */}
            <PreviewStorageWarning />
            {waitingForStorage ? <PreviewSkeleton /> : null}
            {/* Still rendered while hidden so the segment stays server-rendered for instant navigation. */}
            <div hidden={waitingForStorage} className="flex min-h-0 min-w-0 flex-1 flex-col">
              {children}
            </div>
            <FocusDock />
          </main>
          {/* Here rather than in TopBar: the conversation routes render no top
              bar, and the chat composer is where dictation matters most. */}
          <DictationMount />
          {/* One connection per tab for background generation; it announces a finished job on any page. */}
          <GenerationJobsMount />
          <MobileNav />
        </div>
      </div>
    </WorkspaceProvider>
  );
}

function PreviewSkeleton() {
  return (
    <div role="status" aria-label="Loading your browser preview" className="suite-screen">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-full max-w-xl" />
        </div>
        <Skeleton className="h-24 w-full" />
        <div className="grid gap-3 md:grid-cols-2">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      </div>
    </div>
  );
}
