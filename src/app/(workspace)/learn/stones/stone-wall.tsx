"use client";

import Image from "next/image";
import Link from "next/link";
import { motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { cn } from "cn";
import { CoinGlyph, formatCoins } from "@/components/stones/coin";
import drawnStones from "@/components/stones/drawn-stones.json";
import { StonePlaceholder } from "@/components/stones/stone-placeholder";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { COIN_RULES } from "@/domains/stones/awards";
import type { CollectionStone } from "@/domains/stones/queries";
import { buyStoneAction } from "./actions";

/*
 * The collection wall. Owned stones show in color; the rest are silhouettes
 * of their own shape with the name and price beneath, so the goal is always
 * visible. Opening a stone shows its card; buying it turns the silhouette
 * into the stone in place.
 */

type Tier = CollectionStone["tier"];

const TIERS: Array<{ tier: Tier; label: string }> = [
  { tier: "legendary", label: "Legendary" },
  { tier: "precious", label: "Precious" },
  { tier: "semi_precious", label: "Semi-precious" },
  { tier: "crystal", label: "Crystals" },
];

const TIER_LABEL = Object.fromEntries(TIERS.map((t) => [t.tier, t.label])) as Record<Tier, string>;

const DRAWN = new Set<string>(drawnStones);

function StoneArt({
  stone,
  owned,
  size,
  eager = false,
}: {
  stone: CollectionStone;
  owned: boolean;
  size: number;
  /** The open card's art loads at once; the wall's loads as it scrolls into view. */
  eager?: boolean;
}) {
  const look = cn(
    "aspect-square h-auto w-full select-none transition-[filter,opacity] duration-700 ease-out",
    owned ? "" : "opacity-[0.13] brightness-0 dark:opacity-[0.16] dark:invert",
  );
  if (!DRAWN.has(stone.slug)) {
    // Not drawn yet: a stand-in in the stone's own color, faint until it is owned.
    return (
      <span role="img" aria-label={owned ? stone.name : `${stone.name}, not collected yet`} className="block p-[12%]">
        <StonePlaceholder
          color={stone.color}
          crystal={stone.tier === "crystal"}
          className={cn(
            "aspect-square h-auto w-full transition-opacity duration-700 ease-out",
            owned ? "" : "opacity-25 saturate-50",
          )}
        />
      </span>
    );
  }
  return (
    <Image
      src={`/stones/${stone.slug}.webp`}
      alt={owned ? stone.name : `${stone.name}, not collected yet`}
      width={size}
      height={size}
      sizes={`${size}px`}
      loading={eager ? "eager" : "lazy"}
      className={look}
      draggable={false}
    />
  );
}

export function StoneWall({ stones, balance: initialBalance }: { stones: CollectionStone[]; balance: number }) {
  const [balance, setBalance] = useState(initialBalance);
  const [justBought, setJustBought] = useState<Set<string>>(new Set());
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const isOwned = (stone: CollectionStone) => stone.ownedAt !== null || justBought.has(stone.slug);
  const ownedCount = stones.filter(isOwned).length;
  const open = stones.find((stone) => stone.slug === openSlug) ?? null;

  return (
    <main className="page-content mx-auto w-full max-w-5xl">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">
            <Link href="/learn" className="underline-offset-4 hover:underline">
              Learn
            </Link>
          </p>
          <h1 className="text-2xl font-medium">Stones</h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Two hundred real minerals and gems. Finishing quizzes, flashcards, mock interviews and tasks earns coins;
            spend them here.
          </p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="flex items-center gap-1.5" aria-label={`${balance} coins`}>
            <CoinGlyph />
            <span className="readout font-medium tabular-nums">{formatCoins(balance)}</span>
          </span>
          <span className="text-muted-foreground tabular-nums">
            {ownedCount}/{stones.length}
          </span>
        </div>
      </header>
      <div
        className="mb-8 h-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Stones collected"
        aria-valuemin={0}
        aria-valuemax={stones.length}
        aria-valuenow={ownedCount}
      >
        <div
          className="h-full rounded-full bg-[oklch(0.74_0.12_80)] transition-[width] duration-700"
          style={{ width: `${stones.length ? (ownedCount / stones.length) * 100 : 0}%` }}
        />
      </div>

      {TIERS.map(({ tier, label }) => {
        const group = stones.filter((stone) => stone.tier === tier);
        if (group.length === 0) return null;
        return (
          <section key={tier} aria-labelledby={`tier-${tier}`} className="mb-10">
            <h2 id={`tier-${tier}`} className="mb-3 flex items-baseline gap-2 text-sm font-medium">
              {label}
              <span className="text-xs font-normal text-muted-foreground tabular-nums">
                {group.filter(isOwned).length} of {group.length}
              </span>
            </h2>
            <ul
              className={cn(
                "grid gap-x-3 gap-y-5",
                tier === "legendary"
                  ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
                  : "grid-cols-3 sm:grid-cols-5 lg:grid-cols-7",
              )}
            >
              {group.map((stone) => {
                const owned = isOwned(stone);
                return (
                  <li key={stone.slug}>
                    <button
                      type="button"
                      onClick={() => setOpenSlug(stone.slug)}
                      className="group flex w-full flex-col items-center gap-1.5 rounded-xl p-1.5 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="block w-full rounded-xl bg-muted/40 p-2 transition-colors group-hover:bg-muted/70">
                        <StoneArt stone={stone} owned={owned} size={tier === "legendary" ? 224 : 160} />
                      </span>
                      <span className={cn("text-xs leading-tight", owned ? "" : "text-muted-foreground")}>
                        {stone.name}
                      </span>
                      <span className="flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
                        {owned ? (
                          "Collected"
                        ) : (
                          <>
                            <CoinGlyph className="size-2.5" />
                            {formatCoins(stone.price)}
                          </>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      <EarningRules />

      <StoneCard
        stone={open}
        owned={open ? isOwned(open) : false}
        balance={balance}
        onClose={() => setOpenSlug(null)}
        onBought={(slug, nextBalance) => {
          setBalance(nextBalance);
          setJustBought((prev) => new Set(prev).add(slug));
        }}
      />
    </main>
  );
}

function StoneCard({
  stone,
  owned,
  balance,
  onClose,
  onBought,
}: {
  stone: CollectionStone | null;
  owned: boolean;
  balance: number;
  onClose: () => void;
  onBought: (slug: string, balance: number) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState<string | null>(null);

  function buy(target: CollectionStone) {
    setError(null);
    startTransition(async () => {
      const result = await buyStoneAction(target.slug).catch(() => ({
        ok: false as const,
        error: "The request did not reach Polymath. Try again.",
      }));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onBought(target.slug, result.balance);
      setCelebrate(target.slug);
      router.refresh();
    });
  }

  const short = stone ? Math.max(0, stone.price - balance) : 0;

  return (
    <Dialog
      open={stone !== null}
      onOpenChange={(next) => {
        if (!next) {
          setError(null);
          setCelebrate(null);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        {stone ? (
          <>
            <div className="relative mx-auto aspect-square w-48">
              {celebrate === stone.slug ? (
                <motion.span
                  aria-hidden
                  className="absolute inset-0 rounded-full bg-[radial-gradient(circle,oklch(0.9_0.09_85/0.55),transparent_65%)]"
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: [0, 1, 0], scale: [0.6, 1.25, 1.4] }}
                  transition={{ duration: 1.2, ease: "easeOut" }}
                />
              ) : null}
              <motion.div
                key={`${stone.slug}-${owned}`}
                initial={celebrate === stone.slug ? { scale: 0.92 } : false}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 220, damping: 14 }}
              >
                <StoneArt stone={stone} owned={owned} size={384} eager />
              </motion.div>
            </div>
            <div className="flex flex-col gap-1 text-center">
              <DialogTitle className="text-lg font-medium">{stone.name}</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                {TIER_LABEL[stone.tier]} · {stone.family}
              </DialogDescription>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Formula</dt>
              <dd>{stone.formula}</dd>
              <dt className="text-muted-foreground">Hardness</dt>
              <dd>{stone.hardness} on the Mohs scale</dd>
              <dt className="text-muted-foreground">Color</dt>
              <dd>{stone.color}</dd>
              <dt className="text-muted-foreground">Found in</dt>
              <dd>{stone.origin}</dd>
            </dl>
            <p className="text-sm leading-relaxed">{stone.fact}</p>
            <p className="border-l-2 border-border pl-3 text-sm italic leading-relaxed text-muted-foreground">
              <span className="not-italic text-xs uppercase tracking-wide">Folklore</span>
              <br />
              {stone.lore}
            </p>
            <div className="flex flex-col items-center gap-1.5 border-t border-border pt-3">
              {owned ? (
                <p role="status" className="text-sm">
                  {celebrate === stone.slug ? "Added to your collection." : "In your collection."}
                </p>
              ) : (
                <>
                  <Button disabled={pending || short > 0} onClick={() => buy(stone)} className="gap-2">
                    <CoinGlyph />
                    {pending ? "Buying…" : `Buy for ${formatCoins(stone.price)}`}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {short > 0
                      ? `${formatCoins(short)} more coins needed. You have ${formatCoins(balance)}.`
                      : `You have ${formatCoins(balance)} coins.`}
                  </p>
                </>
              )}
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EarningRules() {
  const rows = [
    {
      what: "Quiz",
      pays: `${COIN_RULES.quiz.base} to ${COIN_RULES.quiz.base + COIN_RULES.quiz.forScore} coins by score, once per quiz a day`,
      cap: COIN_RULES.quiz.dailyCap,
    },
    {
      what: "Flashcard",
      pays: `${COIN_RULES.flashcard.base} coins per card reviewed, once per card a day`,
      cap: COIN_RULES.flashcard.dailyCap,
    },
    {
      what: "Mock interview",
      pays: `${COIN_RULES.mission_mock.base} to ${COIN_RULES.mission_mock.base + COIN_RULES.mission_mock.forScore} coins by readiness, once per mission a day`,
      cap: COIN_RULES.mission_mock.dailyCap,
    },
    { what: "Task", pays: `${COIN_RULES.task.base} coins per task finished`, cap: COIN_RULES.task.dailyCap },
  ];
  return (
    <section aria-labelledby="earning-title" className="panel rounded-xl p-4">
      <h2 id="earning-title" className="text-sm font-medium">
        How coins are earned
      </h2>
      <ul className="mt-3 divide-y divide-border text-sm">
        {rows.map((row) => (
          <li key={row.what} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2">
            <span>
              <span className="font-medium">{row.what}</span>
              <span className="text-muted-foreground"> · {row.pays}</span>
            </span>
            <span className="text-xs text-muted-foreground">up to {row.cap} a day</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
