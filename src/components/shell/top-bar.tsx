import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { AppLauncher } from "@/components/shell/app-launcher";
import { PathBreadcrumb } from "@/components/shell/path-breadcrumb";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/shell/user-menu";
import { CommandLayer } from "@/components/shell/command-layer";

/*
 * The header. Where-you-are on the left (the breadcrumb names the app in
 * words); what acts globally on the right: command, reviews, theme, the app
 * launcher, and the account menu. The launcher sits next to the avatar,
 * Google-apps-style, so all "leave this app" affordances live in one corner.
 */
export function TopBar({ clerkConfigured }: { clerkConfigured: boolean }) {
  return (
    <header className="border-border bg-background/85 sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b px-3 backdrop-blur">
      <PathBreadcrumb />

      <div className="ml-auto flex min-w-0 items-center gap-1">
        <CommandLayer />
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
