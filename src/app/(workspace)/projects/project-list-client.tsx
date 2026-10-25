"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Folder, Loader2, Pin, PinOff, Plus } from "lucide-react";
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
    description: string | null;
    pinnedAt: Date | null;
    updatedAt: Date;
    documentCount: number;
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
    <li className="group relative flex items-start gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-muted/50">
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-[15px]">
        {project.emoji ?? <Folder className="size-4 text-muted-foreground" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <Link href={`/projects/${project.id}`} className="min-w-0 truncate text-[15px] font-medium hover:underline">
            {project.title}
          </Link>
          {pinned ? <Pin aria-hidden className="size-3 shrink-0 text-muted-foreground" /> : null}
        </div>
        {project.description ? (
          <p className="mt-0.5 line-clamp-1 text-[13px] text-muted-foreground">{project.description}</p>
        ) : null}
        <p className="text-muted-foreground mt-1 text-[12px]">
          {project.documentCount === 0
            ? "No sources yet"
            : `${project.documentCount} source${project.documentCount === 1 ? "" : "s"}`}
          <span className="px-1.5">·</span>
          {timeAgoShort(project.updatedAt)}
        </p>
      </div>
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
