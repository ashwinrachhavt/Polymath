"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { CoinGlyph, formatCoins } from "./coin";
import { levelName, unlocksAt, type LevelProgress } from "@/domains/stones/levels";

/*
 * The quiet standing in the shell: the coin balance, the level, and a hairline
 * of progress to the next level. Reaching a new level shows one small notice
 * for a few seconds: the person's last-seen level is remembered per browser
 * (a convenience, not state: the level itself is derived from the ledger), and
 * the first visit only records it, so nobody is congratulated for a level they
 * already had.
 */

const NOTICE_MS = 4500;

function seenKey(scope: string): string {
  return `polymath.stones.level.${scope}`;
}

export function LevelChip({ balance, level, scope }: { balance: number; level: LevelProgress; scope: string }) {
  const [reached, setReached] = useState<number | null>(null);

  useEffect(() => {
    let last: number | null = null;
    try {
      const stored = window.localStorage.getItem(seenKey(scope));
      last = stored === null ? null : Number(stored);
      window.localStorage.setItem(seenKey(scope), String(level.level));
    } catch {
      return;
    }
    if (last === null || !Number.isFinite(last) || level.level <= last) return;
    const reachedLevel = level.level;
    const show = setTimeout(() => setReached(reachedLevel), 0);
    const hide = setTimeout(() => setReached(null), NOTICE_MS);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, [level.level, scope]);

  const toNext = level.next ? `${formatCoins(level.toNext)} coins to level ${level.next.level}` : "Top level";
  const unlocks = reached ? unlocksAt(reached) : null;

  return (
    <>
      <Link
        href="/learn/stones"
        title={`Level ${level.level}, ${level.name}. ${toNext}.`}
        aria-label={`${formatCoins(balance)} coins, level ${level.level} ${level.name}. ${toNext}.`}
        className="text-muted-foreground hover:text-foreground mr-1 hidden items-center gap-2 rounded-md px-2 py-1 text-xs sm:flex"
      >
        <CoinGlyph />
        <span className="text-foreground tabular-nums">{formatCoins(balance)}</span>
        <span className="flex flex-col gap-0.5">
          <span className="leading-none tabular-nums">Lv {level.level}</span>
          <span aria-hidden className="bg-muted block h-0.5 w-10 overflow-hidden rounded-full">
            <span
              className="block h-full rounded-full bg-[oklch(0.74_0.12_80)] transition-[width] duration-700"
              style={{ width: `${Math.round(level.fraction * 100)}%` }}
            />
          </span>
        </span>
      </Link>
      {reached ? (
        <div role="status" aria-live="polite" className="fixed top-16 right-4 z-50">
          <motion.div
            initial={{ y: -8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="border-border bg-popover flex items-center gap-3 rounded-xl border px-4 py-2.5 text-sm shadow-md"
          >
            <motion.span
              aria-hidden
              initial={{ scale: 0.6 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 260, damping: 12 }}
              className="inline-flex"
            >
              <CoinGlyph className="size-5" />
            </motion.span>
            <span className="flex flex-col">
              <span className="font-medium">
                Level {reached} · {levelName(reached)}
              </span>
              {unlocks ? <span className="text-muted-foreground text-xs">{unlocks} unlocked</span> : null}
            </span>
          </motion.div>
        </div>
      ) : null}
    </>
  );
}
