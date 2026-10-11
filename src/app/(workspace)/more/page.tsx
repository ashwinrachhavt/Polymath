import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { destinations, mobileDestinations } from "@/lib/navigation";

export const metadata = { title: "More · Axiom" };

/*
 * The mobile overflow. It lists exactly the destinations the bottom bar omits,
 * read from the same source, so nothing can be reachable on desktop and
 * unreachable on a phone.
 */
export default function MorePage() {
  const primary = new Set(mobileDestinations.map((d) => d.href));
  const rest = destinations.filter((d) => !primary.has(d.href));

  return (
    <>
      <PageHeader title="More" purpose="Everything not in the bottom bar." />
      <ul className="flex flex-col px-4 py-2 md:px-6">
        {rest.map(({ href, label, purpose, icon: Icon }) => (
          <li key={href}>
            <Link
              href={href}
              className="border-border hover:bg-muted focus-visible:ring-ring flex min-h-11 items-center gap-3 border-b py-3 outline-none focus-visible:ring-3"
            >
              <Icon aria-hidden className="text-muted-foreground size-4 shrink-0" />
              <span className="flex min-w-0 flex-col">
                <span className="text-[13px] font-medium">{label}</span>
                <span className="text-muted-foreground truncate text-xs">{purpose}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
