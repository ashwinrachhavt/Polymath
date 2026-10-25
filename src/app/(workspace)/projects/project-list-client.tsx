"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Folder, Loader2, Pin, PinOff, Plus , Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { timeAgoShort } from "@/lib/time";
import { createProjectAction, setProjectPinnedAction } from "./project-actions";

/*
 * The projects list controls: the New project button, a project row with the
 * private badge, relative time and pin toggle (Perplexity Spaces parity).
 */

export function SectionRow({ label }: { label: string }) {
  return (
    <div className="mb-1 flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
      <span className="text-[13px] text-muted-foreground">{label}</span>
    </div>
  );
}

export function NewProjectButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function create() {
    setError(null);
    start(async () => {
      const result = await createProjectAction({ name });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setName("");
      router.push(`/projects/${result.id}`);
    });
  }

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus aria-hidden /> New project
      </Button>
    );
  }
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        create();
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Name the project"
        maxLength={200}
        className="border-input bg-background h-8 w-56 rounded-md border px-2 text-sm"
      />
      <Button size="sm" type="submit" disabled={pending || !name.trim()}>
        {pending ? <Loader2 aria-hidden className="animate-spin" /> : "Create"}
      </Button>
      <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {error ? <p role="alert" className="text-destructive text-xs">{error}</p> : null}
    </form>
  );
}

export function ProjectRow({
  project,
}: {
  project: {
    id: string;
    title: string;
    emoji: string | null;
    pinnedAt: Date | null;
    updatedAt: Date;
  };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const pinned = project.pinnedAt != null;

  function togglePin() {
    start(async () => {
      await setProjectPinnedAction({ projectId: project.id, pinned: !pinned });
      router.refresh();
    });
  }

  return (
    <li className="group flex items-center gap-3 rounded-md px-3 py-2.5 hover:bg-muted/50">
      <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <Link href={`/projects/${project.id}`} className="min-w-0 flex-1 truncate text-[15px] hover:underline">
        {project.emoji ? `${project.emoji} ` : ""}
        {project.title}
      </Link>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Lock aria-hidden className="size-3.5" /> Private
      </span>
      <span className="w-16 text-right text-xs text-muted-foreground">{timeAgoShort(project.updatedAt)}</span>
      <button
        type="button"
        aria-label={pinned ? `Unpin ${project.title}` : `Pin ${project.title}`}
        aria-pressed={pinned}
        disabled={pending}
        onClick={togglePin}
        className={`rounded p-1 hover:bg-muted ${pinned ? "" : "opacity-0 group-hover:opacity-100"}`}
      >
        {pending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : pinned ? <Pin aria-hidden className="size-4" /> : <PinOff aria-hidden className="size-4" />}
      </button>
    </li>
  );
}
