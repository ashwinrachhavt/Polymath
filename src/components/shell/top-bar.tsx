"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Search, ShieldCheck } from "lucide-react";
import { AppLauncher } from "@/components/shell/app-launcher";
import { PathBreadcrumb } from "@/components/shell/path-breadcrumb";
import { PillNav } from "@/components/shell/pill-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/shell/user-menu";
import { CommandLayer } from "@/components/shell/command-layer";
import { appForPath } from "@/lib/navigation";

/*
 * The Dao header: the app's wordmark on the left, one centered pill of its
 * sections, and the quiet global affordances — search, reviews, theme, the
 * launcher, the account — on the right. Below lg the pill does not fit, so
 * the breadcrumb carries where-you-are instead; the phone keeps its bottom
 * app bar. The search button keeps the rail's old contract: it exists at
 * every width, named "Search workspace", disabled until hydration.
 */

const subscribeToHydration = () => () => {};

export function TopBar({ clerkConfigured }: { clerkConfigured: boolean }) {
  const pathname = usePathname();
  const app = appForPath(pathname);
  const Icon = app?.icon;
  const hydrated = useSyncExternalStore(subscribeToHydration, () => true, () => false);

  return (
    <header className="border-border bg-background/85 sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b px-3 backdrop-blur">
      <div className="lg:hidden">
        <PathBreadcrumb />
      </div>
      <Link
        href={app?.href ?? "/"}
        className="text-foreground hover:text-foreground/80 hidden items-center gap-2 text-[15px] font-medium tracking-tight outline-none focus-visible:ring-ring focus-visible:ring-3 lg:flex"
      >
        {Icon ? <Icon aria-hidden className="size-4 text-app-accent" /> : null}
        {app?.label ?? "Polymath"}
      </Link>

      <div className="pointer-events-none absolute inset-x-0 hidden justify-center lg:flex">
        <div className="pointer-events-auto">
          <PillNav />
        </div>
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-1">
        <CommandLayer />
        <button
          type="button"
          disabled={!hydrated}
          onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
          aria-label="Search workspace"
          aria-keyshortcuts="Meta+K Control+K"
          data-search-trigger
          className="text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 hidden size-8 items-center justify-center rounded-md outline-none focus-visible:ring-ring focus-visible:ring-3 md:flex"
        >
          <Search aria-hidden className="size-4" />
        </button>
        <Link
          href="/reviews"
          aria-label="Open shared reviews"
          title="Shared reviews"
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-8 items-center justify-center rounded-md"
        >
          <ShieldCheck aria-hidden className="size-4" />
        </Link>
        <ThemeToggle />
        <AppLauncher />
        <UserMenu configured={clerkConfigured} />
      </div>
    </header>
  );
}
