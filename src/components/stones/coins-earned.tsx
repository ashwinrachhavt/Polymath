"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { useEffect } from "react";
import { CoinGlyph, formatCoins } from "./coin";

/*
 * The earn moment: small and brief on purpose. A coin settles in beside the
 * amount, once; nothing loops, nothing blocks the page, and with reduced
 * motion (the app's MotionConfig) it simply appears.
 */

/** Inline line under a finished quiz or mock interview. */
export function CoinsEarned({ coins }: { coins: number }) {
  return (
    <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-dense">
      <motion.span
        initial={{ y: -6, opacity: 0, rotateY: 90 }}
        animate={{ y: 0, opacity: 1, rotateY: 0 }}
        transition={{ duration: 0.45, ease: "easeOut" }}
        className="inline-flex"
      >
        <CoinGlyph />
      </motion.span>
      <span className="font-medium">+{formatCoins(coins)} coins</span>
      <Link href="/learn/stones" className="text-muted-foreground underline-offset-4 hover:underline">
        Spend them on stones
      </Link>
    </p>
  );
}

const TOAST_MS = 2600;

/** A pill at the bottom of the screen for coins earned away from Learn (a finished task). */
export function CoinsToast({ coins, onDone }: { coins: number; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, TOAST_MS);
    return () => clearTimeout(timer);
  }, [coins, onDone]);
  return (
    <div role="status" aria-live="polite" className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
      <motion.div
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.25, ease: "easeOut" }}
        className="flex items-center gap-2 rounded-full border border-border bg-popover px-3.5 py-1.5 text-sm shadow-md"
      >
        <CoinGlyph />
        <span className="font-medium">+{formatCoins(coins)} coins</span>
      </motion.div>
    </div>
  );
}
