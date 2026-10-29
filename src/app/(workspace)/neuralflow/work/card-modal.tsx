"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { updateTaskAction } from "./actions";
import { STATUS_LABEL, STATUS_PILL as statusPill } from "./status-meta";
import type { BoardCardData, BoardStatus } from "./work-board";

/*
 * A card opens here first: one small dialog with the task's own fields, no
 * inspector, no properties chrome. "Open full" is the way out to the editor
 * for the things a card cannot hold (subtasks, dependencies, focus history).
 *
 * The point of the smaller surface is that reviewing a card and editing a task
 * are different jobs; showing the whole inspector for the first one made every
 * glance at a card cost a scroll.
 */
export function CardModal({
  card,
  open,
  onClose,
  fullHref,
}: {
  card: BoardCardData | null;
  open: boolean;
  onClose: () => void;
  fullHref: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const intent = useRef<string | null>(null);

  function changeStatus(status: BoardStatus) {
    if (!card || card.status === status) return;
    setError(null);
    intent.current ??= crypto.randomUUID();
    startTransition(async () => {
      const result = await updateTaskAction({
        taskId: card.id,
        expectedVersion: card.version,
        idempotencyKey: intent.current!,
        patch: { status },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      intent.current = null;
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-w-md gap-3">
        {card ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-[15px] leading-snug">{card.title}</DialogTitle>
              <DialogDescription className="text-[11px] text-muted-foreground">
                {STATUS_LABEL[card.status]}
                {card.priority !== "none" ? ` · ${card.priority}` : ""}
                {card.dueAt ? ` · due ${card.dueAt.slice(0, 10)}` : ""}
              </DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px]">
              <dt className="text-muted-foreground">Status</dt>
              <dd><span className={statusPill[card.status]}>{STATUS_LABEL[card.status]}</span></dd>
              <dt className="text-muted-foreground">Priority</dt>
              <dd>{card.priority === "none" ? "None" : card.priority}</dd>
              <dt className="text-muted-foreground">Due</dt>
              <dd className="readout">{card.dueAt ? card.dueAt.slice(0, 10) : "None"}</dd>
              <dt className="text-muted-foreground">Subtasks</dt>
              <dd className="readout">
                {card.subtaskCount > 0 ? `${card.subtasksDone}/${card.subtaskCount}` : "None"}
              </dd>
              <dt className="text-muted-foreground">Blocked by</dt>
              <dd className="readout">{card.blockedBy > 0 ? card.blockedBy : "None"}</dd>
            </dl>
            {/* The keyboard alternative to dragging: every lane is reachable
                from here, so a card's status never depends on a pointer. */}
            <label className="mt-1 flex flex-col gap-1 text-[12px]">
              <span className="text-muted-foreground">Move to</span>
              <Select
                aria-label={card ? `Move ${card.title} to status` : "Move to status"}
                value={card.status}
                disabled={pending}
                onChange={(event) => changeStatus(event.target.value as BoardStatus)}
              >
                {STATUS_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
            {error ? (
              <p role="alert" className="text-[11px] text-destructive">
                {error}
              </p>
            ) : null}
            {fullHref ? (
              <a
                href={fullHref}
                className="mt-1 inline-flex h-8 items-center self-start rounded-md border border-border px-3 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Open full
              </a>
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const STATUS_OPTIONS: Array<[BoardStatus, string]> = Object.entries(STATUS_LABEL) as Array<[BoardStatus, string]>;
