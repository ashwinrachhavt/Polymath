import Image from "next/image";
import type { RewardsOverview } from "@/domains/gamification/queries";
import { stoneCatalog } from "@/components/products/neuralflow/stones";

/*
 * Dao/Opal presentation of the stone collection (ASH-175): a black hero panel
 * with one glowing stone on a pedestal and a blue stat row, then the jewels
 * grid of soft rounded cards (round photo, lowercase name, small-caps state).
 * A jewel is UNLOCKED only when the ledger holds an entry for it; stones with
 * no earning rule yet stay LOCKED rather than pretending.
 */

export function Jewels({ overview }: { overview: RewardsOverview }) {
  const earnedKeys = new Set(overview.ledger.map((e) => e.definitionKey));
  const unlocked = stoneCatalog.filter((s) => earnedKeys.has(s.slug));
  const hero = unlocked[0] ?? stoneCatalog[0];
  const stats = [
    { label: "Stones", value: String(overview.shards.stones) },
    { label: "Shards to claim", value: String(overview.shards.claimable) },
    { label: "Active days", value: String(overview.activeDays) },
  ];

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-label="Latest stone"
        className="relative overflow-hidden rounded-3xl bg-black px-6 py-10 text-white"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-[38%] size-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-80 blur-3xl"
          style={{ background: "radial-gradient(circle, rgba(99,102,241,0.55) 0%, rgba(124,58,237,0.28) 45%, transparent 70%)" }}
        />
        <p className="relative text-xl font-semibold tracking-tight">Stones</p>
        <div className="relative mx-auto mt-4 flex w-44 flex-col items-center">
          <Image
            src={hero.image}
            alt={`${hero.name}${unlocked.length ? "" : ", not yet earned"}`}
            width={320}
            height={320}
            sizes="176px"
            className={unlocked.length ? "size-44 rounded-[45%_45%_50%_50%/55%_55%_45%_45%] object-cover" : "size-44 rounded-[45%_45%_50%_50%/55%_55%_45%_45%] object-cover opacity-40 grayscale"}
            priority
          />
          <div aria-hidden className="-mt-2 h-3 w-28 rounded-full bg-neutral-900 shadow-[0_8px_20px_rgba(0,0,0,0.9)]" />
        </div>
        <div className="relative mt-6 text-center">
          <p className="text-[11px] tracking-[0.18em] text-neutral-400">NOW</p>
          <p className="readout text-5xl font-semibold">{overview.totalPoints}</p>
          <p className="mt-1 text-sm text-neutral-300">
            {unlocked.length ? hero.name : "Finish a task to earn your first stone"}
          </p>
        </div>
        <dl className="relative mt-8 grid grid-cols-3 gap-2 text-center">
          {stats.map((s) => (
            <div key={s.label}>
              <dt className="text-[11px] tracking-[0.14em] text-indigo-300 uppercase">{s.label}</dt>
              <dd className="readout mt-1 text-xl font-semibold text-indigo-200">{s.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-label="All jewels">
        <h2 className="text-2xl font-semibold tracking-tight">All Jewels</h2>
        <p className="mt-1 text-sm text-muted-foreground">Every stone you can earn. Locked ones have no earning rule yet.</p>
        <ul className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
          {stoneCatalog.map((stone) => {
            const open = earnedKeys.has(stone.slug);
            return (
              <li
                key={stone.slug}
                className="flex flex-col items-center gap-2 rounded-2xl border border-border bg-card px-3 py-5 shadow-sm"
              >
                <Image
                  src={stone.image}
                  alt=""
                  width={160}
                  height={160}
                  sizes="80px"
                  className={open ? "size-20 rounded-full object-cover" : "size-20 rounded-full object-cover opacity-40 grayscale"}
                />
                <p className="text-sm font-medium lowercase">{stone.slug}</p>
                <p className="text-[10px] tracking-[0.12em] uppercase text-muted-foreground">{open ? "Unlocked" : "Locked"}</p>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
