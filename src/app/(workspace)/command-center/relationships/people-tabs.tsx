import Link from "next/link";

/*
 * People is one rail entry; Companies is a filter inside it, giving the
 * organizations the imported people work at. Both tables keep their own
 * routes, so the tabs are links and each page marks its own as current.
 */
const tabs = [
  { id: "people", label: "People", href: "/command-center/relationships/people" },
  { id: "companies", label: "Companies", href: "/command-center/relationships/companies" },
] as const;

export function PeopleTabs({ active }: { active: (typeof tabs)[number]["id"] }) {
  return (
    <nav aria-label="People or companies" className="flex gap-5 border-b border-border">
      {tabs.map(({ id, label, href }) => {
        const current = active === id;
        return (
          <Link
            key={id}
            href={href}
            aria-current={current ? "page" : undefined}
            className={`-mb-px border-b-2 pb-2 text-body-dense transition-colors ${
              current
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
