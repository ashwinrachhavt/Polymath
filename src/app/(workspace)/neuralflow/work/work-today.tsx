"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { completeTaskAction, createTaskAction } from "./actions";

/*
 * Today, read from Postgres. The rows come in from the server component; this
 * island owns only the two interactions (create, complete) and never holds
 * task state of its own — the server revalidates and the list is re-rendered
 * from the database, which is the difference between a task that survives a
 * refresh and one that does not.
 */

export type OpenTask = {
  id: string;
  title: string;
  status: string;
  dueAt: Date | null;
  createdAt: Date;
};

const statusLabel: Record<string, string> = {
  inbox: "Inbox",
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In progress",
  waiting: "Waiting",
  done: "Done",
  cancelled: "Cancelled",
};

function formatDue(dueAt: Date | null): string | null {
  if (!dueAt) return null;
  return dueAt.toISOString().slice(0, 10);
}

export function TaskComposer() {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createTaskAction({ title, dueAt: due || undefined });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setTitle("");
      setDue("");
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <label className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-muted-foreground text-[12px]">New task</span>
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What needs doing?"
          maxLength={300}
          required
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground text-[12px]">Due</span>
        <Input type="date" value={due} onChange={(event) => setDue(event.target.value)} />
      </label>
      <Button type="submit" disabled={pending || title.trim().length === 0}>
        {pending ? "Adding…" : "Add task"}
      </Button>
      {error ? (
        <p className="text-destructive w-full text-[12px]" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function TaskRow({ task }: { task: OpenTask }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <li className="border-border flex items-center gap-3 border-b py-2 last:border-b-0">
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Complete ${task.title}`}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await completeTaskAction(task.id);
            setError(result.ok ? null : result.error);
          })
        }
        className="text-muted-foreground hover:text-foreground -ml-2 shrink-0 px-2"
      >
        <Check aria-hidden />
      </Button>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{task.title}</span>
      {error ? (
        <span className="text-destructive shrink-0 text-[12px]" role="alert">
          {error}
        </span>
      ) : null}
      {formatDue(task.dueAt) ? (
        <span className="text-muted-foreground shrink-0 text-[13px]">{formatDue(task.dueAt)}</span>
      ) : null}
      <span className="text-muted-foreground shrink-0 text-[12px]">
        {statusLabel[task.status] ?? task.status}
      </span>
    </li>
  );
}

export function OpenTaskList({ tasks }: { tasks: OpenTask[] }) {
  if (tasks.length === 0) {
    return (
      <p className="text-muted-foreground text-[13px]">
        Nothing open. Add one above, or accept an obligation in a document review.
      </p>
    );
  }
  return (
    <ul className="flex flex-col">
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
    </ul>
  );
}
