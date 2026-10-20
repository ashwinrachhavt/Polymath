"use client";

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
 * launcher, the account — on the right. The breadcrumb stays only on narrow
 * screens, where the pill does not fit.
 */
export function TopBar({ clerkConfigured }: { clerkConfigured: boolean }) {
  const pathname = usePathname();
  const app = appForPath(pathname);
  const Icon = app?.icon;

  return (
    <header className="border-border bg-background/85 sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b px-3 backdrop-blur">
      <div className="md:hidden">
        <PathBreadcrumb />
      </div>
      <Link
        href={app?.href ?? "/"}
        className="text-foreground hover:text-foreground/80 hidden items-center gap-2 text-[15px] font-medium tracking-tight outline-none focus-visible:ring-ring focus-visible:ring-3 md:flex"
      >
        {Icon ? <Icon aria-hidden className="size-4 text-app-accent" /> : null}
        {app?.label ?? "Polymath"}
      </Link>

      <div className="pointer-events-none absolute inset-x-0 hidden justify-center md:flex">
        <div className="pointer-events-auto">
          <PillNav />
        </div>
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-1">
        <CommandLayer />
        <button
          type="button"
          aria-label="Search or jump to"
          title="Search or jump to (⌘K)"
          onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-8 items-center justify-center rounded-md outline-none focus-visible:ring-ring focus-visible:ring-3"
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
