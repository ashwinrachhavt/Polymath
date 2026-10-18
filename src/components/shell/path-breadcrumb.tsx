"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { appForPath, destinationForPath, homeHref } from "@/lib/navigation";

/*
 * The breadcrumb names where you are using the same vocabulary as the switcher
 * and the rail, and it is the one place the app boundary is stated in words:
 * `NeuralFlow / Focus`. Without the app segment a prefixed URL is invisible to
 * the owner, and the suite is only legible when they can see which app they
 * crossed into.
 *
 * No `A · B · C` meta string, no `→` (agents/design.md § Copy).
 */
export function PathBreadcrumb() {
  const pathname = usePathname();
  const app = appForPath(pathname);
  const destination = destinationForPath(pathname);

  if (!destination) {
    return (
      <span className="text-[13px] font-medium tracking-tight">{app?.label ?? "Axiom"}</span>
    );
  }

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1.5 text-[13px]">
        <li className="hidden sm:block">
          <Link href={homeHref} className="text-muted-foreground hover:text-foreground">
            Axiom
          </Link>
        </li>
        {app ? (
          <>
            <li aria-hidden className="text-muted-foreground hidden sm:block">
              /
            </li>
            <li className="text-muted-foreground hidden truncate sm:block">
              <Link href={app.href} className="hover:text-foreground">
                {app.label}
              </Link>
            </li>
          </>
        ) : null}
        <li aria-hidden className="text-muted-foreground hidden sm:block">
          /
        </li>
        {/* The app's own accent on the current page. It is the one place the
            accent appears in global chrome, so the colour tells the owner which
            app they are in even when the label is truncated away. */}
        <li className="text-app-accent truncate font-medium" aria-current="page">
          {destination.label}
        </li>
      </ol>
    </nav>
  );
}
