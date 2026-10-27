"use client";

import Link from "next/link";
import { useOptimistic, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseQuickAdd } from "@/domains/work/quick-add";
import { StoneCeremony } from "@/components/products/neuralflow/stone-ceremony";
import { commitTaskAction, completeTaskAction, completeTasksAction, createTaskAction } from "./actions";
import { pruneSelection, toggleSelection } from "./selection";

/*
 * The Work list: rows, not cards. Adding from a list that means "today" writes
 * status ready, so the row the owner just typed appears in the list they typed
 * it into; nothing is silently filed somewhere else. Completion, the sentence
 * prompt, bulk selection and the stone ceremony are unchanged from the
 * previous list - this file owns presentation, the domain owns the writes.
 *
 * Each intent keeps one idempotency key until it succeeds, so a retry after a
 * dropped response replays instead of repeating.
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
};

type Change = { type: "add"; row: WorkListRow } | { type: "complete"; id: string };

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
  return [{ row: change.row, href: "#", selected: false }, ...items];
}

/** Due today in the viewer's own day, compared the way the row displays it. */
function dueLabel(dueAt: string | null): { text: string; today: boolean } | null {
  if (!dueAt) return null;
  const due = dueAt.slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  if (due === today) return { text: "Due today", today: true };
  return { text: `Due ${due}`, today: false };
}

export function WorkList({
  items,
  addToToday,
  emptyState,
  footer,
}: {
  items: WorkListItem[];
  /** Adding here commits to today instead of filing the capture in Inbox. */
  addToToday: boolean;
  emptyState: ReactNode;
  footer?: ReactNode;
}) {
  const router = useRouter();
  const [optimisticItems, change] = useOptimistic(items, apply);
  const [error, setError] = useState<{ id: string; message: string; unrecorded?: string } | null>(null);
  // Completion asks the spec's question first: "what did you actually do?"
  // The draft lives in state so a failed completion reopens the question with
  // the typed sentence intact rather than losing it.
  const [asking, setAsking] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [addError, setAddError] = useState<string | null>(null);
  const [ceremony, setCeremony] = useState<{ sentence?: string } | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [bulkResult, setBulkResult] = useState<{ kind: "info" | "error"; message: string } | null>(null);
  const [pending, startTransition] = useTransition();
  // Prune during render when the items prop changes: a row that left the
  // screen leaves the selection in the same render, so the count the action
  // bar shows never includes an invisible id.
  const [lastItems, setLastItems] = useState(items);
  if (items !== lastItems && !pending) {
    setLastItems(items);
    setSelection((prev) => pruneSelection(prev, new Set(items.map((item) => item.row.id))));
  }
  const intent = useRef<string | null>(null);
  const key = () => (intent.current ??= crypto.randomUUID());

  function run(
    id: string,
    fn: () => Promise<{ ok: boolean; error?: string; kind?: "conflict" | "validation"; quartzEarned?: boolean; sentenceRecorded?: boolean }>,
    applyChange: Change,
    onError?: (kind: "conflict" | "validation" | "retryable", sentenceRecorded?: boolean) => void,
    sentence?: string,
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
          if (result.quartzEarned) setCeremony({ sentence });
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
        // The task's state moved on: never offer another completion.
        // Say the sentence was not recorded ONLY when the server checked the
        // completed task's audit row and found it absent.
        if (sentence && recorded === true) {
          setDrafts((prev) => { const next = { ...prev }; delete next[id]; return next; });
        } else if (sentence && recorded === false) {
          setError({ id, message: "This task was already completed.", unrecorded: sentence });
        }
        router.refresh();
        return;
      }
      setAsking(id);
    }, sentence || undefined);
  }

  function bulkComplete() {
    const ids = selection;
    if (ids.length === 0) return;
    setError(null);
    setBulkResult(null);
    startTransition(async () => {
      try {
        const result = await completeTasksAction(ids);
        if (!result.ok) {
          setBulkResult({ kind: "error", message: result.error });
          return;
        }
        if (result.quartzEarned) setCeremony({});
        if (result.unknown.length > 0) {
          // The batch stopped early: known completions stand, the unknown ids
          // stay selected for a manual, looked-at retry - never an automatic
          // one, because each may already be done.
          setSelection(result.unknown);
          setBulkResult({
            kind: "error",
            message: `Stopped early. Completed ${result.completed.length} of ${ids.length}${result.skipped.length ? `; ${result.skipped.length} could not be completed` : ""}. ${result.unknown.length} may or may not have completed - ${result.unknown.length === 1 ? "it stays" : "they stay"} selected, check before retrying.${result.unattempted.length > 0 ? ` ${result.unattempted.length} were not attempted.` : ""}`,
          });
        } else {
          setSelection([]);
          setBulkResult({
            kind: "info",
            message:
              result.skipped.length === 0
                ? `Completed ${result.completed.length} task${result.completed.length === 1 ? "" : "s"}.`
                : `Completed ${result.completed.length} of ${ids.length}. ${result.skipped.length} could not be completed (already done or no longer available).`,
          });
        }
        router.refresh();
      } catch {
        router.refresh();
        setBulkResult({
          kind: "error",
          message: "The request was interrupted. Some selected tasks may have completed - the list has been refreshed, so check before retrying.",
        });
      }
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
          status: addToToday ? "ready" : "inbox",
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
          status: addToToday ? "ready" : undefined,
        });
        if (!result.ok) {
          intent.current = null;
          setAddError(result.error);
          return;
        }
        intent.current = null;
        input.value = "";
        router.refresh();
      } catch {
        setAddError("Could not reach the server. Try again.");
      }
    });
  }

  return (
    <>
      <form onSubmit={submit} className="mb-2 flex flex-col gap-1.5">
        <div className="flex gap-2">
          <Input
            name="title"
            aria-label="New task title"
            placeholder="Add a task   !high ~30m #tag due friday"
            maxLength={300}
            className="h-9 text-[13px]"
          />
          <Button type="submit" size="sm" className="h-9" disabled={pending}>
            Add task
          </Button>
        </div>
        {addError ? <p role="alert" className="text-xs text-destructive">{addError}</p> : null}
      </form>

      {selection.length > 0 ? (
        <div role="group" aria-label="Bulk selection actions" className="mb-2 flex flex-wrap items-center gap-2 border-b border-border pb-2">
          <span className="text-xs text-muted-foreground">{selection.length} selected</span>
          <Button size="sm" variant="outline" disabled={pending} onClick={bulkComplete}>
            Complete {selection.length} selected
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setSelection([]); setBulkResult(null); }}>
            Clear
          </Button>
        </div>
      ) : null}
      {bulkResult ? (
        <p role={bulkResult.kind === "error" ? "alert" : "status"} className={`mb-2 text-xs ${bulkResult.kind === "error" ? "text-destructive" : "text-muted-foreground"}`}>
          {bulkResult.message}
        </p>
      ) : null}

      {optimisticItems.length === 0 ? emptyState : null}

      <ul className="divide-y divide-border/60">
        {optimisticItems.map((item) => {
          const row = item.row;
          const optimistic = row.id.startsWith("optimistic-");
          const due = dueLabel(row.dueAt);
          return (
            <li key={row.id}>
              <div className="flex min-h-11 items-center gap-3 py-1.5">
                {!optimistic ? (
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.title}`}
                    checked={selection.includes(row.id)}
                    disabled={pending}
                    onChange={() => { setSelection((prev) => toggleSelection(prev, row.id)); setBulkResult(null); }}
                    className="size-4 shrink-0 accent-foreground"
                  />
                ) : (
                  <span aria-hidden className="size-4 shrink-0" />
                )}

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                    {optimistic ? (
                      <span className="text-[13px] font-medium text-muted-foreground">{row.title}</span>
                    ) : (
                      <Link
                        href={item.href}
                        className="min-w-0 truncate text-[13px] text-foreground hover:underline"
                        aria-current={item.selected ? "true" : undefined}
                      >
                        {row.title}
                      </Link>
                    )}
                    <span className="text-[11px] text-muted-foreground">{statusLabel[row.status]}</span>
                    {row.priority !== "none" ? <span className="text-[11px] text-muted-foreground">{row.priority}</span> : null}
                    {due ? (
                      <span className={`readout text-[11px] ${due.today ? "text-primary" : "text-muted-foreground"}`}>{due.text}</span>
                    ) : null}
                    {row.subtaskCount > 0 ? (
                      <span className="readout text-[11px] text-muted-foreground">{row.subtasksDone}/{row.subtaskCount}</span>
                    ) : null}
                    {row.blockedBy > 0 ? (
                      <span className="text-[11px] text-muted-foreground">Blocked by {row.blockedBy}</span>
                    ) : null}
                  </div>
                  {error?.id === row.id ? (
                    <div className="mt-1">
                      <p role="alert" className="text-xs text-destructive">{error.message}</p>
                      {error.unrecorded ? (
                        <p className="text-xs text-muted-foreground">Your sentence was not recorded: &quot;{error.unrecorded}&quot;</p>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {!optimistic ? (
                  <div className="flex shrink-0 items-center">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      aria-label={`Done: complete ${row.title}`}
                      aria-expanded={asking === row.id}
                      onClick={() => setAsking(asking === row.id ? null : row.id)}
                      className="text-[12px] text-muted-foreground"
                    >
                      Done
                    </Button>
                  </div>
                ) : null}
              </div>

              {asking === row.id ? (
                <form onSubmit={(event) => submitCompletion(event, row.id)} className="mb-2 ml-7 flex max-w-sm flex-col gap-1.5">
                  <label className="text-xs text-muted-foreground" htmlFor={`sentence-${row.id}`}>
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
                    <Button type="submit" size="sm" disabled={pending}>Complete</Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => { setAsking(null); run(row.id, () => completeTaskAction(row.id), { type: "complete", id: row.id }); }}
                    >
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

      {footer}

      {ceremony ? <StoneCeremony sentence={ceremony.sentence} onDismiss={() => setCeremony(null)} /> : null}
    </>
  );
}

/**
 * Rows that are not committed yet: Next up and Inbox. One quiet text action
 * each, which is the only path from a captured or open task into today.
 */
export function CommitList({
  rows,
  emptyState,
}: {
  /** Each row carries its own href: a function cannot cross into a client component. */
  rows: Array<WorkListRow & { href: string }>;
  emptyState: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  if (rows.length === 0) return <>{emptyState}</>;
  return (
    <ul className="divide-y divide-border/60">
      {rows.map((row) => (
        <li key={row.id}>
          <div className="flex min-h-11 items-center gap-3 py-1.5">
            <Link href={row.href} className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground hover:text-foreground hover:underline">
              {row.title}
            </Link>
            {error?.id === row.id ? <p role="alert" className="text-xs text-destructive">{error.message}</p> : null}
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 text-[12px] text-muted-foreground"
              disabled={pending}
              aria-label={`Commit ${row.title} to today`}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await commitTaskAction({ taskId: row.id, expectedVersion: row.version, idempotencyKey: crypto.randomUUID() });
                  if (!result.ok) {
                    setError({ id: row.id, message: result.error });
                    return;
                  }
                  router.refresh();
                });
              }}
            >
              Commit
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
