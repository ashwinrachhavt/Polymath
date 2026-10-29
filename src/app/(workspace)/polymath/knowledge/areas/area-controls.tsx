"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { archiveAreaAction, declareAreaAction, updateAreaAction } from "./actions";

/*
 * Declaring an area is one action: a name and the tags it covers. Editing
 * retags or renames inline; archiving removes the area from the list (the
 * row and its audit history stay). Errors are the domain's own words.
 */

export function NewAreaForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef(crypto.randomUUID());

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await declareAreaAction({
        name,
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
        idempotencyKey: keyRef.current,
      });
      keyRef.current = crypto.randomUUID();
      setName("");
      setTags("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Area name"
          placeholder="Area name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          className="border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 min-w-44 rounded-md border px-3 py-1.5 text-[13px] outline-none focus-visible:ring-3"
        />
        <input
          aria-label="Tags this area covers"
          placeholder="Tags, comma-separated"
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          className="border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 min-w-56 flex-1 rounded-md border px-3 py-1.5 text-[13px] outline-none focus-visible:ring-3"
        />
        <Button type="submit" size="sm" disabled={pending || !name.trim() || !tags.trim()}>
          Declare area
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </form>
  );
}

export function ArchiveAreaButton({ areaId, expectedVersion }: { areaId: string; expectedVersion: number }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef(crypto.randomUUID());

  async function run() {
    setPending(true);
    setError(null);
    try {
      await archiveAreaAction({ areaId, expectedVersion, idempotencyKey: keyRef.current });
      keyRef.current = crypto.randomUUID();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
      setPending(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" size="xs" variant="ghost" disabled={pending} onClick={() => void run()}>
        Archive
      </Button>
      {error && (
        <span role="alert" className="text-destructive text-xs">
          {error}
        </span>
      )}
    </span>
  );
}

type AreaActionProps = { areaId: string; expectedVersion: number; name: string; tags: string[] };

/** Archive plus inline rename/retag, both on the version lock. */
export function AreaActions({ areaId, expectedVersion, name, tags }: AreaActionProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editName, setEditName] = useState(name);
  const [editTags, setEditTags] = useState(tags.join(", "));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef(crypto.randomUUID());

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await updateAreaAction({
        areaId,
        expectedVersion,
        name: editName,
        tags: editTags.split(",").map((tag) => tag.trim()).filter(Boolean),
        idempotencyKey: keyRef.current,
      });
      keyRef.current = crypto.randomUUID();
      setOpen(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <ArchiveAreaButton areaId={areaId} expectedVersion={expectedVersion} />
        <Button type="button" size="xs" variant="ghost" onClick={() => { setOpen((o) => !o); setError(null); }}>
          {open ? "Cancel" : "Edit"}
        </Button>
      </div>
      {open && (
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label="Area name"
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              maxLength={80}
              className="border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 min-w-44 rounded-md border px-3 py-1.5 text-[13px] outline-none focus-visible:ring-3"
            />
            <input
              aria-label="Tags this area covers"
              value={editTags}
              onChange={(event) => setEditTags(event.target.value)}
              placeholder="Tags, comma-separated"
              className="border-input bg-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 min-w-56 flex-1 rounded-md border px-3 py-1.5 text-[13px] outline-none focus-visible:ring-3"
            />
            <Button type="submit" size="sm" disabled={pending || !editName.trim() || !editTags.trim()}>
              Save
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
