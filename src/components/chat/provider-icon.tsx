import {
  BriefcaseBusiness,
  Cloud,
  MessageSquare,
  Palette,
  UserRound,
} from "lucide-react";
import { PROVIDER_MARKS } from "./provider-marks";

/*
 * Provider marks for the connector catalog and the chat's tool activity.
 *
 * DESIGN.md bans per-product colour ("one accent for the whole product"), so
 * these are the brands' official simple-icons marks rendered in currentColor
 * inside the existing .product-mark tile: the tile carries the recognition,
 * the glyph is the real brand shape, and the accent stays a single quiet
 * charcoal. An unknown provider falls back to its initial.
 *
 * Slack, Canva, Salesforce and LinkedIn are not in simple-icons: the project
 * removed them at the brands' request, so resurrecting old copies is off the
 * table. They keep quiet lucide metaphors until a maintained set carries
 * their marks again.
 */
const METAPHOR_ICONS: Record<string, typeof MessageSquare> = {
  slack: MessageSquare,
  canva: Palette,
  salesforce: Cloud,
  linkedin: BriefcaseBusiness,
  people: UserRound,
};

export function ProviderIcon({ provider, displayName }: { provider: string; displayName: string }) {
  const mark = PROVIDER_MARKS[provider];
  if (mark) {
    return (
      <svg aria-hidden viewBox="0 0 24 24" fill="currentColor" className="size-4">
        <path d={mark.path} />
      </svg>
    );
  }
  const Icon = METAPHOR_ICONS[provider];
  if (Icon) return <Icon aria-hidden className="size-4" />;
  return <>{displayName.slice(0, 1)}</>;
}
