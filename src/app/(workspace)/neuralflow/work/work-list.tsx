"use client";

import Link from "next/link";
import { useOptimistic, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Status } from "@/components/workspace/ui";
import { parseQuickAdd } from "@/domains/work/quick-add";
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
  const router = useRouter();
  const [optimisticItems, change] = useOptimistic(items, apply);
  // unrecorded: a typed sentence the server confirmed is NOT on the recorded
  // completion. When the server cannot confirm either way, the copy claims
  // neither; a confirmed-recorded sentence clears its draft.
  const [error, setError] = useState<{ id: string; message: string; unrecorded?: string } | null>(null);
  // Completion asks the spec's question first: "what did you actually do?"
  // The sentence rides onto the day's stone when one is earned; answering is
  // optional - "Just complete" finishes with no sentence. The draft lives in
  // state so a failed completion reopens the question with the typed
  // sentence intact rather than losing it.
  const [asking, setAsking] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [addError, setAddError] = useState<string | null>(null);
  const [reward, setReward] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const intent = useRef<string | null>(null);
  const key = () => (intent.current ??= crypto.randomUUID());

  function run(
    id: string,
    fn: () => Promise<{ ok: boolean; error?: string; kind?: "conflict" | "validation"; quartzEarned?: boolean; sentenceRecorded?: boolean }>,
    applyChange: Change,
    onError?: (kind: "conflict" | "validation" | "retryable", sentenceRecorded?: boolean) => void,
  ) {
    setError(null);
    startTransition(async () => {
      change(applyChange);
      try {
        const result = await fn();
        if (!result.ok) {
          intent.current = null;
          setError({ id, message: result.error ?? "The write failed." });
          onError?.(result.kind ?? "retryable", result.sentenceRecorded);
        } else {
          intent.current = null;
          if (result.quartzEarned) setReward("Quartz earned: first task of the day.");
        }
      } catch {
        // Network or server failure: keep the key so a retry is idempotent.
        setError({ id, message: "Could not reach the server. Try again." });
        onError?.("retryable");
      }
    });
  }

  function submitCompletion(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const sentence = (drafts[id] ?? "").trim();
    setAsking(null);
    run(id, () => completeTaskAction(id, sentence || undefined), { type: "complete", id }, (kind, recorded) => {
      if (kind === "conflict") {
        // The task's state moved on: never offer another completion -
        // reconcile the list with the server. Say the sentence was not
        // recorded ONLY when the server checked the completed task's audit
        // row and found it absent; when the check confirms this exact
        // sentence was recorded (a lost response after commit), clear the
        // draft - the work is safely on the stone/audit trail.
        if (sentence && recorded === true) {
          setDrafts((prev) => { const next = { ...prev }; delete next[id]; return next; });
        } else if (sentence && recorded === false) {
          setError({ id, message: "This task was already completed.", unrecorded: sentence });
        }
        router.refresh();
        return;
      }
      // Retryable or a rejected sentence: the row returns and the question
      // reopens; the draft map still holds the sentence, so nothing the
      // person typed is lost.
      setAsking(id);
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("title") as HTMLInputElement;
    const parsed = parseQuickAdd(input.value);
    const title = parsed.title;
    if (!title) return;
    setAddError(null);
    startTransition(async () => {
      change({
        type: "add",
        row: {
          id: `optimistic-${key()}`,
          title,
          status: "inbox",
          priority: parsed.priority ?? "none",
          dueAt: parsed.dueAt ? parsed.dueAt.toISOString() : null,
          version: 1,
          subtaskCount: 0,
          subtasksDone: 0,
          blockedBy: 0,
        },
      });
      try {
        const result = await createTaskAction({
          title,
          priority: parsed.priority,
          estimateMinutes: parsed.estimateMinutes,
          tags: parsed.tags.length ? parsed.tags : undefined,
          dueAt: parsed.dueAt?.toISOString(),
          idempotencyKey: key(),
        });
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
            <Input name="title" aria-label="New task title" placeholder="Add a task  (!high ~30m #tag due friday)" maxLength={300} />
            <Button type="submit" disabled={pending}>
              Add task
            </Button>
          </div>
          {reward ? <p role="status" className="text-xs text-muted-foreground">{reward}</p> : null}
          {addError ? <p role="alert" className="text-xs text-destructive">{addError}</p> : null}
        </form>
      ) : null}
      {optimisticItems.length === 0 ? emptyState : null}
      <ul className="divide-y divide-border">
        {optimisticItems.map((item) => {
          const row = item.row;
          const optimistic = row.id.startsWith("optimistic-");
          return (
            <li key={row.id} className="py-3">
              <div className="flex items-start justify-between gap-3">
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
                      aria-label={`Done: complete ${row.title}`}
                      aria-expanded={asking === row.id}
                      onClick={() => setAsking(asking === row.id ? null : row.id)}
                    >
                      Done
                    </Button>
                  </div>
                  {error?.id === row.id ? (
                    <>
                      <p role="alert" className="text-xs text-destructive">{error.message}</p>
                      {error.unrecorded ? (
                        <p className="max-w-xs text-right text-xs text-muted-foreground">
                          Your sentence was not recorded: &quot;{error.unrecorded}&quot;
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ) : null}
              </div>
              {asking === row.id ? (
                <form onSubmit={(event) => submitCompletion(event, row.id)} className="ml-auto mt-1.5 flex w-full max-w-xs flex-col items-end gap-1.5">
                  <label className="w-full text-xs text-muted-foreground" htmlFor={`sentence-${row.id}`}>
                    What did you actually do?
                  </label>
                  <Input
                    id={`sentence-${row.id}`}
                    name="sentence"
                    maxLength={280}
                    placeholder="One sentence"
                    autoFocus
                    disabled={pending}
                    value={drafts[row.id] ?? ""}
                    onChange={(event) => setDrafts((prev) => ({ ...prev, [row.id]: event.target.value }))}
                  />
                  <div className="flex gap-1">
                    <Button type="submit" size="sm" disabled={pending}>
                      Complete
                    </Button>
                    <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => { setAsking(null); run(row.id, () => completeTaskAction(row.id), { type: "complete", id: row.id }); }}>
                      Just complete
                    </Button>
                    <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setAsking(null)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
