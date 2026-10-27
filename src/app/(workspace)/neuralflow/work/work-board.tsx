"use client";

import { useOptimistic, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { updateTaskAction, moveTaskAction } from "./actions";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { CardModal } from "./card-modal";

/*
 * The board: one column per status, cards moved between them by dragging.
 *
 * A drop is a status patch, not a reorder - the lane a card lands in IS the
 * field, so one write covers the whole gesture and a failed drop puts the card
 * back where it started. Reordering within a lane stays on the list, which is
 * the surface that owns rank.
 *
 * Drag and drop is native HTML5 rather than a dependency: the gesture is one
 * element onto another, and every browser this app supports has had it for a
 * decade. A keyboard user gets the status control in the card's own panel
 * instead, so nothing here is drag-only.
 */

export type BoardStatus = "inbox" | "backlog" | "ready" | "in_progress" | "waiting" | "done" | "cancelled";

export type BoardCardData = {
  id: string;
  title: string;
  status: BoardStatus;
  priority: "none" | "low" | "medium" | "high" | "urgent";
  dueAt: string | null;
  version: number;
  subtaskCount: number;
  subtasksDone: number;
  blockedBy: number;
};

const LANES: { id: BoardStatus; label: string }[] = [
  { id: "inbox", label: "Inbox" },
  { id: "backlog", label: "Backlog" },
  { id: "ready", label: "Ready" },
  { id: "in_progress", label: "In progress" },
  { id: "waiting", label: "Waiting" },
  { id: "done", label: "Done" },
];

type Change = { type: "move"; id: string; status: BoardStatus };

function apply(cards: BoardCardData[], change: Change): BoardCardData[] {
  return cards.map((card) => (card.id === change.id ? { ...card, status: change.status } : card));
}

export function WorkBoard({
  cards,
  detailBase,
}: {
  cards: BoardCardData[];
  detailBase: string;
}) {
  const router = useRouter();
  const [optimistic, move] = useOptimistic(cards, apply);
  const [pending, startTransition] = useTransition();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<BoardStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const intent = useRef<string | null>(null);
  const opened = openId ? optimistic.find((card) => card.id === openId) ?? null : null;

  const ALL_STATUSES: Array<[BoardStatus, string]> = [
    ["inbox", "Inbox"],
    ["backlog", "Backlog"],
    ["ready", "Ready"],
    ["in_progress", "In progress"],
    ["waiting", "Waiting"],
    ["done", "Done"],
    ["cancelled", "Cancelled"],
  ];

  function changeStatus(card: BoardCardData, status: BoardStatus) {
    if (card.status === status) return;
    setError(null);
    const key = crypto.randomUUID();
    startTransition(async () => {
      move({ type: "move", id: card.id, status });
      const result = await updateTaskAction({ taskId: card.id, expectedVersion: card.version, idempotencyKey: key, patch: { status } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  /**
   * Rank is one global order shared with the list, so a move is a rank between
   * the two cards it lands between in THIS lane - the same arithmetic the old
   * board did, kept because losing it would leave order unchangeable anywhere.
   */
  function reorder(card: BoardCardData, laneCards: BoardCardData[], index: number, direction: -1 | 1) {
    const target = laneCards[index + direction];
    if (!target) return;
    const beyond = laneCards[index + direction * 2];
    setError(null);
    const key = crypto.randomUUID();
    startTransition(async () => {
      const result = await moveTaskAction(
        direction === -1
          ? { taskId: card.id, expectedVersion: card.version, beforeTaskId: target.id, afterTaskId: beyond?.id, idempotencyKey: key }
          : { taskId: card.id, expectedVersion: card.version, afterTaskId: target.id, beforeTaskId: beyond?.id, idempotencyKey: key },
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function drop(status: BoardStatus) {
    const id = dragging;
    setDragging(null);
    setOver(null);
    if (!id) return;
    const card = optimistic.find((c) => c.id === id);
    if (!card || card.status === status) return;
    setError(null);
    intent.current ??= crypto.randomUUID();
    startTransition(async () => {
      move({ type: "move", id, status });
      try {
        const result = await updateTaskAction({
          taskId: id,
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
      } catch {
        setError("Could not move that card. Try again.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 md:mx-0 md:px-0">
        {LANES.map((lane) => {
          const laneCards = optimistic.filter((card) => card.status === lane.id);
          const active = over === lane.id;
          return (
            <section
              key={lane.id}
              aria-label={lane.label}
              onDragOver={(event) => {
                event.preventDefault();
                if (over !== lane.id) setOver(lane.id);
              }}
              onDragLeave={() => setOver((current) => (current === lane.id ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                drop(lane.id);
              }}
              className={`flex w-64 shrink-0 flex-col rounded-lg border p-2.5 transition-colors ${
                active ? "border-primary/60 bg-muted/40" : "border-border/70"
              }`}
            >
              <div className="mb-2 flex items-baseline gap-2 px-0.5">
                <h2 className="text-[12px] font-medium">{lane.label}</h2>
                <span className="readout text-[11px] text-muted-foreground">{laneCards.length}</span>
              </div>

              <ul className="flex min-h-16 flex-col gap-2">
                {laneCards.length === 0 ? (
                  <li className="rounded-md border border-dashed border-border/70 px-2 py-3 text-center text-[11px] text-muted-foreground">
                    {active ? "Drop here" : "Empty"}
                  </li>
                ) : (
                  laneCards.map((card, index) => (
                    <li key={card.id}>
                      <article
                        draggable
                        onDragStart={(event) => {
                          setDragging(card.id);
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", card.id);
                        }}
                        onDragEnd={() => {
                          setDragging(null);
                          setOver(null);
                        }}
                        className={`group cursor-grab rounded-md border border-border/70 bg-card p-2.5 active:cursor-grabbing ${
                          dragging === card.id ? "opacity-50" : ""
                        } ${pending ? "pointer-events-none" : ""}`}
                      >
                        <button
                          type="button"
                          onClick={() => setOpenId(card.id)}
                          className="w-full text-left text-[12px] leading-snug text-foreground hover:underline"
                        >
                          {card.title}
                        </button>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                          {card.priority !== "none" ? <span>{card.priority}</span> : null}
                          {card.dueAt ? <span className="readout">{card.dueAt.slice(0, 10)}</span> : null}
                          {card.subtaskCount > 0 ? (
                            <span className="readout">
                              {card.subtasksDone}/{card.subtaskCount}
                            </span>
                          ) : null}
                          {card.blockedBy > 0 ? <span>Blocked</span> : null}
                        </div>
                        {/* One compact row: the status select is the whole
                            keyboard path for moving a card, and Up/Down keep
                            rank changeable here because the board is where
                            order is read. Revealing them on hover was tried
                            and reverted: hidden-but-laid-out controls left a
                            blank band under every card. */}
                        <div className="mt-1.5 flex items-center gap-1">
                          <Select
                            aria-label={`Move ${card.title} to status`}
                            value={card.status}
                            disabled={pending}
                            className="h-6 min-w-0 flex-1 text-[10px]"
                            onChange={(event) => changeStatus(card, event.target.value as BoardStatus)}
                          >
                            {ALL_STATUSES.map(([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ))}
                          </Select>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 shrink-0 px-1 text-[10px]"
                            disabled={pending || index === 0}
                            aria-label={`Move ${card.title} up`}
                            onClick={() => reorder(card, laneCards, index, -1)}
                          >
                            Up
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 shrink-0 px-1 text-[10px]"
                            disabled={pending || index === laneCards.length - 1}
                            aria-label={`Move ${card.title} down`}
                            onClick={() => reorder(card, laneCards, index, 1)}
                          >
                            Down
                          </Button>
                        </div>
                      </article>
                    </li>
                  ))
                )}
              </ul>
            </section>
          );
        })}
      </div>
      <CardModal
        card={opened}
        open={opened !== null}
        onClose={() => setOpenId(null)}
        fullHref={opened ? `${detailBase}?view=saved&task=${opened.id}` : null}
      />
      <p className="text-[11px] text-muted-foreground">
        Drag a card to change its status.{" "}
        <Link href={`${detailBase}?view=saved`} className="hover:text-foreground hover:underline">
          Open the list
        </Link>{" "}
        for reordering and search.
      </p>
    </div>
  );
}
