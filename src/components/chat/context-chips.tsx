"use client";

import { Building2, Lightbulb, Loader2, User } from "lucide-react";
import type { ContextChip, MentionEntity } from "./mention-context";

const KIND_LABEL: Record<MentionEntity["kind"], string> = {
  person: "Person",
  company: "Company",
  zettel: "Idea",
};

const KIND_GLYPHS: Record<MentionEntity["kind"], typeof User> = {
  person: User,
  company: Building2,
  zettel: Lightbulb,
};

/*
 * The chip row under the composer: one chip per picked record, carrying its
 * own fetch state. A chip whose fetch failed is visibly destructive and
 * offers Retry; the send path refuses to send while any chip is unresolved.
 * `truncated` comes from the last serialization, so "some context did not
 * fit" is visible rather than silent.
 */
export function ContextChips({
  chips,
  onRemove,
  onRetry,
  truncated = false,
}: {
  chips: ContextChip[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  /** Whether the last serialization dropped a block over budget. */
  truncated?: boolean;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs" data-testid="context-chips">
      {chips.map((chip) => {
        const failed = chip.error !== null;
        const pending = !failed && chip.context === null;
        const Glyph = KIND_GLYPHS[chip.entity.kind];
        return (
          <span
            key={chip.entity.id}
            className={
              failed
                ? "border-destructive bg-destructive/10 text-destructive inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5"
                : "bg-muted inline-flex items-center gap-1 rounded-md px-1.5 py-0.5"
            }
            title={failed ? (chip.error ?? undefined) : undefined}
          >
            <Glyph aria-hidden className="size-3.5 shrink-0" />
            <span className="text-foreground max-w-40 truncate">{chip.entity.title}</span>
            <span>{KIND_LABEL[chip.entity.kind]}</span>
            {pending ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null}
            {failed ? (
              <button
                type="button"
                onClick={() => onRetry(chip.entity.id)}
                className="hover:text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Retry
              </button>
            ) : null}
            <button
              type="button"
              aria-label={`Remove ${chip.entity.title}`}
              onClick={() => onRemove(chip.entity.id)}
              className="hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              ×
            </button>
          </span>
        );
      })}
      {truncated ? <p className="text-destructive w-full">Some context did not fit and was left out.</p> : null}
    </div>
  );
}
