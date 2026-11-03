"use client";

import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import type { ZettelCardItem } from "@/domains/knowledge/zettels";
import { motionTransition } from "@/components/motion-config";
import { IdeaCard } from "@/components/polymath/ideas/idea-card";

/*
 * The four projections over one list of ideas, exactly as the old collection
 * offered them: cards, table, timeline, dictionary. Sorting is the view's
 * only job; nothing is fetched or reshaped here, and every view reads the
 * same `items`, so a count or a title never disagrees between them.
 *
 * The cards grid carries the vault's list motion — rows enter at a 2px rise,
 * leave on opacity, and reorder through the one shared transition. The other
 * projections stay static: a table row reflows as its own feedback, and the
 * queue (the In-review segment above this grid) is where decisions animate.
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
    <table className="text-body-dense w-full">
      <thead>
        <tr className="border-border text-muted-foreground border-b text-left text-xs">
          <th className="py-1.5 pr-3 font-medium">Idea</th>
          <th className="py-1.5 pr-3 font-medium">Tags</th>
          <th className="py-1.5 pr-3 font-medium">Source</th>
          <th className="py-1.5 font-medium">Added</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id} className="border-border/60 last:border-0 border-b">
            <td className="py-1.5 pr-3">
              <Link href={`${baseHref}/${item.id}`} className="hover:underline font-medium underline-offset-2">
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
            <td className="text-muted-foreground py-1.5 pr-3">
              {item.sourceTitle ? `from ${item.sourceTitle}` : null}
            </td>
            <td className="text-muted-foreground py-1.5 text-xs">{stamp(item.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function IdeaGrid({ items, view, baseHref }: { items: ZettelCardItem[]; view: IdeaView; baseHref: string }) {
  if (items.length === 0) {
    return (
      <p className="text-body-dense text-muted-foreground">Capture something from Inbox and its ideas appear here.</p>
    );
  }
  const sorted = sortFor(view, items);
  if (view === "table") return <IdeaTable items={sorted} baseHref={baseHref} />;
  return (
    <motion.ul layout className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <AnimatePresence initial={false}>
        {sorted.map((item) => (
          <motion.li
            key={item.id}
            layout
            initial={{ opacity: 0, y: 2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={motionTransition}
            className="flex flex-col"
          >
            <IdeaCard item={item} href={`${baseHref}/${item.id}`} />
          </motion.li>
        ))}
      </AnimatePresence>
    </motion.ul>
  );
}
