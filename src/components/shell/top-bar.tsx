import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import { Search } from "lucide-react";
import Link from "next/link";
import { AppLauncher } from "@/components/shell/app-launcher";
import { PathBreadcrumb } from "@/components/shell/path-breadcrumb";
import { ThemeToggle } from "@/components/theme-toggle";
import { Kbd } from "@/components/ui/kbd";
import { clerkConfigured } from "@/lib/clerk";

/*
 * The one piece of global chrome: the app launcher, the breadcrumb, search,
 * theme, account. Each app's own navigation renders below this, not inside it.
 *
 * The review count and capture button land with the Reviews and capture flows;
 * a control that does nothing is worse than a control that is not there yet.
 *
 * The theme toggle and the sign-in link are the only client-side pieces, and
 * each is its own island.
 *
 * The `⌘K` hint is a real Kbd, not a badge: it is a key, it says so to a
 * screen reader, and it uses the mono face the rest of the machine facts use.
 */
export function TopBar() {
  return (
    <header className="border-border bg-background/85 engraved sticky top-0 z-20 flex h-12 items-center gap-2 border-b px-3 backdrop-blur">
      <AppLauncher />

      <span aria-hidden className="bg-border hidden h-5 w-px md:block" />

      <PathBreadcrumb />

      <div className="ml-auto flex items-center gap-1">
        {/* Search is a placeholder until the command palette lands (spec § Global command layer). */}
        <button
          type="button"
          disabled
          title="Search arrives with the command palette"
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex h-7 items-center gap-2 rounded-md px-2 text-[13px] disabled:opacity-50"
        >
          <Search aria-hidden className="size-4" />
          <span className="hidden sm:inline">Search</span>
          <Kbd className="hidden sm:inline-flex">⌘K</Kbd>
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
                className="text-muted-foreground hover:text-foreground rounded-md px-2 py-1 text-[13px]"
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
