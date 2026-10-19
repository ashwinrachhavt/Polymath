"use client";

import Link from "next/link";
import { useOptimistic, useRef, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Status } from "@/components/workspace/ui";
import { completeTaskAction, createTaskAction, moveTaskAction } from "./actions";

/*
 * Optimistic Work list: Add, Done and Up/Down apply the moment they are
 * clicked, and the version-checked server action is the final word - a
 * conflict or failure restores the server rows as the transition settles
 * (useOptimistic reverts to the base state) and pins the error to the row.
 * Each intent keeps one idempotency key until it succeeds, so a retry after
 * a dropped response replays instead of repeating.
 */

export type WorkListRow = {
  id: string;
  title: string;
  status: "inbox" | "backlog" | "ready" | "in_progress" | "waiting" | "done" | "cancelled";
  priority: "none" | "low" | "medium" | "high" | "urgent";
  dueAt: string | null;
  version: number;
  subtaskCount: number;
  subtasksDone: number;
  blockedBy: number;
};

export type WorkListItem = {
  row: WorkListRow;
  href: string;
  selected: boolean;
  up: { after?: string; before?: string } | null;
  down: { after?: string; before?: string } | null;
};

type Change =
  | { type: "add"; row: WorkListRow }
  | { type: "complete"; id: string }
  | { type: "move"; id: string; dir: "up" | "down" };

const statusLabel: Record<WorkListRow["status"], string> = {
  inbox: "Inbox",
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In progress",
  waiting: "Waiting",
  done: "Done",
  cancelled: "Cancelled",
};

function apply(items: WorkListItem[], change: Change): WorkListItem[] {
  if (change.type === "complete") return items.filter((item) => item.row.id !== change.id);
  if (change.type === "add") {
    const item: WorkListItem = { row: change.row, href: "#", selected: false, up: null, down: null };
    return [item, ...items];
  }
  const index = items.findIndex((item) => item.row.id === change.id);
  const target = change.dir === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function WorkList({
  items,
  canMove,
  showQuickAdd,
  emptyState,
}: {
  items: WorkListItem[];
  canMove: boolean;
  showQuickAdd: boolean;
  emptyState: React.ReactNode;
}) {
  const [optimisticItems, change] = useOptimistic(items, apply);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const intent = useRef<string | null>(null);
  const key = () => (intent.current ??= crypto.randomUUID());

  function run(id: string, fn: () => Promise<{ ok: boolean; error?: string }>, applyChange: Change) {
    setError(null);
    startTransition(async () => {
      change(applyChange);
      try {
        const result = await fn();
        if (!result.ok) {
          intent.current = null;
          setError({ id, message: result.error ?? "The write failed." });
        } else {
          intent.current = null;
        }
      } catch {
        // Network or server failure: keep the key so a retry is idempotent.
        setError({ id, message: "Could not reach the server. Try again." });
      }
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("title") as HTMLInputElement;
    const title = input.value.trim();
    if (!title) return;
    setAddError(null);
    startTransition(async () => {
      change({
        type: "add",
        row: {
          id: `optimistic-${key()}`,
          title,
          status: "inbox",
          priority: "none",
          dueAt: null,
          version: 1,
          subtaskCount: 0,
          subtasksDone: 0,
          blockedBy: 0,
        },
      });
      try {
        const result = await createTaskAction({ title, idempotencyKey: key() });
        if (!result.ok) {
          intent.current = null;
          setAddError(result.error);
          return;
        }
        intent.current = null;
        input.value = "";
      } catch {
        setAddError("Could not reach the server. Try again.");
      }
    });
  }

  return (
    <>
      {showQuickAdd ? (
        <form onSubmit={submit} className="mb-4 flex flex-col gap-1.5">
          <div className="flex gap-2">
            <Input name="title" aria-label="New task title" placeholder="Add a task" maxLength={300} />
            <Button type="submit" disabled={pending}>
              Add task
            </Button>
          </div>
          {addError ? <p role="alert" className="text-xs text-destructive">{addError}</p> : null}
        </form>
      ) : null}
      {optimisticItems.length === 0 ? emptyState : null}
      <ul className="divide-y divide-border">
        {optimisticItems.map((item) => {
          const row = item.row;
          const optimistic = row.id.startsWith("optimistic-");
          return (
            <li key={row.id} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                {optimistic ? (
                  <span className="text-[13px] font-medium text-muted-foreground">{row.title}</span>
                ) : (
                  <Link href={item.href} className="text-[13px] font-medium hover:underline" aria-current={item.selected ? "true" : undefined}>
                    {row.title}
                  </Link>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Status>{statusLabel[row.status]}</Status>
                  {row.priority !== "none" && <Status>{row.priority}</Status>}
                  {row.dueAt && <span className="readout text-xs text-muted-foreground">Due {row.dueAt.slice(0, 10)}</span>}
                  {row.subtaskCount > 0 && <span className="text-xs text-muted-foreground">{row.subtasksDone}/{row.subtaskCount} subtasks</span>}
                  {row.blockedBy > 0 && <Status>Blocked by {row.blockedBy}</Status>}
                </div>
              </div>
              {!optimistic && canMove ? (
                <div className="flex flex-col items-end gap-1">
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending || !item.up}
                      aria-label={`Move ${row.title} up`}
                      onClick={() =>
                        item.up &&
                        run(row.id, () => moveTaskAction({ taskId: row.id, expectedVersion: row.version, afterTaskId: item.up!.after, beforeTaskId: item.up!.before, idempotencyKey: key() }), { type: "move", id: row.id, dir: "up" })
                      }
                    >
                      Up
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending || !item.down}
                      aria-label={`Move ${row.title} down`}
                      onClick={() =>
                        item.down &&
                        run(row.id, () => moveTaskAction({ taskId: row.id, expectedVersion: row.version, afterTaskId: item.down!.after, beforeTaskId: item.down!.before, idempotencyKey: key() }), { type: "move", id: row.id, dir: "down" })
                      }
                    >
                      Down
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      aria-label={`Complete ${row.title}`}
                      onClick={() => run(row.id, () => completeTaskAction(row.id), { type: "complete", id: row.id })}
                    >
                      Done
                    </Button>
                  </div>
                  {error?.id === row.id ? <p role="alert" className="text-xs text-destructive">{error.message}</p> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
