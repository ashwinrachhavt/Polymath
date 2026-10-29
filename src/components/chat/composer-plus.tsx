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
 * The composer's plus button: one control, inside the textarea's own frame,
 * that opens the small menu of things a message can carry. ChatGPT-shaped:
 * the button sits in the input area's bottom-left, a round hover target the
 * same size as the send button, quiet until hovered.
 *
 * Two kinds of offer:
 *  - actions: caller-supplied, executed on click (attach a file);
 *  - record references: a searchable lookup over the workspace's notes,
 *    zettels, artifacts and conversations. Picking one calls onReference
 *    with a markdown link the caller inserts into the draft, because the
 *    message text is what the model actually reads.
 *
 * A caller with nothing to offer passes no items and no onReference, and the
 * button does not render — a plus that opens an empty menu is chrome lying
 * about capability.
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

function referenceLink(record: RecordReference): string {
  return `[${KIND_SINGULAR[record.kind]}: ${record.title}](${record.href})`;
}

export function ComposerPlus({
  items = [],
  records,
  onReference,
  onQueryChange,
  onOpenChange,
  onFile,
  label = "Add to message",
  disabled = false,
  className,
  mention,
  onMentionPick,
}: {
  items?: ComposerPlusItem[];
  /** Live lookup results; undefined while idle, null while loading. */
  records?: RecordReference[] | null;
  /** Receives a markdown link for the picked record, to insert into the draft. */
  onReference?: (markdown: string, record: RecordReference) => void;
  /** Fires when the menu opens (empty query) or the search text changes. */
  onQueryChange?: (query: string) => void;
  /** Fires when the menu opens or closes; lets the caller gate the search fetch. */
  onOpenChange?: (open: boolean) => void;
  /** Receives the picked file; renders the hidden input itself when set. */
  onFile?: (file: File) => void;
  /** Accessible name; the home composer and reply composer frame it differently. */
  label?: string;
  disabled?: boolean;
  className?: string;
  /**
   * @-mention mode: the host derives this from its draft and caret. When set,
   * open state and query follow it (the textarea is the search field), and a
   * commit goes to onMentionReplace instead of appending to the draft.
   */
  mention?: MentionState | null;
  /** Receives the picked record in mention mode; the host rewrites its own draft. */
  onMentionPick?: (record: RecordReference) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // In mention mode the textarea owns open/query; otherwise the popover's own
  // search input does. The effect reports the open edge so the caller's fetch
  // gate stays working for both modes without a setState-during-render.
  const mentionOpen = mention?.open ?? false;
  useEffect(() => {
    if (!mention) return;
    onOpenChange?.(mentionOpen);
    // Fires on the mention open/close edge only; the callback identity is not
    // an interesting change and callers pass stable closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionOpen]);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [lastKey, setLastKey] = useState("");

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

  const isOpen = mention ? mentionOpen : open;
  const activeQuery = mention ? mention.query : query;

  function changeOpen(next: boolean) {
    if (mention) return; // the textarea controls open/close in mention mode
    setOpen(next);
    if (next) {
      // Fresh menu, fresh search. The focus lands here too: Radix's
      // onOpenAutoFocus would fight the popover's own focus return, so the
      // open transition owns both.
      setQuery("");
      onQueryChange?.("");
      requestAnimationFrame(() => searchRef.current?.focus());
    }
    onOpenChange?.(next);
  }

  function changeQuery(next: string) {
    if (mention) {
      onQueryChange?.(next);
      return;
    }
    setQuery(next);
    onQueryChange?.(next);
  }

  function commit(record: RecordReference) {
    if (mention) {
      onMentionPick?.(record);
      return;
    }
    changeOpen(false);
    onReference?.(referenceLink(record), record);
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
    <Popover.Root open={isOpen} onOpenChange={changeOpen}>
      <Popover.Trigger
        type="button"
        disabled={disabled}
        aria-label={label}
        title={label}
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
          {onReference && !mention ? (
            <div className="flex items-center gap-2 border-border border-b px-2.5 pb-1.5">
              <Search aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => changeQuery(event.target.value)}
                placeholder="Search notes, artifacts, conversations…"
                aria-label="Search records to attach"
                aria-controls={listId}
                className="placeholder:text-muted-foreground h-8 w-full bg-transparent text-[13px] outline-none"
              />
            </div>
          ) : null}

          {records === null ? (
            <p role="status" className="text-muted-foreground flex items-center gap-2 px-2.5 py-3 text-[12px]">
              <Loader2 aria-hidden className="size-3.5 animate-spin" /> Searching…
            </p>
          ) : null}

          {records !== null && onReference && flat.length === 0 ? (
            <p className="text-muted-foreground px-2.5 py-3 text-[12px]">
              {activeQuery.trim() ? "Nothing matches. Try a different word." : "No records yet."}
            </p>
          ) : null}

          {flat.length > 0 ? (
            <ul ref={listRef} id={listId} role="listbox" aria-label="Records" className="max-h-64 overflow-y-auto py-0.5">
              {grouped.map((group) => (
                <li key={group.kind} role="presentation">
                  <p className="text-muted-foreground px-2.5 pt-1.5 pb-0.5 text-[10px] font-medium tracking-wide uppercase">
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
                              "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] outline-none",
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

          {items.length > 0 && !mention ? (
            <div className="border-border border-t pt-1 pb-0.5">
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                  className="hover:bg-muted focus-visible:bg-muted flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] outline-none"
                >
                  <span className="text-muted-foreground shrink-0 [&_svg]:size-4">{item.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{item.label}</span>
                    {item.hint ? (
                      <span className="text-muted-foreground block truncate text-[11px]">{item.hint}</span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {onFile && !mention ? (
            <div className={cn("border-border pt-1 pb-0.5", items.length > 0 && "border-t")}>
              <button
                type="button"
                onClick={() => {
                  // The menu closes BEFORE the picker opens: the hidden input
                  // lives outside this portal (below), so it stays mounted and
                  // its change event always fires.
                  setOpen(false);
                  onOpenChange?.(false);
                  pickFile();
                }}
                className="hover:bg-muted focus-visible:bg-muted flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] outline-none"
              >
                <Paperclip aria-hidden className="text-muted-foreground size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">Attach a file</span>
                  <span className="text-muted-foreground block truncate text-[11px]">
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
