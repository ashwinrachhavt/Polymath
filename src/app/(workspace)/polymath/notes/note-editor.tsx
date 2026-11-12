"use client";

import { RELATION_GROUPS, RELATION_LABELS, RELATION_TYPES } from "@/domains/knowledge/relation-vocabulary";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Status } from "@/components/workspace/ui";
import { Skeleton } from "@/components/ui/skeleton";
import { motion } from "motion/react";
import { motionTransition } from "@/components/motion-config";
import { noteLayout } from "./note-layout";
import type { NoteAIRequest } from "@/components/products/polymath/note-ai-menu";
import {
  markdownEditorMode,
  markdownSourceReason,
  type MarkdownEditorMode,
} from "@/components/products/polymath/markdown-preservation";
import {
  applyNoteAIResultAction,
  autosaveNoteAction,
  commitNoteAction,
  createNoteAction,
  findLinkTargetsAction,
  getNoteAIRunOutputAction,
  removeLinkAction,
  renameNoteAction,
  retryNoteEmbeddingAction,
  setLinkRelationAction,
  setNoteTagsAction,
  startNoteAIAction,
} from "./actions";
import { X, History, Info, Link2, Plus, MessageSquare } from "lucide-react";
import { MarginNotes } from "@/components/products/polymath/margin-notes";
import { FindNoteButton, LibraryToggle } from "./notebook-workspace";
import type { LinkPreview } from "@/domains/knowledge/notes";
import type { NoteAICoverage } from "@/domains/knowledge/note-ai";
import { NotionAppendAction } from "./notion-append";
import { NoteCommentsPanel, type PanelComment } from "./note-comments-panel";

/*
 * The editing island for Notes. The body is Markdown inside
 * the artifact's JSONB content ({ format: "markdown", text }) so the existing
 * RichEditor drives it directly. Autosaves land as the working draft behind
 * the artifact's optimistic version; an explicit checkpoint mints the next
 * immutable artifact version.
 *
 * The working draft IS the note: autosave is the save, so the server renders
 * the draft as the page's content and there is no restore banner for it. The
 * only thing a server cannot hold is keystrokes lost inside the debounce
 * window (a crash, a dead network); those are mirrored to localStorage and
 * offered once on the next visit, never applied silently.
 */

/*
 * Tiptap (StarterKit + ProseMirror) is the heaviest client dependency in the
 * app, so the editor loads as its own chunk after the note's title, history
 * and AI panels are interactive. The fallback keeps the layout stable while
 * the chunk streams in.
 */
const RichEditor = dynamic(() => import("@/components/products/polymath/rich-editor"), {
  ssr: false,
  loading: () => (
    <div role="status" aria-label="Loading the editor" className="flex flex-col gap-6 pt-2">
      <Skeleton className="h-5 w-full" />
      <Skeleton className="h-5 w-[94%]" />
      <Skeleton className="h-5 w-full" />
      <Skeleton className="h-5 w-[72%]" />
    </div>
  ),
});

const body = (text: string) => ({ format: "markdown", text });

type VersionItem = { id: string; versionNumber: number; reason: string; note: string | null; createdAt: string };

const stamp = (iso: string) =>
  new Date(iso).toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The server renders in UTC and the browser in local time; the text is expected to differ. */
function Stamp({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {stamp(iso)}
    </time>
  );
}

/*
 * One in-flight AI run against the note. The run's result is staged here as
 * a proposal; accepting it applies the text to the editor and commits a
 * checkpoint with the run's lineage, and discarding just closes the panel —
 * the run itself stays in the history either way.
 */
type AIProposal = {
  runId: string;
  heading: string;
  selection: string;
  /** How much of the note the run read; only a whole-note read may replace the note. */
  coverage: NoteAICoverage;
  state: string;
  output: string | null;
  failed?: boolean;
  notice?: string;
};

const AI_HEADINGS: Record<NoteAIRequest["action"], string> = {
  improve: "Improve writing",
  shorten: "Make shorter",
  summarize: "Summarize",
  translate: "Translate",
  ask: "Answer",
};

const AI_TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/** Rendered as a labelled button in the empty states, as an icon in the note's top row. */
export function NewNoteButton({ icon = false }: { icon?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const create = async () => {
    setPending(true);
    setError("");
    const result = await createNoteAction({ title: "Untitled note", idempotencyKey: crypto.randomUUID() });
    setPending(false);
    if (!result.ok) return setError(result.error);
    router.push(`/polymath/notes?id=${result.artifactId}`);
  };
  return (
    <span className="inline-flex items-center gap-2">
      {icon ? (
        <Button type="button" variant="ghost" size="icon-sm" disabled={pending} aria-label="New note" onClick={create}>
          <Plus aria-hidden className="text-muted-foreground" />
        </Button>
      ) : (
        <Button type="button" disabled={pending} onClick={create}>
          {pending ? "Creating…" : "New note"}
        </Button>
      )}
      {error && (
        <span role="alert" className="text-body-dense text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}

/*
 * Matuschak-style hover preview: the link row stays one scannable line, and
 * hovering or keyboard-focusing it raises a card with the note's kind, the
 * linking context and its opening text. Pure CSS (group-hover/focus), no
 * client state and no extra fetch - the rows already carry excerpt/context.
 */
const RELATION_OPTIONS: [string, string][] = RELATION_TYPES.map((t) => [t, RELATION_LABELS[t] ?? t]);
const RELATION_NAME: Record<string, string> = { ...Object.fromEntries(RELATION_OPTIONS), reference: "Linked" };

/* Name what a link means and why, or remove it. Similarity is not a relationship. */
function LinkEditor({
  noteId,
  link,
  outgoing,
  quiet,
}: {
  noteId: string;
  link: { id: string; linkType: string; context: string | null };
  outgoing: boolean;
  quiet?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState(link.linkType === "reference" ? "related" : link.linkType);
  const [why, setWhy] = useState(link.context && link.linkType !== "reference" ? link.context : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pair = outgoing ? { artifactId: noteId, targetId: link.id } : { artifactId: link.id, targetId: noteId };
  const run = async (fn: () => Promise<{ ok: boolean } & { error?: string }>) => {
    setBusy(true);
    setError("");
    const result = await fn();
    setBusy(false);
    if (!result.ok) return setError(result.error ?? "Could not save.");
    setOpen(false);
  };
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${quiet ? "" : "ml-2 "}text-data text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring`}
      >
        Edit
      </button>
    );
  }
  return (
    <div className="mt-1.5 flex flex-col gap-1.5 rounded-md border border-border bg-background p-2">
      <select
        aria-label="Relationship"
        value={type}
        onChange={(e) => setType(e.target.value)}
        className="h-7 rounded-md border border-border bg-background px-1.5 text-xs"
      >
        {RELATION_GROUPS.map((g) => (
          <optgroup key={g.group} label={g.group}>
            {g.types.map((t) => (
              <option key={t} value={t}>
                {RELATION_LABELS[t]}
              </option>
            ))}
          </optgroup>
        ))}
        <option value="source">{RELATION_LABELS.source}</option>
      </select>
      <input
        aria-label="Why this link exists"
        value={why}
        onChange={(e) => setWhy(e.target.value)}
        placeholder="Why? (one line)"
        maxLength={500}
        className="h-7 rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => setLinkRelationAction({ ...pair, linkType: type as "related", why }))}
          className="rounded-md bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50"
        >
          Save
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
          Cancel
        </button>
        {link.linkType !== "reference" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => removeLinkAction(pair))}
            className="ml-auto text-destructive hover:underline disabled:opacity-50"
          >
            Remove link
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/*
 * A backlink is a reading artifact, not a form row: the note that points here,
 * one line of the context it points with, and nothing that looks like a box.
 * It sits under the body so a zettel's incoming edges are visible while
 * reading, not hidden behind the details inspector.
 */
function BacklinkRow({
  noteId,
  link,
}: {
  noteId: string;
  link: { id: string; title: string; kind: string; linkType: string; context: string | null; excerpt: string | null };
}) {
  const context = link.context?.replace(/\s+/g, " ").trim();
  return (
    <li className="group">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span
          aria-hidden
          className="text-muted-foreground/60 transition-colors group-hover:text-muted-foreground group-focus-within:text-muted-foreground"
        >
          ↖
        </span>
        <Link
          href={`/polymath/notes?id=${link.id}`}
          className="rounded-sm text-body text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {link.title}
        </Link>
        {link.kind === "zettel" && <span className="text-data text-muted-foreground/70">zettel</span>}
        {/* Editing a link is an action on the row, not part of reading it:
            quiet until the row is hovered or focused, still reachable by tab. */}
        <span className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <LinkEditor noteId={noteId} link={link} outgoing={false} quiet />
        </span>
      </div>
      {(context || link.excerpt) && (
        <p className="mt-0.5 pl-5 text-label leading-5 text-muted-foreground/80">
          {context ? `…${context.length > 200 ? `${context.slice(0, 200).trimEnd()}…` : context}…` : link.excerpt}
        </p>
      )}
    </li>
  );
}

function LinkRow({
  noteId,
  outgoing,
  link,
  label,
}: {
  noteId: string;
  outgoing: boolean;
  link: { id: string; title: string; kind: string; linkType: string; context: string | null; excerpt: string | null };
  label: string;
}) {
  return (
    <li className="group relative rounded-md border border-transparent px-2 py-1 hover:border-border hover:bg-muted/40 focus-within:border-border focus-within:bg-muted/40">
      <Link className="text-body-dense underline-offset-2 hover:underline" href={`/polymath/notes?id=${link.id}`}>
        {link.kind === "zettel" && <span className="mr-1 text-data text-muted-foreground">zettel</span>}
        {link.title}
      </Link>
      <span className="ml-2 text-data text-muted-foreground/70">{RELATION_NAME[link.linkType] ?? link.linkType}</span>
      <LinkEditor noteId={noteId} link={link} outgoing={outgoing} />
      {(link.context || link.excerpt) && (
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
          {link.context ? `…${link.context}…` : link.excerpt}
        </p>
      )}
      <div
        role="tooltip"
        aria-label={`${label} ${link.title}`}
        className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-72 rounded-lg border border-border bg-popover p-3 shadow-md group-hover:block group-focus-within:block"
      >
        <p className="text-body-dense font-medium">{link.title}</p>
        {link.context && (
          <p className="mt-1 line-clamp-3 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
            …{link.context}…
          </p>
        )}
        {link.excerpt && <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{link.excerpt}</p>}
        {!link.context && !link.excerpt && <p className="mt-1 text-xs text-muted-foreground">No preview text yet.</p>}
      </div>
    </li>
  );
}

/*
 * Meaning-search indexing state for the open note. Committed versions embed
 * best-effort at save time, so a note written while the embedding provider
 * was unconfigured (or a transient failure) stays out of meaning search with
 * the reason recorded on the artifact. This chip makes that state visible and
 * offers the same kind of retry the notebook sources have - quiet when the
 * current version is indexed or nothing is committed yet.
 */
export type IndexNotice = { kind: "failed"; error: string } | { kind: "unindexed" };

function MeaningIndexStatus({ noteId, notice }: { noteId: string; notice: IndexNotice }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span>{notice.kind === "failed" ? `Not meaning-searchable: ${notice.error}` : "Not meaning-searchable yet"}</span>
      <button
        type="button"
        disabled={pending}
        className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
        onClick={async () => {
          setPending(true);
          setError(null);
          const result = await retryNoteEmbeddingAction({ artifactId: noteId });
          setPending(false);
          if (!result.ok) return setError(result.error);
        }}
      >
        {pending ? "Indexing…" : notice.kind === "failed" ? "Retry indexing" : "Index for meaning search"}
      </button>
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}

export function NoteEditor({
  noteId,
  indexNotice,
  initialTitle,
  initialVersion,
  initialMarkdown,
  kind,
  tags: initialTags,
  createdAt,
  updatedAt,
  savedAt,
  versions,
  outlinks,
  backlinks,
  related,
  comments,
  linkedPreviews,
  missingLinkTitles,
}: {
  noteId: string;
  /** Null while the current version is meaning-searchable or nothing is committed. */
  indexNotice: IndexNotice | null;
  initialTitle: string;
  initialVersion: number;
  initialMarkdown: string;
  kind: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** When the server last durably held this content (the draft's own time when one exists). */
  savedAt: string;
  versions: VersionItem[];
  outlinks: {
    id: string;
    title: string;
    kind: string;
    linkType: string;
    context: string | null;
    excerpt: string | null;
  }[];
  backlinks: {
    id: string;
    title: string;
    kind: string;
    linkType: string;
    context: string | null;
    excerpt: string | null;
  }[];
  related: { id: string; title: string; kind: string; score: number; excerpt: string | null; alreadyLinked: boolean }[];
  comments: PanelComment[];
  /** First lines of the notes this one links to, shown in the margin beside the citing text. */
  linkedPreviews: LinkPreview[];
  /** Titles this note linked to when the server rendered it that name no note: shown muted, not as links. */
  missingLinkTitles: string[];
}) {
  const localKey = `polymath-note-local-${noteId}`;
  const findLinkTargets = useCallback(
    (query: string, mode: "keyword" | "hybrid") => findLinkTargetsAction({ query, mode, excludeId: noteId }),
    [noteId],
  );
  const [title, setTitle] = useState(initialTitle);
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [localOffer, setLocalOffer] = useState<{ markdown: string; savedAt: string } | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [awaitingVersion, setAwaitingVersion] = useState(0);
  const [savedVersions, setSavedVersions] = useState<VersionItem[] | null>(null);
  const history = savedVersions ?? versions;
  const historyReady = !pending && history.some((item) => item.versionNumber >= awaitingVersion);
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
    // Crash insurance, not storage: the server's working draft is the note's
    // durable state. This mirror only covers keystrokes the autosave never
    // got to send (a crash or a dead network inside the debounce), and it is
    // cleared the moment the server confirms the save.
    try {
      window.localStorage.setItem(localKey, JSON.stringify({ markdown, savedAt: new Date().toISOString() }));
    } catch {
      // Storage full or blocked: the server draft still protects the note.
    }
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
        try {
          window.localStorage.removeItem(localKey);
        } catch {
          // Non-fatal: a stale mirror is ignored next load (see the mount effect).
        }
        setSaveState("saved");
        setError("");
      });
    }, 1200);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [markdown, noteId, localKey]);

  const [tags, setTags] = useState<string[]>(initialTags);
  const [tagInput, setTagInput] = useState("");
  const saveTags = async (next: string[]) => {
    setTags(next);
    await enqueue(async () => {
      const result = await setNoteTagsAction({
        artifactId: noteId,
        expectedVersion: versionRef.current,
        tags: next,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) return setError(result.error);
      versionRef.current = result.version;
      setTags(result.tags);
    });
  };
  const addTag = () => {
    const tag = tagInput.trim().toLowerCase();
    if (!tag) return;
    setTagInput("");
    if (!tags.includes(tag)) void saveTags([...tags, tag]);
  };

  const rename = async () => {
    const next = title.trim();
    if (!next || next === initialTitle) return;
    await enqueue(async () => {
      const result = await renameNoteAction({
        artifactId: noteId,
        expectedVersion: versionRef.current,
        title: next,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) return setError(result.error);
      versionRef.current = result.version;
      // A rename is a save, and the status gives the owner (and tests) a
      // deterministic point where the new title has landed before they
      // navigate or reload — but it must not paper over a dirty body.
      if (markdownRef.current === savedRef.current) setSaveState("saved");
    });
  };

  const checkpoint = async () => {
    setPending(true);
    setError("");
    const text = markdownRef.current;
    const result = await enqueue(async () =>
      commitNoteAction({
        artifactId: noteId,
        expectedVersion: versionRef.current,
        content: body(text),
        plainText: text,
        idempotencyKey: crypto.randomUUID(),
      }),
    );
    setPending(false);
    if (!result.ok) return setError(result.error);
    versionRef.current = result.version;
    setAwaitingVersion(result.versionNumber);
    setSavedVersions(result.versions);
    savedRef.current = text;
    try {
      window.localStorage.removeItem(localKey);
    } catch {
      // Non-fatal.
    }
    setSaveState("saved");
  };

  // Cmd/Ctrl+S is the checkpoint: the browser's Save dialog never helps here,
  // and the shortcut should work from anywhere in the editor.
  const checkpointRef = useRef(checkpoint);
  useEffect(() => {
    checkpointRef.current = checkpoint;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void checkpointRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const noteColumnRef = useRef<HTMLDivElement>(null);
  const [editorRoot, setEditorRoot] = useState<HTMLElement | null>(null);
  useEffect(() => setEditorRoot(noteColumnRef.current), []);
  // Scroll-away chrome: once the reader is into the document, the header rows
  // recede; scroll back or hover to return them. The scroller is the suite
  // screen ancestor — the note column never scrolls itself.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const scroller = noteColumnRef.current?.closest(".suite-screen");
    if (!(scroller instanceof HTMLElement)) return;
    const onScroll = () => {
      const next = scroller.scrollTop > 8;
      setScrolled((current) => (current === next ? current : next));
    };
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, []);

  const [ai, setAi] = useState<AIProposal | null>(null);
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const aiBusy = !!ai && !AI_TERMINAL.has(ai.state);

  const startAI = async (request: NoteAIRequest) => {
    if (aiBusy) return;
    setError("");
    const result = await startNoteAIAction({
      artifactId: noteId,
      action: request.action,
      selection: request.selection || undefined,
      question: request.question,
      language: request.language,
    });
    if (!result.ok) return setError(result.error);
    setAi({
      runId: result.runId,
      heading: AI_HEADINGS[request.action],
      selection: request.selection,
      coverage: result.coverage,
      state: "queued",
      output: null,
    });
  };

  // Poll while the run is live; stop at a terminal state, keeping whatever
  // output the run produced for review.
  useEffect(() => {
    if (!ai || AI_TERMINAL.has(ai.state)) return;
    const timer = setTimeout(async () => {
      const result = await getNoteAIRunOutputAction({ runId: ai.runId });
      if (!result.ok)
        return setAi((current) => (current ? { ...current, failed: true, notice: result.error } : current));
      setAi((current) =>
        current ? { ...current, state: result.state, output: result.output ?? current.output } : current,
      );
    }, 3000);
    return () => clearTimeout(timer);
  }, [ai]);

  const acceptAI = async (mode: "replace" | "append" | "replaceNote") => {
    if (!ai?.output) return;
    const output = ai.output.trim();
    const current = markdownRef.current;
    let next: string;
    let notice = "";
    if (mode === "replaceNote") {
      next = output;
    } else if (mode === "append") {
      next = `${current.trimEnd()}\n\n${output}`;
    } else {
      const first = current.indexOf(ai.selection);
      const unique = first >= 0 && current.indexOf(ai.selection, first + 1) === -1;
      if (ai.selection && unique) {
        next = current.slice(0, first) + output + current.slice(first + ai.selection.length);
      } else {
        next = `${current.trimEnd()}\n\n${output}`;
        notice = ai.selection
          ? "The passage could not be matched exactly in the Markdown, so the draft was added at the end."
          : "There was no selection, so the draft was added at the end.";
      }
    }
    setPending(true);
    setError("");
    const result = await enqueue(async () =>
      applyNoteAIResultAction({
        artifactId: noteId,
        runId: ai.runId,
        expectedVersion: versionRef.current,
        content: body(next),
        plainText: next,
        idempotencyKey: crypto.randomUUID(),
      }),
    );
    setPending(false);
    if (!result.ok) return setError(result.error);
    versionRef.current = result.version;
    savedRef.current = next;
    updateMarkdown(next);
    setSaveState("saved");
    setAi(null);
    if (notice) setError(notice);
  };

  const [detailsOpen, setDetailsOpen] = useState(false);
  // Open when the note already carries a thread; a quiet note stays quiet.
  const [commentsOpen, setCommentsOpen] = useState(comments.length > 0);
  const [editorMode, setEditorMode] = useState<MarkdownEditorMode>(() => markdownEditorMode(initialMarkdown));
  const sourceReason = markdownSourceReason(markdown);
  /*
   * The minimal chrome hides the mode row, so the only route to source mode is
   * the Details inspector. When a paste confirms it dropped structure, show
   * that route instead of making the person hunt for it.
   */
  const [sourceHint, setSourceHint] = useState(false);
  useEffect(() => {
    if (!sourceHint) return;
    const timer = window.setTimeout(() => setSourceHint(false), 12000);
    return () => window.clearTimeout(timer);
  }, [sourceHint]);
  // A brand-new note (the empty state's "Write your first page." action) opens
  // with the composer focused; an existing note never steals focus on mount.
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const newNote = initialTitle === "Untitled note" && initialMarkdown === "";
  useEffect(() => {
    if (newNote) titleRef.current?.focus();
  }, [newNote]);

  // On load, the server draft is the note - there is nothing to "restore". The
  // one thing the server cannot have is work typed after the last successful
  // autosave; a newer local mirror is offered once, never applied silently.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(localKey);
      if (!raw) return;
      const entry = JSON.parse(raw) as { markdown?: string; savedAt?: string };
      const mirroredAt = entry.savedAt;
      const newer = typeof mirroredAt === "string" && Date.parse(mirroredAt) > Date.parse(savedAt);
      if (entry.markdown && entry.markdown !== initialMarkdown && newer && mirroredAt) {
        const offer = { markdown: entry.markdown, savedAt: mirroredAt };
        // Mirrors a store outside React; surface it after mount, not during
        // the effect commit (react-hooks/set-state-in-effect).
        queueMicrotask(() => setLocalOffer(offer));
      } else {
        window.localStorage.removeItem(localKey);
      }
    } catch {
      // A corrupt or unreadable mirror is dropped, not restored.
    }
    // Mount-time only: savedAt and initialMarkdown are the note's identity here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * The page is the note, Notion-style: the document column is the screen,
   * the list shrinks to a quiet left rail, and everything else recedes. The
   * top row of actions is chrome, not content - it shows on hover/focus of
   * the header zone on fine pointers and stays visible on coarse pointers
   * (touch has no hover). Prose never leaves the reading measure; on wide
   * screens the margin panel sits in the right margin, below it on narrow.
   */
  const openCommentCount = comments.filter((c) => c.resolvedAt === null).length;
  return (
    <div className={noteLayout.row}>
      <div data-note-container className={noteLayout.cell}>
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={motionTransition}
          className={noteLayout.column}
        >
          {/* The header zone: chrome fades in on pointer hover, always on for
              keyboard focus and coarse pointers. */}
          <div className={`header-zone ${noteLayout.header} ${scrolled ? "is-scrolled" : ""}`}>
            <div className="header-actions flex items-center gap-1">
              <LibraryToggle />
              <FindNoteButton icon />
              <NewNoteButton icon />
              <Dialog>
                <DialogTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="History" disabled={!historyReady}>
                    <History aria-hidden className="text-muted-foreground" />
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogTitle>Version history</DialogTitle>
                  <DialogDescription>
                    Every checkpoint is immutable - this is what the note said, when.
                  </DialogDescription>
                  {history.length === 0 ? (
                    <p className="text-body-dense text-muted-foreground">No checkpoints yet.</p>
                  ) : (
                    <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
                      {history.map((v) => (
                        <li key={v.id} className="rounded-md border border-border px-3 py-2 text-body-dense">
                          <span className="flex items-center justify-between gap-2">
                            <span className="font-medium">Version {v.versionNumber}</span>
                            <span className="text-xs text-muted-foreground">
                              <Stamp iso={v.createdAt} />
                            </span>
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {v.reason}
                            {v.note ? ` · ${v.note}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </DialogContent>
              </Dialog>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Note details"
                aria-expanded={detailsOpen}
                aria-controls="note-details"
                onClick={() => setDetailsOpen((open) => !open)}
              >
                <Info aria-hidden className="text-muted-foreground" />
              </Button>
            </div>
          </div>
          {localOffer && (
            <div
              role="status"
              className="mb-6 flex flex-wrap items-center gap-2 rounded-lg border border-(--tone-attention-wash)/40 bg-(--tone-attention-wash)/15 p-3 text-body-dense"
            >
              <span>
                Unsent changes from <Stamp iso={localOffer.savedAt} /> were found in this browser.
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  updateMarkdown(localOffer.markdown);
                  setLocalOffer(null);
                }}
              >
                Restore
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setLocalOffer(null);
                  try {
                    window.localStorage.removeItem(localKey);
                  } catch {
                    // Already gone.
                  }
                }}
              >
                Discard
              </Button>
            </div>
          )}
          <div>
            {/*
             * The title is an input, and an input is not a heading: the screen
             * still owes assistive tech an h1 naming the page. It sits beside
             * the input rather than replacing it, so editing keeps working and
             * the shell's one-heading-per-screen contract holds.
             */}
            <h1 className="sr-only">{title.trim() || "Untitled note"}</h1>
            <div className={noteLayout.titleRow}>
              {/* A textarea so a long title wraps instead of being clipped;
                  Enter commits rather than adding a line break. */}
              <textarea
                ref={titleRef}
                aria-label="Note title"
                rows={1}
                value={title}
                onChange={(e) => setTitle(e.target.value.replace(/\n/g, " "))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                }}
                onBlur={rename}
                placeholder="Untitled note"
                style={{ fontFamily: "var(--font-display)" }}
                className={`field-sizing-content w-full min-w-0 resize-none overflow-hidden bg-transparent ${noteLayout.titleText} outline-none placeholder:text-muted-foreground/40`}
              />
              {outlinks.length > 0 && (
                <button
                  type="button"
                  onClick={() => setDetailsOpen(true)}
                  aria-label={`${outlinks.length} ${outlinks.length === 1 ? "reference" : "references"} in this note`}
                  className="mt-3 hidden shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-data text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:inline-flex"
                >
                  <Link2 aria-hidden className="size-3.5" />
                  {outlinks.length} {outlinks.length === 1 ? "reference" : "references"}
                </button>
              )}
            </div>
            {/* Metadata is small and muted; the actions it used to carry are
                the header zone's problem now. */}
            <div className={`${noteLayout.meta} text-muted-foreground`}>
              {saveState === "saving" && <span role="status">Saving…</span>}
              {saveState === "dirty" && <span role="status">Unsaved changes</span>}
              {saveState === "saved" && <span role="status">Saved</span>}
              {saveState === "error" && (
                <span role="status" className="text-destructive">
                  Not saved
                </span>
              )}
              <span>
                Updated <Stamp iso={updatedAt} />
              </span>
            </div>
            {indexNotice && (
              <div className="mt-1.5 text-xs text-muted-foreground">
                <MeaningIndexStatus noteId={noteId} notice={indexNotice} />
              </div>
            )}
          </div>
          {/* The one quiet action row, hover-revealed like the header chrome. */}
          <div className={`header-actions quiet-actions ${noteLayout.actions} ${scrolled ? "is-scrolled" : ""}`}>
            <NotionAppendAction
              noteId={noteId}
              title={title}
              markdown={markdown}
              disabled={pending || saveState === "saving"}
            />
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="text-muted-foreground"
              onClick={checkpoint}
              disabled={pending || saveState === "saving"}
            >
              {pending ? "Saving…" : "Save checkpoint"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              aria-expanded={commentsOpen}
              aria-controls="note-comments"
              onClick={() => setCommentsOpen((open) => !open)}
            >
              <MessageSquare aria-hidden className="size-3.5" />
              {openCommentCount > 0 ? `Comments ${openCommentCount}` : "Comments"}
            </Button>
          </div>
          <div ref={noteColumnRef} data-note-title={title} className={noteLayout.body}>
            <RichEditor
              chrome="minimal"
              autocomplete
              mode={editorMode}
              onModeChange={setEditorMode}
              findLinkTargets={findLinkTargets}
              content={markdown}
              linkPreviews={linkedPreviews}
              missingLinkTitles={missingLinkTitles}
              onChange={updateMarkdown}
              ai={{ pending: aiBusy, onAction: startAI, open: aiMenuOpen, onOpenChange: setAiMenuOpen }}
              onStructuredPasteDropped={() => setSourceHint(true)}
            />
            <MarginNotes previews={linkedPreviews} editorRoot={editorRoot} />
            {sourceHint && editorMode === "rich" && (
              <div role="status" className="mt-2 flex items-center gap-2 text-body-dense text-muted-foreground">
                <span>The paste lost its structure.</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditorMode("source");
                    setSourceHint(false);
                  }}
                >
                  Paste again in Markdown source
                </Button>
              </div>
            )}
          </div>
          {ai && (
            <div className="mt-6 flex flex-col gap-2 rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                <Status>AI · {ai.heading}</Status>
                <span className="text-xs text-muted-foreground">
                  {ai.failed
                    ? "Something went wrong"
                    : AI_TERMINAL.has(ai.state)
                      ? ai.output
                        ? "Draft ready - review it before anything is written"
                        : "Finished without output"
                      : "Working - the draft appears here when the run finishes"}
                </span>
              </div>
              {ai.coverage === "note_start" && (
                <p className="text-xs text-muted-foreground">
                  This note is long, so only the first part was read. Select a passage to work on a later part.
                </p>
              )}
              {ai.output && !ai.failed && (
                <>
                  <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-body-dense leading-6">
                    {ai.output}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {ai.selection && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => acceptAI("replace")}
                      >
                        Replace the selection
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => acceptAI("append")}
                    >
                      {ai.heading === "Answer" ? "Insert the answer" : "Add at the end"}
                    </Button>
                    {ai.heading !== "Answer" && ai.coverage === "whole_note" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => acceptAI("replaceNote")}
                      >
                        Replace the note
                      </Button>
                    )}
                    <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setAi(null)}>
                      Discard
                    </Button>
                  </div>
                </>
              )}
              {ai.notice && (
                <p role="alert" className="text-xs text-destructive">
                  {ai.notice}
                </p>
              )}
              {ai.failed && (
                <Button type="button" size="sm" variant="ghost" className="w-fit" onClick={() => setAi(null)}>
                  Dismiss
                </Button>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="mt-4 text-body-dense text-destructive">
              {error}
            </p>
          )}
          {/* Backlinks are part of reading the note, not a property of it:
              they sit at the foot of the document, always visible, so the
              reader sees what this note is part of. */}
          <section id="note-backlinks" aria-label="Backlinks" className="mt-14 border-t border-border pt-6">
            <h2 className="text-xs font-medium text-muted-foreground">
              Backlinks <span className="tabular-nums">{backlinks.length}</span>
            </h2>
            {backlinks.length === 0 ? (
              <p className="mt-3 text-body-dense text-muted-foreground">
                No notes link here yet. Another note links to this one when it writes [[{title.trim() || "this title"}
                ]].
              </p>
            ) : (
              <ul className="mt-3 flex flex-col gap-2.5">
                {backlinks.map((link) => (
                  <BacklinkRow key={link.id} noteId={noteId} link={link} />
                ))}
              </ul>
            )}
          </section>
          {/* Comments below the column on narrow screens; the margin column
              on wide screens renders the same panel. One state, one composer. */}
          <div id="note-comments" className={`mt-10 ${commentsOpen ? "2xl:hidden" : "xl:hidden"}`}>
            <NoteCommentsPanel noteId={noteId} initialComments={comments} />
          </div>
        </motion.div>
      </div>
      {/* The right margin (Notion's margin comments): ≥1280px only, where it
          costs the prose column nothing. The toggle controls both placements. */}
      {commentsOpen && (
        <aside aria-label="Comments margin" className="sticky top-0 hidden w-72 shrink-0 xl:block">
          <div className="pt-20">
            <NoteCommentsPanel noteId={noteId} initialComments={comments} />
          </div>
        </aside>
      )}
      <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
        <SheetContent id="note-details" className="overflow-y-auto p-5 pt-12">
          <SheetTitle>Note details</SheetTitle>
          <SheetDescription className="sr-only">
            Properties, checkpoints, history and connections for this note.
          </SheetDescription>
          <section aria-label="Properties" className="flex flex-col gap-2">
            <h2 className="text-xs font-medium text-muted-foreground">Properties</h2>
            <dl aria-label="Note properties" className="flex flex-col gap-2 text-body-dense">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-xs text-muted-foreground">Type</dt>
                <dd>
                  <Status>{kind}</Status>
                </dd>
              </div>
              <div className="flex items-start justify-between gap-2">
                <dt className="pt-0.5 text-xs text-muted-foreground">Tags</dt>
                <dd className="flex flex-wrap items-center justify-end gap-1">
                  {tags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      title={`Remove tag ${tag}`}
                      aria-label={`Remove tag ${tag}`}
                      className="rounded-full border border-border px-2 py-0.5 text-xs hover:border-destructive/50 hover:text-destructive"
                      onClick={() => void saveTags(tags.filter((t) => t !== tag))}
                    >
                      {tag} <X aria-hidden className="size-3.5" />
                    </button>
                  ))}
                  <input
                    aria-label="Add a tag"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault();
                        addTag();
                      }
                      if (e.key === "Backspace" && !tagInput && tags.length) void saveTags(tags.slice(0, -1));
                    }}
                    onBlur={addTag}
                    placeholder="+ tag"
                    className="w-16 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                  />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-xs text-muted-foreground">Created</dt>
                <dd className="text-xs">
                  <Stamp iso={createdAt} />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-xs text-muted-foreground">Updated</dt>
                <dd className="text-xs">
                  <Stamp iso={updatedAt} />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-xs text-muted-foreground">Version</dt>
                <dd className="text-xs">v{initialVersion}</dd>
              </div>
            </dl>
            <Link
              className="w-fit text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              href={`/polymath/graph?focus=${noteId}`}
            >
              Show in graph
            </Link>
          </section>
          <section aria-label="Editing mode" className="flex flex-col gap-2">
            <h2 className="text-xs font-medium text-muted-foreground">Editing mode</h2>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={editorMode === "rich" ? "secondary" : "outline"}
                aria-pressed={editorMode === "rich"}
                disabled={!!sourceReason}
                onClick={() => {
                  setEditorMode("rich");
                  setDetailsOpen(false);
                }}
              >
                Rich text
              </Button>
              <Button
                type="button"
                size="sm"
                variant={editorMode === "source" ? "secondary" : "outline"}
                aria-pressed={editorMode === "source"}
                onClick={() => {
                  setEditorMode("source");
                  setDetailsOpen(false);
                }}
              >
                Markdown source
              </Button>
            </div>
          </section>
          {(outlinks.length > 0 || backlinks.length > 0) && (
            <section aria-label="Links" className="flex flex-col gap-3">
              <div>
                <p className="text-xs font-medium text-muted-foreground">References</p>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {outlinks.map((link) => (
                    <LinkRow key={link.id} noteId={noteId} outgoing link={link} label="Reference" />
                  ))}
                  {outlinks.length === 0 && (
                    <li className="text-body-dense text-muted-foreground">No [[wiki links]] in this note yet.</li>
                  )}
                </ul>
              </div>
            </section>
          )}
          {related.filter((r) => !r.alreadyLinked).length > 0 && (
            <section aria-label="Related" className="flex flex-col gap-2">
              <h2 className="text-xs font-medium text-muted-foreground">Related by meaning</h2>
              <ul className="flex flex-wrap gap-1.5">
                {related
                  .filter((r) => !r.alreadyLinked)
                  .map((r) => (
                    <li
                      key={r.id}
                      className="inline-flex max-w-full items-center rounded-full border border-border bg-background text-body-dense transition-colors hover:bg-muted/60"
                    >
                      <Link
                        className="flex min-w-0 items-center gap-1.5 rounded-full py-1 pl-2.5 pr-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        href={`/polymath/notes?id=${r.id}`}
                        title={r.excerpt ?? r.title}
                      >
                        {r.kind === "zettel" && <span className="text-data text-muted-foreground">zettel</span>}
                        <span className="truncate">{r.title}</span>
                        <span className="tabular-nums text-data text-muted-foreground">
                          {Math.round(r.score * 100)}%
                        </span>
                      </Link>
                    </li>
                  ))}
              </ul>
            </section>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
