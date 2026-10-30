import Link from "next/link";
import type { ZettelCardItem } from "@/domains/knowledge/zettels";

/*
 * One idea, as a card: the claim, its evidence, and when it was made. It reads
 * as a statement, not a record — no practice state, no progress, no editorial
 * chrome. `bloom` is deliberately ignored; the card is the idea itself.
 */

const stamp = (d: Date) => d.toLocaleDateString("en", { month: "short", day: "numeric" });

export function IdeaCard({ item, href }: { item: ZettelCardItem; href: string }) {
  return (
    <Link
      href={href}
      className="flex flex-col gap-1.5 rounded-lg border border-border p-3 transition-colors hover:bg-muted/30"
    >
      <h3 className="text-[15px] font-medium">{item.title}</h3>
      {item.excerpt && <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{item.excerpt}</p>}
      {item.tags.length > 0 && (
        <span className="flex flex-wrap gap-1 pt-0.5">
          {item.tags.map((tag) => (
            <span key={tag} className="pill pill-neutral">
              {tag}
            </span>
          ))}
        </span>
      )}
      <span className="mt-auto flex items-baseline justify-between gap-2 pt-1 text-xs text-muted-foreground">
        {item.sourceTitle && <span className="truncate">from {item.sourceTitle}</span>}
        <span className="ml-auto shrink-0">{stamp(item.createdAt)}</span>
      </span>
    </Link>
  );
}
