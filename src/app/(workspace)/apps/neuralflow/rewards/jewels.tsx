import Image from "next/image";
import type { RewardsOverview } from "@/domains/gamification/queries";
import { stoneCatalog } from "@/components/products/neuralflow/stones";

/*
 * The stone collection on the product's own register (ASH-175, owner
 * direction 2026-10-17: stone art and colour live inside reward surfaces).
 * The latest earned stone is the hero at real size on the page ground — no
 * black panel, no glow: the art carries it. The catalogue below is a plain
 * grid where each stone states its earning rule; a stone with no rule yet
 * says so rather than pretending.
 */

export function Jewels({ overview }: { overview: RewardsOverview }) {
  const earnedKeys = new Set(overview.ledger.map((e) => e.definitionKey));
  const unlocked = stoneCatalog.filter((s) => earnedKeys.has(s.slug));
  const hero = unlocked[0] ?? stoneCatalog[0];
  const heroEarned = unlocked.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-label="Latest stone"
        className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-8 text-center"
      >
        <Image
          src={hero.image}
          alt={`${hero.name}${heroEarned ? "" : ", not yet earned"}`}
          width={320}
          height={320}
          sizes="176px"
          className={heroEarned ? "size-40 object-contain" : "size-40 object-contain opacity-40 grayscale"}
          priority
        />
        <div>
          <p className="text-[15px] font-medium">{heroEarned ? hero.name : "Finish a task to earn your first stone"}</p>
          <p className="text-muted-foreground mt-0.5 text-[13px]">{hero.theme}</p>
        </div>
        <p className="readout text-3xl">{overview.totalPoints} <span className="text-muted-foreground text-base">points from the ledger</span></p>
      </section>

      <section aria-label="All stones">
        <h2 className="text-[15px] font-medium">All stones</h2>
        <p className="text-muted-foreground mt-1 text-[13px]">Every stone in the catalog. Locked ones have no earning rule yet.</p>
        <ul className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {stoneCatalog.map((stone) => {
            const open = earnedKeys.has(stone.slug);
            return (
              <li
                key={stone.slug}
                className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-4"
              >
                <Image
                  src={stone.image}
                  alt=""
                  width={160}
                  height={160}
                  sizes="56px"
                  className={open ? "size-14 shrink-0 object-contain" : "size-14 shrink-0 object-contain opacity-40 grayscale"}
                />
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">{stone.name}</p>
                  <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{stone.rule}</p>
                  <p className="mt-1 text-xs font-medium">{open ? "Earned" : <span className="text-muted-foreground">No earning rule yet</span>}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
