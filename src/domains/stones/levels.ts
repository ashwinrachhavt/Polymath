/*
 * Levels: how far a person has come, and which stones that opens. Pure, so the
 * server (which refuses a locked purchase), the shop and the shell all read the
 * same table.
 *
 * XP is the coins a person has EARNED over their lifetime (every positive
 * ledger row, including points carried over from the old reward system), not
 * the stones they own. Spending never lowers a level, which would punish
 * buying; and gating tiers by stones owned would deadlock (you could not buy
 * a precious stone without the level, which would need stones). Level
 * measures the work done, the stones are what it buys.
 */

export type StoneTier = "crystal" | "semi_precious" | "precious" | "legendary";

export type LevelStep = { level: number; name: string; xp: number };

/** Lifetime coins earned at which each level begins. A steady day earns roughly 100 to 150. */
export const LEVELS: readonly LevelStep[] = [
  { level: 1, name: "Pebble", xp: 0 },
  { level: 2, name: "Prospector", xp: 100 },
  { level: 3, name: "Rockhound", xp: 300 },
  { level: 4, name: "Collector", xp: 600 },
  { level: 5, name: "Lapidary", xp: 1000 },
  { level: 6, name: "Gemologist", xp: 1600 },
  { level: 7, name: "Curator", xp: 2500 },
  { level: 8, name: "Connoisseur", xp: 4000 },
  { level: 9, name: "Alchemist", xp: 6000 },
  { level: 10, name: "Grand Jeweler", xp: 9000 },
];

export const MAX_LEVEL = LEVELS[LEVELS.length - 1].level;

export type LevelProgress = {
  level: number;
  name: string;
  /** Lifetime coins earned. */
  earned: number;
  /** The next level, or null at the top. */
  next: LevelStep | null;
  /** Coins still to earn for the next level (0 at the top). */
  toNext: number;
  /** 0 to 1 through the current level (1 at the top). */
  fraction: number;
};

export function levelFor(earned: number): LevelProgress {
  const xp = Math.max(0, earned);
  let index = 0;
  for (let i = 0; i < LEVELS.length; i += 1) if (xp >= LEVELS[i].xp) index = i;
  const current = LEVELS[index];
  const next = LEVELS[index + 1] ?? null;
  return {
    level: current.level,
    name: current.name,
    earned: xp,
    next,
    toNext: next ? next.xp - xp : 0,
    fraction: next ? (xp - current.xp) / (next.xp - current.xp) : 1,
  };
}

/** The level that opens each tier; diamond is the top of the set, gold one step below. */
const TIER_UNLOCK_LEVEL: Record<StoneTier, number> = { crystal: 1, semi_precious: 3, precious: 6, legendary: 9 };

/** The level at which a stone can be bought. */
export function unlockLevel(stone: { slug: string; tier: StoneTier }): number {
  return stone.slug === "diamond" ? MAX_LEVEL : TIER_UNLOCK_LEVEL[stone.tier];
}

export function levelName(level: number): string {
  return LEVELS.find((step) => step.level === level)?.name ?? "";
}

/** What reaching `level` newly opens, in plain words; null when it opens nothing. */
export function unlocksAt(level: number): string | null {
  switch (level) {
    case 3:
      return "Semi-precious stones";
    case 6:
      return "Precious stones";
    case 9:
      return "Gold";
    case 10:
      return "Diamond";
    default:
      return null;
  }
}
