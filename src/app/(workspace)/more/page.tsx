import Link from "next/link";
import { PageHeader, Section } from "@/components/page-header";
import { additionalDestinationsIn, apps, destinationsIn } from "@/lib/navigation";

export const metadata = { title: "More · Axiom" };

/*
 * The mobile overflow: the three apps, then every destination in each, read
 * from the same source as the rail. Nothing can be reachable on desktop and
 * unreachable on a phone.
 *
 * Grouped by app rather than listed flat, because an unlabelled list of twelve
 * rows teaches the owner nothing about where the boundary is — and the boundary
 * is the one thing this shell exists to make visible.
 */
export default function MorePage() {
  const sections = [
    ...apps.map((app) => ({ key: app.slug, label: app.label, items: [...destinationsIn(app.slug), ...additionalDestinationsIn(app.slug)] })),
    { key: "shared" as const, label: "Shared", items: destinationsIn("shared") },
  ];

  return (
    <>
      <PageHeader title="More" purpose="Every destination, by app." />
      <div className="flex flex-col gap-6 px-4 py-5 md:px-6">
        {sections.map(({ key, label, items }) => (
          <Section key={key} title={label}>
            <ul className="flex flex-col">
              {items.map(({ href, label: itemLabel, purpose, icon: Icon }) => (
                <li key={href}>
                  <Link
                    href={href}
                    className="border-border hover:bg-muted focus-visible:ring-ring flex min-h-11 items-center gap-3 border-b py-3 outline-none focus-visible:ring-3"
                  >
                    <Icon aria-hidden className="text-muted-foreground size-4 shrink-0" />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-[13px] font-medium">{itemLabel}</span>
                      <span className="text-muted-foreground truncate text-xs">{purpose}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        ))}
      </div>
    </>
  );
}
