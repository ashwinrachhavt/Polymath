import Link from "next/link";
import { ArchiveArtifactButton } from "@/app/(workspace)/artifacts/archive-button";
import type { ZettelCardItem } from "@/domains/knowledge/zettels";

/*
 * One idea, as a card: the claim, its evidence, and when it was made. It reads
 * as a statement, not a record — no practice state, no progress, no editorial
 * chrome. `bloom` is deliberately ignored; the card is the idea itself.
 * Delete sits in the corner, a sibling of the link rather than inside it, and
 * shows on hover or focus (always on touch screens, which have no hover). It
 * is hidden with `visibility`, not opacity: a dimmed button is still a button
 * that tools and the settle check see as mid-fade, while a hidden one is out
 * of the page until the card's link takes focus and reveals it.
 */

const stamp = (d: Date) => d.toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });

export function IdeaCard({ item, href }: { item: ZettelCardItem; href: string }) {
  return (
    <div className="group/idea relative flex">
      <Link
        href={href}
        className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-lg border border-border p-3 pr-10 transition-colors outline-none hover:bg-muted/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <h3 className="text-body font-medium">{item.title}</h3>
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
      <ArchiveArtifactButton
        artifactId={item.id}
        noun="idea"
        className="absolute top-2 right-2 invisible group-hover/idea:visible group-focus-within/idea:visible data-[state=armed]:visible [@media(hover:none)]:visible"
      />
    </div>
  );
}
