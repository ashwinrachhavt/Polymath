import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { AppLauncher } from "@/components/shell/app-launcher";
import { PathBreadcrumb } from "@/components/shell/path-breadcrumb";
import { ThemeToggle } from "@/components/theme-toggle";
import { clerkConfigured } from "@/lib/clerk";

/*
 * The one piece of global chrome: the app launcher, the breadcrumb, search,
 * theme, account. Each app's own navigation renders below this, not inside it.
 *
 * The legacy AppSwitcher/CommandLayer are not here: the launcher replaces them,
 * and rendering both gave the header two switchers. The /apps preview routes
 * still ship for the donor-parity screens; the launcher links into the same
 * destinations at their canonical /command-center, /neuralflow, /alfred paths.
 */
export function TopBar() {
  return (
    <header className="border-border bg-background/85 engraved sticky top-0 z-20 flex h-12 items-center gap-2 border-b px-3 backdrop-blur">
      <AppLauncher />

      <span aria-hidden className="bg-border hidden h-5 w-px md:block" />

      <PathBreadcrumb />

      <div className="ml-auto flex items-center gap-1">
        <Link
          href="/reviews"
          aria-label="Open shared reviews"
          title="Shared reviews"
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-8 items-center justify-center rounded-md"
        >
          <ShieldCheck aria-hidden className="size-4" />
        </Link>
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
