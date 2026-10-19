"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Panel, Status } from "@/components/workspace/ui";
import RichEditor from "@/components/products/alfred/rich-editor";
import { autosaveNoteAction, commitNoteAction, createNoteAction, renameNoteAction } from "./actions";

/*
 * The editing island for the canonical notebook. The body is Markdown inside
 * the artifact's JSONB content ({ format: "markdown", text }) so the existing
 * RichEditor drives it directly. Autosaves land as the working draft behind
 * the artifact's optimistic version; an explicit checkpoint mints the next
 * immutable artifact version. A draft left behind by a crash is offered on
 * load — never applied silently.
 */

const body = (text: string) => ({ format: "markdown", text });

type VersionItem = { id: string; versionNumber: number; reason: string; note: string | null; createdAt: string };

const stamp = (iso: string) =>
  new Date(iso).toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function NewNoteButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError("");
          const result = await createNoteAction({ title: "Untitled note", idempotencyKey: crypto.randomUUID() });
          setPending(false);
          if (!result.ok) return setError(result.error);
          router.push(`/alfred/notebook?id=${result.artifactId}`);
          router.refresh();
        }}
      >
        {pending ? "Creating…" : "New note"}
      </Button>
      {error && <span role="alert" className="text-[13px] text-destructive">{error}</span>}
    </span>
  );
}

export function NoteEditor({
  noteId,
  initialTitle,
  initialVersion,
  initialMarkdown,
  draft,
  versions,
  outlinks,
  backlinks,
}: {
  noteId: string;
  initialTitle: string;
  initialVersion: number;
  initialMarkdown: string;
  draft: { markdown: string; updatedAt: string } | null;
  versions: VersionItem[];
  outlinks: { id: string; title: string }[];
  backlinks: { id: string; title: string }[];
}) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [offer, setOffer] = useState(draft && draft.markdown !== initialMarkdown ? draft : null);
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const versionRef = useRef(initialVersion);
  const savedRef = useRef(initialMarkdown);
  const markdownRef = useRef(initialMarkdown);
  const updateMarkdown = (next: string) => {
    markdownRef.current = next;
    setMarkdown(next);
  };
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mutations serialize: a rename on blur must claim its version before the
  // autosave it raced past fires, or one of them loses the CAS check. The
  // queue keeps the order the owner acted in.
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const enqueue = <T,>(step: () => Promise<T>): Promise<T> => {
    const next = chainRef.current.then(step);
    chainRef.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  useEffect(() => {
    if (markdown === savedRef.current) return;
    setSaveState("dirty");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void enqueue(async () => {
        setSaveState("saving");
        const result = await autosaveNoteAction({
          artifactId: noteId,
          expectedVersion: versionRef.current,
          content: body(markdown),
          plainText: markdown,
          idempotencyKey: crypto.randomUUID(),
        });
        if (!result.ok) {
          setSaveState("error");
          setError(result.error);
          return;
        }
        versionRef.current = result.version;
        savedRef.current = markdown;
        setSaveState("saved");
        setError("");
      });
    }, 1200);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [markdown, noteId]);

  const rename = async () => {
    const next = title.trim();
    if (!next || next === initialTitle) return;
    await enqueue(async () => {
      const result = await renameNoteAction({ artifactId: noteId, expectedVersion: versionRef.current, title: next, idempotencyKey: crypto.randomUUID() });
      if (!result.ok) return setError(result.error);
      versionRef.current = result.version;
      // A rename is a save, and the status gives the owner (and tests) a
      // deterministic point where the new title has landed before they
      // navigate or reload — but it must not paper over a dirty body.
      if (markdownRef.current === savedRef.current) setSaveState("saved");
      router.refresh();
    });
  };

  const checkpoint = async () => {
    setPending(true);
    setError("");
    const result = await enqueue(async () =>
      commitNoteAction({
        artifactId: noteId,
        expectedVersion: versionRef.current,
        content: body(markdown),
        plainText: markdown,
        idempotencyKey: crypto.randomUUID(),
      }),
    );
    setPending(false);
    if (!result.ok) return setError(result.error);
    versionRef.current = result.version;
    savedRef.current = markdown;
    setSaveState("saved");
    router.refresh();
  };

  return (
    <Panel
      title={initialTitle}
      description="Autosaves as a draft; checkpoints are immutable versions."
      actions={
        <span className="flex items-center gap-2">
          {saveState === "saving" && <Status>Saving…</Status>}
          {saveState === "dirty" && <Status>Unsaved changes</Status>}
          {saveState === "saved" && <Status>Saved</Status>}
          {saveState === "error" && <Status>Not saved</Status>}
          <Dialog>
            <DialogTrigger asChild>
              <Button type="button" variant="outline">History</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogTitle>Version history</DialogTitle>
              <DialogDescription>Every checkpoint is immutable — this is what the note said, when.</DialogDescription>
              {versions.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">No checkpoints yet. Save one to start the history.</p>
              ) : (
                <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
                  {versions.map((v) => (
                    <li key={v.id} className="rounded-md border border-border px-3 py-2 text-[13px]">
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-medium">Version {v.versionNumber}</span>
                        <span className="text-xs text-muted-foreground">{stamp(v.createdAt)}</span>
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{v.reason}{v.note ? ` — ${v.note}` : ""}</span>
                    </li>
                  ))}
                </ul>
              )}
            </DialogContent>
          </Dialog>
          <Button type="button" onClick={checkpoint} disabled={pending || saveState === "saving"}>
            {pending ? "Saving…" : "Save checkpoint"}
          </Button>
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        {offer && (
          <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 text-[13px] dark:border-amber-900 dark:bg-amber-950/40">
            <span>A draft from {stamp(offer.updatedAt)} was left unsaved.</span>
            <Button type="button" size="sm" variant="outline" onClick={() => { updateMarkdown(offer.markdown); setOffer(null); }}>
              Restore draft
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOffer(null)}>
              Keep saved version
            </Button>
          </div>
        )}
        <Input aria-label="Note title" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={rename} />
        <RichEditor content={markdown} onChange={updateMarkdown} />
        {(outlinks.length > 0 || backlinks.length > 0) && (
          <div className="grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium text-muted-foreground">Links to</p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {outlinks.map((link) => (
                  <li key={link.id}>
                    <Link className="text-[13px] underline-offset-2 hover:underline" href={`/alfred/notebook?id=${link.id}`}>{link.title}</Link>
                  </li>
                ))}
                {outlinks.length === 0 && <li className="text-[13px] text-muted-foreground">No [[wiki links]] in this note yet.</li>}
              </ul>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Linked from</p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {backlinks.map((link) => (
                  <li key={link.id}>
                    <Link className="text-[13px] underline-offset-2 hover:underline" href={`/alfred/notebook?id=${link.id}`}>{link.title}</Link>
                  </li>
                ))}
                {backlinks.length === 0 && <li className="text-[13px] text-muted-foreground">No notes link here yet.</li>}
              </ul>
            </div>
          </div>
        )}
        {error && <p role="alert" className="text-[13px] text-destructive">{error}</p>}
      </div>
    </Panel>
  );
}
