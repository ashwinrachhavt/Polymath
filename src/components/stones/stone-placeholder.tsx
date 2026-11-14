import { useId } from "react";

/*
 * The stand-in for a stone whose art is not drawn yet: a plain gem (or, for
 * crystals, a crystal point) tinted from the catalog's own color words. The
 * wall swaps in the real image as soon as the stone appears in
 * drawn-stones.json, so the set works with any number of drawings.
 */

const TINTS: Array<[RegExp, string]> = [
  [/colou?rless|clear|white|milky/, "oklch(0.93 0.01 250)"],
  [/pink|rose|peach/, "oklch(0.78 0.1 355)"],
  [/red|crimson|scarlet/, "oklch(0.55 0.18 25)"],
  [/orange/, "oklch(0.7 0.15 55)"],
  [/yellow|gold|brass|honey|amber/, "oklch(0.8 0.13 88)"],
  [/teal|turquoise|cyan|aqua/, "oklch(0.7 0.1 195)"],
  [/green/, "oklch(0.6 0.13 150)"],
  [/blue/, "oklch(0.56 0.14 255)"],
  [/violet|purple|lilac|lavender|mauve/, "oklch(0.56 0.14 305)"],
  [/brown|bronze|tan|beige/, "oklch(0.55 0.08 60)"],
  [/black|dark/, "oklch(0.32 0.01 270)"],
  [/gr[ae]y|silver|steel/, "oklch(0.66 0.01 270)"],
];

/** The tint of the first color word in the catalog's description, in reading order. */
export function placeholderTint(color: string): string {
  const text = color.toLowerCase();
  let best: { at: number; tint: string } | null = null;
  for (const [pattern, tint] of TINTS) {
    const at = text.search(pattern);
    if (at >= 0 && (best === null || at < best.at)) best = { at, tint };
  }
  return best?.tint ?? "oklch(0.7 0.02 270)";
}

const GEM = "M30 22 L70 22 L88 42 L50 88 L12 42 Z";
const GEM_FACETS = "M12 42 L88 42 M30 22 L38 42 L50 88 L62 42 L70 22 M38 42 L50 22 L62 42";
const POINT = "M50 8 L70 30 L66 90 L34 90 L30 30 Z";
const POINT_FACETS = "M50 8 L50 90 M30 30 L50 40 L70 30";

export function StonePlaceholder({
  color,
  crystal,
  className,
}: {
  color: string;
  /** Crystals draw as a crystal point; cut gems as a faceted stone. */
  crystal: boolean;
  className?: string;
}) {
  const id = useId();
  const tint = placeholderTint(color);
  return (
    <svg viewBox="0 0 100 100" aria-hidden className={className}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="white" stopOpacity="0.55" />
          <stop offset="0.45" stopColor={tint} />
          <stop offset="1" stopColor={tint} stopOpacity="0.75" />
        </linearGradient>
      </defs>
      <path d={crystal ? POINT : GEM} fill={tint} />
      <path d={crystal ? POINT : GEM} fill={`url(#${id})`} />
      <path
        d={crystal ? POINT_FACETS : GEM_FACETS}
        fill="none"
        stroke="white"
        strokeOpacity="0.45"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
