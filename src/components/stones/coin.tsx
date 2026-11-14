import { cn } from "cn";

/* The coin as it appears everywhere: a small gold disc, and amounts with thousands separators. Server-safe. */

export function CoinGlyph({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-3.5 shrink-0 rounded-full ring-1 ring-[oklch(0.62_0.11_75)]/60",
        "bg-[radial-gradient(circle_at_35%_30%,oklch(0.95_0.08_95),oklch(0.78_0.13_80)_55%,oklch(0.6_0.12_70))]",
        className,
      )}
    />
  );
}

export function formatCoins(coins: number): string {
  return coins.toLocaleString("en-US");
}
