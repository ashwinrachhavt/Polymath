"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { destinationForPath, homeHref } from "@/lib/navigation";

/*
 * The breadcrumb names where you are using the same vocabulary as the rail:
 * `Polymath / Focus`. One product means one level of place above the page,
 * so the former app segment is gone.
 *
 * No `A · B · C` meta string, no `→` (agents/design.md § Copy).
 */
export function PathBreadcrumb() {
  const pathname = usePathname();
  const destination = destinationForPath(pathname);

  if (!destination) {
    return (
      <span className="text-[13px] font-medium tracking-tight">Polymath</span>
    );
  }

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1.5 text-[13px]">
        <li className="hidden sm:block">
          <Link href={homeHref} className="text-muted-foreground hover:text-foreground">
            Polymath
          </Link>
        </li>
        <li aria-hidden className="text-muted-foreground hidden sm:block">
          /
        </li>
        <li className="text-foreground truncate font-medium" aria-current="page">
          {destination.label}
        </li>
      </ol>
    </nav>
  );
}
