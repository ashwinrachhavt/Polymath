import Link from "next/link";
import type { ZettelCardItem } from "@/domains/knowledge/zettels";
import { IdeaCard } from "@/components/polymath/ideas/idea-card";

/*
 * The four projections over one list of ideas, exactly as the old collection
 * offered them: cards, table, timeline, dictionary. Sorting is the view's
 * only job; nothing is fetched or reshaped here, and every view reads the
 * same `items`, so a count or a title never disagrees between them.
 */

export type IdeaView = "cards" | "table" | "timeline" | "dictionary";

const stamp = (d: Date) => d.toLocaleDateString("en", { month: "short", day: "numeric" });

function sortFor(view: IdeaView, items: ZettelCardItem[]): ZettelCardItem[] {
  const copy = [...items];
  if (view === "dictionary") copy.sort((a, b) => a.title.localeCompare(b.title));
  if (view === "timeline") copy.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return copy;
}

function IdeaTable({ items, baseHref }: { items: ZettelCardItem[]; baseHref: string }) {
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th className="py-1.5 pr-3 font-medium">Idea</th>
          <th className="py-1.5 pr-3 font-medium">Tags</th>
          <th className="py-1.5 pr-3 font-medium">Source</th>
          <th className="py-1.5 font-medium">Added</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id} className="border-b border-border/60 last:border-0">
            <td className="py-1.5 pr-3">
              <Link href={`${baseHref}/${item.id}`} className="font-medium underline-offset-2 hover:underline">
                {item.title}
              </Link>
            </td>
            <td className="py-1.5 pr-3">
              <span className="flex flex-wrap gap-1">
                {item.tags.map((tag) => (
                  <span key={tag} className="pill pill-neutral">
                    {tag}
                  </span>
                ))}
              </span>
            </td>
            <td className="py-1.5 pr-3 text-muted-foreground">{item.sourceTitle ? `from ${item.sourceTitle}` : null}</td>
            <td className="py-1.5 text-xs text-muted-foreground">{stamp(item.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function IdeaGrid({ items, view, baseHref }: { items: ZettelCardItem[]; view: IdeaView; baseHref: string }) {
  if (items.length === 0) {
    return <p className="text-[13px] text-muted-foreground">Capture something from Inbox and its ideas appear here.</p>;
  }
  const sorted = sortFor(view, items);
  if (view === "table") return <IdeaTable items={sorted} baseHref={baseHref} />;
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {sorted.map((item) => (
        <li key={item.id} className="flex flex-col">
          <IdeaCard item={item} href={`${baseHref}/${item.id}`} />
        </li>
      ))}
    </ul>
  );
}
