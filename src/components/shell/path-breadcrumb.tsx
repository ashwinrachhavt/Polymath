"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { destinations } from "@/lib/navigation";

/*
 * The breadcrumb names where you are using the same vocabulary as the rail.
 * No `A · B · C` meta string, no `→` (agents/design.md § Copy).
 */
export function PathBreadcrumb() {
  const pathname = usePathname();
  const [segment] = pathname.split("/").filter(Boolean);
  const match = destinations.find((d) => d.href === `/${segment}`);

  if (!match) return <span className="text-sm font-medium tracking-tight">Axiom</span>;

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1.5 text-sm">
        <li className="hidden sm:block">
          <Link href="/briefing" className="text-muted-foreground hover:text-foreground">
            Axiom
          </Link>
        </li>
        <li aria-hidden className="text-muted-foreground hidden sm:block">
          /
        </li>
        <li className="truncate font-medium" aria-current="page">
          {match.label}
        </li>
      </ol>
    </nav>
  );
}
