import Link from "next/link";
import { PageHeader, Section } from "@/components/page-header";
import { additionalDestinationsIn, destinations } from "@/lib/navigation";

export const metadata = { title: "More · Polymath" };

/*
 * The full destination index: the rail's pages, then the preview tools and
 * shared services. One product means one list; the historic app prefixes
 * stay in URLs but name nothing in the interface.
 */
export default function MorePage() {
  const sections = [
    { key: "product" as const, label: "Destinations", items: destinations.filter((d) => d.group !== "shared") },
    { key: "shared" as const, label: "Workspace", items: destinations.filter((d) => d.group === "shared") },
    { key: "preview" as const, label: "Preview tools", items: [
      ...additionalDestinationsIn("command-center"),
      ...additionalDestinationsIn("neuralflow"),
      ...additionalDestinationsIn("polymath"),
    ] },
  ];

  return (
    <>
      <PageHeader title="More" />
      <div className="flex flex-col gap-6 page-content">
        {sections.map(({ key, label, items }) => (
          items.length > 0 ? (
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
          ) : null
        ))}
      </div>
    </>
  );
}
