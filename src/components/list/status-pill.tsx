import { cn } from "cn";
import type { RelationshipStatus } from "@/domains/crm/status";
import { RELATIONSHIP_STATUS_LABELS } from "@/domains/crm/status";

/*
 * Status pill for relationship state on the People table. The tints are the
 * design language's semantic pastels (agents/design.md), defined here once so
 * the pill is the only place hue carries status — and the word always rides
 * beside it, so the state never depends on colour alone. Quiet enough to sit
 * in a hairline table in both modes.
 */

const TONES = {
  neutral: "border-border bg-muted text-muted-foreground",
  positive: "border-[color-mix(in_oklab,#346538_25%,transparent)] bg-[#EDF3EC] text-[#346538] dark:bg-[#1d2a1c] dark:text-[#9dc49e] dark:border-[#2c3f2b]",
  warm: "border-[color-mix(in_oklab,#956400_25%,transparent)] bg-[#FBF3DB] text-[#956400] dark:bg-[#2e2814] dark:text-[#d8c07c] dark:border-[#453b1c]",
} as const;

export type PillTone = keyof typeof TONES;

export function StatusPill({
  tone = "neutral",
  children,
  className,
}: {
  tone?: PillTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The one status-to-look mapping: label from the shared vocabulary, tone here. */
const STATUS_TONES: Record<RelationshipStatus, PillTone> = {
  active: "positive",
  warm: "warm",
  cold: "neutral",
  dormant: "neutral",
  unknown: "neutral",
};

export function RelationshipStatusPill({ status }: { status: RelationshipStatus }) {
  return <StatusPill tone={STATUS_TONES[status]}>{RELATIONSHIP_STATUS_LABELS[status]}</StatusPill>;
}
