"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Building2,
  FileText,
  Layers,
  Loader2,
  MessageSquare,
  NotebookPen,
  Paperclip,
  Plus,
  Search,
  User,
} from "lucide-react";
import { Popover } from "radix-ui";
import { cn } from "cn";

/*
 * The composer's picker: one control, inside the textarea's own frame, one
 * menu for both gestures. The plus button opens it fresh; a typed "@" opens
 * the same menu with the token as the seeded query. Both gestures share one
 * search input, one fetch effect (the host's), and one set of results.
 *
 * A pick hands the record to the host, which decides what it means: a
 * person, company or idea becomes a context chip; anything else becomes a
 * reference link in the draft. A caller with nothing to offer passes no
 * items and no onReference, and the button does not render — a plus that
 * opens an empty menu is chrome lying about capability.
 */

export type ComposerPlusItem = {
  label: string;
  hint?: string;
  icon: ReactNode;
  onSelect: () => void;
};

/**
 * The @-mention state a host derives from its own draft: the token between the
 * last "@" that starts a word and the caret, when that text has no whitespace.
 * `start`/`end` are the token's offsets in the draft, so a commit can replace
 * exactly what the owner typed.
 */
export type MentionState = { open: boolean; query: string; start: number; end: number };

/** Derive the @-mention state from a draft and caret position (null when closed). */
export function mentionAt(draft: string, caret: number): MentionState | null {
  const before = draft.slice(0, caret);
  const match = /(^|\s)@([^\s]*)$/.exec(before);
  if (!match) return null;
  const start = caret - match[2].length - 1;
  return { open: true, query: match[2], start, end: caret };
}

/** Replace an @-token in a draft with the record's link, plus a trailing space. */
export function replaceMention(draft: string, mention: MentionState, markdown: string): string {
  return `${draft.slice(0, mention.start)}${markdown} ${draft.slice(mention.end)}`;
}

export type RecordReference = {
  id: string;
  kind: "note" | "zettel" | "artifact" | "conversation" | "document" | "person" | "company";
  title: string;
  href: string;
};

/** The plural a group header uses; people and companies are already plural. */
const KIND_LABELS: Record<RecordReference["kind"], string> = {
  note: "Notes",
  zettel: "Zettels",
  artifact: "Artifacts",
  conversation: "Conversations",
  document: "Documents",
  person: "People",
  company: "Companies",
};

/** The singular a reference link prefix uses. */
const KIND_SINGULAR: Record<RecordReference["kind"], string> = {
  note: "Note",
  zettel: "Zettel",
  artifact: "Artifact",
  conversation: "Conversation",
  document: "Document",
  person: "Person",
  company: "Company",
};

/** One glyph per record kind, so a document reads apart from a note at a glance. */
const KIND_GLYPHS: Record<RecordReference["kind"], typeof FileText> = {
  note: NotebookPen,
  zettel: Layers,
  artifact: Layers,
  conversation: MessageSquare,
  document: FileText,
  person: User,
  company: Building2,
};

function KindGlyph({ kind, className }: { kind: RecordReference["kind"]; className?: string }) {
  const Glyph = KIND_GLYPHS[kind];
  return <Glyph aria-hidden className={cn("text-muted-foreground size-3.5 shrink-0", className)} />;
}

/** The markdown link a pick inserts when the host treats it as a reference. */
export function referenceLink(record: RecordReference): string {
  return `[${KIND_SINGULAR[record.kind]}: ${record.title}](${record.href})`;
}

export function ComposerPlus({
  items = [],
  records,
  open,
  initialQuery,
  onReference,
  onQueryChange,
  onOpenChange,
  onFile,
  label = "Add to message",
  disabled = false,
  className,
}: {
  items?: ComposerPlusItem[];
  /** Live lookup results; undefined while idle, null while loading. */
  records?: RecordReference[] | null;
  /** Open state lives with the host: the plus button toggles it and a typed "@" forces it. */
  open: boolean;
  /** The query the menu opens with (the @ token, when the host opens it that way). */
  initialQuery?: string;
  /** Receives the picked record; the host decides chip versus reference link. */
  onReference?: (record: RecordReference) => void;
  /** Fires when the search text changes (including the open edge's seed). */
  onQueryChange?: (query: string) => void;
  /** Fires when the menu opens or closes; lets the caller gate the search fetch. */
  onOpenChange?: (open: boolean) => void;
  /** Receives the picked file; renders the hidden input itself when set. */
  onFile?: (file: File) => void;
  /** Accessible name; the home composer and reply composer frame it differently. */
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [lastKey, setLastKey] = useState("");

  // Opening seeds the search: empty from the plus button, the @ token from
  // the mention gesture. Re-seeding while open keeps the input following the
  // token as it grows in the textarea; an input edited directly is left
  // alone, because then the textarea is not changing. Focus moves into the
  // input only on a fresh (empty-seed) open — an @ open keeps the caret in
  // the textarea, where the token is being typed. The setState calls defer
  // into a frame callback: synchronous setState in an effect body is what
  // the react-hooks rule bans, and one frame is imperceptible here.
  useEffect(() => {
    if (!open) return;
    const seed = initialQuery ?? "";
    const frame = requestAnimationFrame(() => {
      setQuery(seed);
      onQueryChange?.(seed);
      if (!seed) searchRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, initialQuery, onQueryChange]);

  const grouped: Array<{ kind: RecordReference["kind"]; rows: RecordReference[] }> = [];
  for (const record of records ?? []) {
    let group = grouped.find((g) => g.kind === record.kind);
    if (!group) {
      group = { kind: record.kind, rows: [] };
      grouped.push(group);
    }
    group.rows.push(record);
  }
  const flat = grouped.flatMap((g) => g.rows);

  // Reset the highlight when the result set changes, during render (the
  // React-recommended alternative to an effect setState).
  const key = records === undefined ? "" : String(flat.length);
  if (key !== lastKey) {
    setLastKey(key);
    setActive(0);
  }

  function changeQuery(next: string) {
    setQuery(next);
    onQueryChange?.(next);
  }

  function commit(record: RecordReference) {
    onOpenChange?.(false);
    onReference?.(record);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, flat.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter" && flat[active]) {
      event.preventDefault();
      commit(flat[active]);
    }
  }

  // The ref read lives in this click handler, so the rule can see it never
  // runs during render.
  function pickFile() {
    fileInputRef.current?.click();
  }
  function fileChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) onFile?.(file);
    event.target.value = "";
  }

  // A plus that opens an empty menu is chrome lying about capability. Checked
  // after the hooks, which must run unconditionally.
  if (items.length === 0 && !onReference && !onFile) return null;

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        type="button"
        disabled={disabled}
        aria-label={label}
        title={label}
        onClick={() => onOpenChange?.(!open)}
        className={cn(
          "text-muted-foreground hover:bg-muted hover:text-foreground flex size-8 shrink-0 items-center justify-center rounded-full outline-none transition-colors",
          "focus-visible:ring-ring focus-visible:ring-3",
          "data-[state=open]:bg-muted data-[state=open]:text-foreground",
          disabled && "pointer-events-none opacity-40",
          className,
        )}
      >
        <Plus aria-hidden className="size-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          side="top"
          sideOffset={8}
          onKeyDown={onKeyDown}
          className="bg-popover text-popover-foreground border-border z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border p-1 shadow-md"
        >
          {onReference ? (
            <div className="flex items-center gap-2 border-border border-b px-2.5 pb-1.5">
              <Search aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => changeQuery(event.target.value)}
                placeholder="Search notes, artifacts, conversations…"
                aria-label="Search records to attach"
                aria-controls={listId}
                className="placeholder:text-muted-foreground h-8 w-full bg-transparent text-body-dense outline-none"
              />
            </div>
          ) : null}

          {records === null ? (
            <p role="status" className="text-muted-foreground flex items-center gap-2 px-2.5 py-3 text-label">
              <Loader2 aria-hidden className="size-3.5 animate-spin" /> Searching…
            </p>
          ) : null}

          {records !== null && onReference && flat.length === 0 ? (
            <p className="text-muted-foreground px-2.5 py-3 text-label">
              {query.trim() ? "Nothing matches. Try a different word." : "No records yet."}
            </p>
          ) : null}

          {flat.length > 0 ? (
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label="Records"
              className="max-h-64 overflow-y-auto py-0.5"
            >
              {grouped.map((group) => (
                <li key={group.kind} role="presentation">
                  <p className="text-muted-foreground px-2.5 pt-1.5 pb-0.5 text-label font-medium">
                    {KIND_LABELS[group.kind]}
                  </p>
                  <ul role="presentation">
                    {group.rows.map((record) => {
                      const index = flat.indexOf(record);
                      return (
                        <li key={record.id} role="presentation">
                          <button
                            type="button"
                            role="option"
                            aria-selected={index === active}
                            onMouseEnter={() => setActive(index)}
                            onClick={() => commit(record)}
                            className={cn(
                              "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-body-dense outline-none",
                              index === active ? "bg-muted" : "hover:bg-muted/60",
                            )}
                          >
                            <KindGlyph kind={record.kind} />
                            <span className="min-w-0 flex-1 truncate">{record.title}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          ) : null}

          {items.length > 0 ? (
            <div className="border-border border-t pt-1 pb-0.5">
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => {
                    onOpenChange?.(false);
                    item.onSelect();
                  }}
                  className="hover:bg-muted focus-visible:bg-muted flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-body-dense outline-none"
                >
                  <span className="text-muted-foreground shrink-0 [&_svg]:size-4">{item.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{item.label}</span>
                    {item.hint ? (
                      <span className="text-muted-foreground block truncate text-data">{item.hint}</span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {onFile ? (
            <div className={cn("border-border pt-1 pb-0.5", items.length > 0 && "border-t")}>
              <button
                type="button"
                onClick={() => {
                  // The menu closes BEFORE the picker opens: the hidden input
                  // lives outside this portal (below), so it stays mounted and
                  // its change event always fires.
                  onOpenChange?.(false);
                  pickFile();
                }}
                className="hover:bg-muted focus-visible:bg-muted flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-body-dense outline-none"
              >
                <Paperclip aria-hidden className="text-muted-foreground size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">Attach a file</span>
                  <span className="text-muted-foreground block truncate text-data">
                    Captured to your inbox, up to 4 MB
                  </span>
                </span>
              </button>
            </div>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
      {/*
       * The file input lives OUTSIDE the popover portal: an input mounted
       * inside Popover.Content unmounts when the menu closes, and the file
       * chooser's change event then fires on a dead node — the picked file
       * never reaches onFile. Mounted here, it survives the close.
       */}
      {onFile ? (
        <input
          ref={fileInputRef}
          id={fileInputId}
          type="file"
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={fileChosen}
        />
      ) : null}
    </Popover.Root>
  );
}
