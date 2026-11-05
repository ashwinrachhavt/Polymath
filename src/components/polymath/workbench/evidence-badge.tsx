/*
 * The evidence-tier badge (Workbench D2): one component carries the six tiers
 * and the rule the whole surface leans on — a mark never asks color to carry
 * the trust distinction alone. Every badge pairs an icon with a text label,
 * grounded tiers get a solid border and a fill, and the inferred/hypothesis
 * tiers are visibly unfinished: dashed or dotted border, no fill. The
 * accessible text spells the difference out, so it survives color blindness
 * and grayscale alike.
 *
 * Carried from the closed change-brief branch (wb/change-brief @ ac3eb52a);
 * the tier type lives with the brief builders (session-brief.ts) so a
 * section's tier decision is testable without React. The observed tier's mark
 * reads "the parsed agent record" — the diff premise it retired is gone.
 */
import { CircleAlert, CircleCheck, CircleDashed, FileSearch, FileText, Stamp } from "lucide-react";

import type { EvidenceTier } from "@/domains/agents/session-brief";

export type { EvidenceTier };

type TierConfig = {
  label: string;
  /** What makes the claim trustworthy (or not); rendered for screen readers and as the tooltip. */
  description: string;
  icon: typeof FileSearch;
  grounded: boolean;
};

const TIER_CONFIG: Record<EvidenceTier, TierConfig> = {
  observed: { label: "observed", description: "grounded in the parsed agent record", icon: FileSearch, grounded: true },
  "source-backed": {
    label: "source-backed",
    description: "grounded in a quoted source span",
    icon: FileText,
    grounded: true,
  },
  verified: { label: "verified", description: "confirmed by a captured test run", icon: CircleCheck, grounded: true },
  recorded: { label: "recorded", description: "written down by a person at the time", icon: Stamp, grounded: true },
  inferred: {
    label: "inferred",
    description: "reconstructed after the fact; no test or human record confirms it",
    icon: CircleAlert,
    grounded: false,
  },
  hypothesis: {
    label: "hypothesis",
    description: "a prediction; nothing has run yet",
    icon: CircleDashed,
    grounded: false,
  },
};

const GROUNDED_CLASSES = "border-border bg-muted/50 text-foreground";
const UNGROUNDED_CLASSES = "border-border/70 bg-transparent text-muted-foreground";
const BORDER_STYLE: Record<"solid" | "dashed" | "dotted", string> = {
  solid: "border-solid",
  dashed: "border-dashed",
  dotted: "border-dotted",
};

export function EvidenceBadge({ tier, className = "" }: { tier: EvidenceTier; className?: string }) {
  const config = TIER_CONFIG[tier];
  const Icon = config.icon;
  return (
    <span
      title={config.description}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-data leading-4 whitespace-nowrap ${
        config.grounded ? GROUNDED_CLASSES : UNGROUNDED_CLASSES
      } ${BORDER_STYLE[config.grounded ? "solid" : tier === "hypothesis" ? "dotted" : "dashed"]} ${className}`}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span>{config.label}</span>
      {/* The description rides in the accessible text, not just the tooltip: the tier's
          honesty contract is machine-readable, which is what the spec's badge test pins. */}
      <span className="sr-only">: {config.description}</span>
    </span>
  );
}
