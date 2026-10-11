import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import { Search } from "lucide-react";
import Link from "next/link";
import { PathBreadcrumb } from "@/components/shell/path-breadcrumb";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { clerkConfigured } from "@/lib/clerk";

/*
 * Breadcrumb, search, theme, account. The review count and capture button land
 * with the Reviews and capture flows; a control that does nothing is worse than
 * a control that is not there yet.
 *
 * The theme toggle and the sign-in link are the only client-side pieces, and
 * each is its own island.
 */
export function TopBar() {
  return (
    <header className="border-border bg-background/95 sticky top-0 z-10 flex h-12 items-center gap-3 border-b px-3 backdrop-blur">
      <Link href="/briefing" className="text-sm font-medium tracking-tight md:hidden">
        Axiom
      </Link>

      <PathBreadcrumb />

      <div className="ml-auto flex items-center gap-1">
        {/* Search is a placeholder until the command palette lands (spec § Global command layer). */}
        <button
          type="button"
          disabled
          title="Search arrives with the command palette"
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-8 items-center gap-2 rounded-lg px-2 text-sm disabled:opacity-50"
        >
          <Search aria-hidden className="size-4" />
          <span className="hidden sm:inline">Search</span>
          <Badge variant="secondary" className="hidden font-mono text-xs sm:inline">
            ⌘K
          </Badge>
        </button>

        <ThemeToggle />

        {clerkConfigured ? (
          <>
            <SignedIn>
              <UserButton />
            </SignedIn>
            <SignedOut>
              <Link
                href="/sign-in"
                className="text-muted-foreground hover:text-foreground rounded-lg px-2 py-1 text-sm"
              >
                Sign in
              </Link>
            </SignedOut>
          </>
        ) : null}
      </div>
    </header>
  );
}
