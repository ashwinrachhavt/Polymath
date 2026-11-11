"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { linkTargetInsertion, type LinkTarget } from "./link-target-insertion";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { useRouter } from "next/navigation";
import { WIKI_LINK_OPEN, WikiLinks, refreshWikiPreviews, type WikiLinkOpen } from "./wiki-links";
import type { LinkPreview } from "@/domains/knowledge/notes";
import { InlineCompletion } from "./inline-completion";
import { setAutocompleteEnabled, useAutocomplete } from "./autocomplete-client";
import { Bold, Italic, List, ListOrdered, Quote, Undo2, Redo2 } from "lucide-react";
import { filterBlockCommands, slashQuery, type BlockCommand } from "@/components/workspace/slash-commands";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  markdownEditorMode,
  markdownSourceReason,
  richEditorMarkdown,
  type MarkdownEditorMode,
} from "./markdown-preservation";
import { uploadCaptureFile } from "@/lib/capture-upload";
import { SearchField } from "@/components/workspace/ui";
import { artifactHref } from "./artifact-controls";
import { NoteAIMenu, type NoteAIRequest } from "./note-ai-menu";

/** Search the workspace's cards. "keyword" answers fast; "hybrid" adds meaning and takes longer. */
export type FindLinkTargets = (query: string, mode: "keyword" | "hybrid") => Promise<LinkTarget[]>;

export type RichEditorAI = {
  pending: boolean;
  onAction: (request: NoteAIRequest) => void;
  /** Controlled dialog state so "space on an empty line" can open the menu. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/*
 * A pasted or dropped image uploads as an inbox capture through the one
 * multipart route, then the note gets a markdown link to the stored bytes at
 * the caret. The insertion happens after the response because the blob's URL
 * does not exist until then; a failure reports through the workspace notice
 * instead of dropping the image silently.
 */
async function insertImageCapture(
  image: File,
  editor: Editor | null,
  notify: (message: string) => void,
): Promise<void> {
  notify(`Capturing ${image.name || "image"}…`);
  const result = await uploadCaptureFile(image);
  if (!result.ok) {
    notify(result.message);
    return;
  }
  const name = image.name || "captured image";
  editor
    ?.chain()
    .focus()
    .insertContent(`[${name}](/api/v1/captures/${result.captureId}/file)`, { contentType: "markdown" })
    .run();
  notify(`Captured ${name} to your inbox and linked it here.`);
}

/*
 * Two chromes for the same editor. "full" (the dossier surfaces) keeps the
 * persistent toolbar and the mode row. "minimal" (the notebook) puts the
 * writing first: no persistent toolbar, formatting floats up on a selection,
 * "/" opens blocks, and the mode toggle is controlled from outside (the note
 * inspector), so the only persistent control is one quiet Ask AI button.
 */
export default function RichEditor({
  content,
  onChange,
  ai,
  findLinkTargets,
  chrome = "full",
  compact = false,
  editable = true,
  autocomplete = false,
  mode: controlledMode,
  onModeChange,
  onStructuredPasteDropped,
  linkPreviews,
  missingLinkTitles,
}: {
  content: string;
  onChange: (content: string) => void;
  ai?: RichEditorAI;
  /** First lines of linked notes, folded into the text where the page has no margin. */
  linkPreviews?: LinkPreview[];
  /** Linked titles the server found no note for: they read as muted text, not links. */
  missingLinkTitles?: string[];
  findLinkTargets?: FindLinkTargets;
  chrome?: "full" | "minimal";
  /** Short inline editor (task cards) instead of the full-page writing height. */
  compact?: boolean;
  /** False renders the document for reading: no caret, no typing, no chrome. */
  editable?: boolean;
  /** Ghost-text suggestions while writing (Tab accepts). Off unless the host asks. */
  autocomplete?: boolean;
  mode?: MarkdownEditorMode;
  onModeChange?: (mode: MarkdownEditorMode) => void;
  /** A paste arrived with structure rich text cannot keep; it was inserted literally. */
  onStructuredPasteDropped?: () => void;
}) {
  const { notify } = useWorkspace();
  const [internalPreferred, setInternalPreferred] = useState<MarkdownEditorMode>(() => markdownEditorMode(content));
  const preferred = controlledMode ?? internalPreferred;
  const setPreferred = (next: MarkdownEditorMode) => {
    if (onModeChange) onModeChange(next);
    else setInternalPreferred(next);
  };
  const reason = markdownSourceReason(content);
  const mode = markdownEditorMode(content, preferred);
  // The AI menu acts on the current selection in whichever mode is showing;
  // both modes report their selection text up here so the menu stays simple.
  const [selection, setSelection] = useState("");
  const readTextareaSelection = (textarea: HTMLTextAreaElement) => {
    setSelection(
      textarea.selectionStart === textarea.selectionEnd
        ? ""
        : textarea.value.slice(textarea.selectionStart, textarea.selectionEnd),
    );
  };
  const minimal = chrome === "minimal";
  // The minimal chrome is flex-based so a host that stretches it (the notes
  // column gives the canvas its --canvas-min floor) can hand the slack to the
  // writing area itself; hosts without spare height are unaffected.
  return (
    <div className={minimal ? "relative flex flex-1 flex-col" : "space-y-3"}>
      {minimal ? (
        ai || autocomplete ? (
          // Floats in the gap above the document instead of taking a row of
          // its own, so the first line of text sits right under the title.
          <div className="absolute -top-12 right-0 z-10 flex items-center justify-end gap-1">
            {autocomplete && mode === "rich" && editable ? <AutocompleteToggle /> : null}
            {ai ? (
              <NoteAIMenu
                selection={selection}
                pending={ai.pending}
                onAction={ai.onAction}
                open={ai.open}
                onOpenChange={ai.onOpenChange}
              />
            ) : null}
          </div>
        ) : null
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={mode === "rich" ? "secondary" : "outline"}
            aria-pressed={mode === "rich"}
            disabled={!!reason}
            onClick={() => setPreferred("rich")}
          >
            Rich text
          </Button>
          <Button
            type="button"
            variant={mode === "source" ? "secondary" : "outline"}
            aria-pressed={mode === "source"}
            onClick={() => setPreferred("source")}
          >
            Markdown source
          </Button>
          {ai ? (
            <NoteAIMenu
              selection={selection}
              pending={ai.pending}
              onAction={ai.onAction}
              open={ai.open}
              onOpenChange={ai.onOpenChange}
            />
          ) : null}
        </div>
      )}
      {reason && (
        <p role="status" className="mb-3 text-data text-muted-foreground">
          Rich editing is disabled: this note has {reason}, which rich text would lose.
        </p>
      )}
      {mode === "source" ? (
        <Textarea
          aria-label="Markdown source"
          className={
            minimal
              ? // The page scrolls as one document: no max-height slot, and the
                // note's reading type rather than a code font.
                "writing-surface min-h-24 max-h-none flex-1 resize-none overflow-hidden rounded-none border-0 bg-transparent px-0 py-0 text-body leading-7 shadow-none focus-visible:ring-0 md:text-body"
              : "min-h-72 font-mono text-body-dense"
          }
          value={content}
          onChange={(event) => onChange(event.target.value)}
          onSelect={(event) => readTextareaSelection(event.currentTarget)}
          onKeyUp={(event) => readTextareaSelection(event.currentTarget)}
          onPaste={(event) => {
            const image = Array.from(event.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
            if (!image) return;
            event.preventDefault();
            void insertImageCapture(image, null, notify);
          }}
        />
      ) : (
        <RichMarkdownEditor
          findLinkTargets={findLinkTargets}
          content={content}
          onChange={onChange}
          onSelectionChange={ai ? setSelection : undefined}
          compact={compact}
          editable={editable}
          autocomplete={autocomplete}
          onEmptySpace={ai?.onOpenChange ? () => ai.onOpenChange!(true) : undefined}
          floating={minimal}
          onStructuredPasteDropped={onStructuredPasteDropped}
          linkPreviews={linkPreviews}
          missingLinkTitles={missingLinkTitles}
        />
      )}
    </div>
  );
}

/*
 * Slash commands. The caret is watched for a `/` run at the end of the text
 * before it, and the palette is a plain listbox the editor owns. Keyboard
 * handling lives in handleKeyDown so the menu never steals focus from the
 * document, and the detection itself is a pure function in the shared layer.
 */
function applyBlock(editor: Editor, command: BlockCommand) {
  const chain = editor.chain().focus();
  if (command.id === "heading") chain.setHeading({ level: 2 }).run();
  else if (command.id === "bulletList") chain.toggleBulletList().run();
  else if (command.id === "orderedList") chain.toggleOrderedList().run();
  else if (command.id === "blockquote") chain.toggleBlockquote().run();
  else if (command.id === "codeBlock") chain.toggleCodeBlock().run();
  else chain.setHorizontalRule().run();
}

/*
 * `[[` opens the same list for a canonical record. The inserted text is the
 * record's title between double brackets, which the note save resolves back to
 * an id, so a link survives a rename only as strongly as its title does and the
 * resolution is visible in the editing surface rather than hidden.
 */
function linkQuery(textBeforeCursor: string) {
  const match = /\[\[([^\]\n]*)$/.exec(textBeforeCursor);
  return match ? match[1].toLowerCase() : undefined;
}

function SlashMenu({
  items,
  active,
  onPick,
}: {
  items: BlockCommand[];
  active: number;
  onPick: (command: BlockCommand) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="Insert block"
      className="panel absolute z-50 max-h-64 w-64 overflow-y-auto rounded-lg p-1 text-body-dense"
    >
      {items.map((command, index) => (
        <button
          key={command.id}
          type="button"
          role="option"
          aria-selected={index === active}
          className={`flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left ${index === active ? "bg-muted" : ""}`}
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(command);
          }}
        >
          <span className="font-medium">{command.label}</span>
          <span className="text-xs text-muted-foreground">{command.hint}</span>
        </button>
      ))}
    </div>
  );
}

/*
 * The one quiet control for inline suggestions: says whether they are on, and
 * why not when the server cannot offer them. The choice is the writer's and is
 * kept per browser.
 */
function AutocompleteToggle() {
  const { enabled, status } = useAutocomplete();
  const unavailable = status === "unavailable";
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="text-muted-foreground"
      aria-pressed={enabled && !unavailable}
      disabled={unavailable}
      title={
        unavailable
          ? "No model provider is configured for suggestions."
          : status === "paused"
            ? "Suggestions are paused for a few minutes (allowance or rate limit)."
            : status === "silent"
              ? "The model behind suggestions has not replied to the last few requests. It keeps trying as you write."
              : "Suggestions appear when you pause. Tab accepts, Cmd/Ctrl+→ accepts a word, Esc dismisses."
      }
      onClick={() => setAutocompleteEnabled(!enabled)}
    >
      {unavailable
        ? "Autocomplete unavailable"
        : !enabled
          ? "Autocomplete off"
          : status === "paused"
            ? "Autocomplete paused"
            : status === "silent"
              ? "Autocomplete not responding"
              : "Autocomplete on"}
    </Button>
  );
}

function RichMarkdownEditor({
  content,
  onChange,
  onSelectionChange,
  onEmptySpace,
  findLinkTargets,
  floating,
  compact,
  editable = true,
  autocomplete = false,
  onStructuredPasteDropped,
  linkPreviews,
  missingLinkTitles,
}: {
  linkPreviews?: LinkPreview[];
  missingLinkTitles?: string[];
  compact?: boolean;
  editable?: boolean;
  autocomplete?: boolean;
  findLinkTargets?: FindLinkTargets;
  content: string;
  onChange: (content: string) => void;
  onSelectionChange?: (text: string) => void;
  onEmptySpace?: () => void;
  floating?: boolean;
  onStructuredPasteDropped?: () => void;
}) {
  const { state, notify } = useWorkspace();
  const [slash, setSlash] = useState<{ query: string; from: number; to: number } | null>(null);
  const [link, setLink] = useState<{ query: string; from: number; to: number } | null>(null);
  const [linkActive, setLinkActive] = useState(0);
  const [slashActive, setSlashActive] = useState(0);
  const [url, setUrl] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [recordQuery, setRecordQuery] = useState("");
  const [recordOpen, setRecordOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  // The floating toolbar's anchor: caret coordinates at the selection start,
  // relative to the editor container. Null when the selection is empty.
  const [floatAt, setFloatAt] = useState<{ top: number; left: number } | null>(null);
  // With a finder, candidates come from the workspace's own cards: the fast
  // keyword answer first, then the meaning-aware ranking once typing pauses.
  const [remote, setRemote] = useState<LinkTarget[]>([]);
  const wanted = link ? link.query : recordOpen ? recordQuery.toLowerCase() : null;
  useEffect(() => {
    if (!findLinkTargets || wanted === null) return;
    let live = true;
    const query = wanted;
    void findLinkTargets(query, "keyword").then((rows) => {
      if (live) setRemote(rows);
    });
    const timer = query.trim()
      ? setTimeout(() => {
          void findLinkTargets(query, "hybrid").then((rows) => {
            if (live) setRemote(rows);
          });
        }, 250)
      : undefined;
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [findLinkTargets, wanted]);
  const candidates = (query: string): LinkTarget[] =>
    findLinkTargets
      ? remote
      : state.artifacts
          .filter((artifact) => artifact.id !== undefined && artifact.title.toLowerCase().includes(query))
          .slice(0, 8);
  const candidatesRef = useRef(candidates);
  useEffect(() => {
    candidatesRef.current = candidates;
  });
  // A clicked [[Title]] opens that note: straight by id when its preview named
  // one, otherwise the title resolves through the same finder the [[ picker
  // uses, so a link reads and navigates the same way.
  const router = useRouter();
  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    const open = (event: Event) => {
      const { title, id } = (event as CustomEvent<WikiLinkOpen>).detail;
      if (id) return router.push(`/polymath/notes?id=${id}`);
      const wanted = title.toLowerCase();
      const exact = (rows: LinkTarget[]) => rows.find((row) => !row.href && row.title.trim().toLowerCase() === wanted);
      const local = state.artifacts.find((a) => a.id !== undefined && a.title.trim().toLowerCase() === wanted);
      if (local?.id) return router.push(`/polymath/notes?id=${local.id}`);
      if (!findLinkTargets) return notify(`No note titled "${title}" yet.`);
      void findLinkTargets(title, "keyword").then(
        (rows) => {
          const hit = exact(rows);
          if (hit) router.push(`/polymath/notes?id=${hit.id}`);
          else notify(`No note titled "${title}" yet.`);
        },
        () => notify(`Could not open "${title}". Try again.`),
      );
    };
    host.addEventListener(WIKI_LINK_OPEN, open);
    return () => host.removeEventListener(WIKI_LINK_OPEN, open);
  }, [findLinkTargets, notify, router, state.artifacts]);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      // `- [ ]` / `- [x]` round-trip through @tiptap/markdown as real checkboxes.
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: "Write. Press space for AI, / for a block, [[ to link a note." }),
      Markdown,
      // Previews at creation, so the inline link notes draw on the first frame.
      WikiLinks.configure({ previews: linkPreviews ?? null, missingTitles: missingLinkTitles ?? [] }),
      // Fixed at mount: a host either offers suggestions in this editor or not.
      ...(autocomplete ? [InlineCompletion] : []),
    ],
    content,
    contentType: "markdown",
    immediatelyRender: false,
    editable,
    editorProps: {
      handleKeyDown: (_view, event) => {
        // Space on an empty paragraph is the AI affordance (Notion-style): open
        // the menu instead of inserting a space into a blank line.
        if (event.key === " " && onEmptySpace && _view.state.selection.empty) {
          const { $from } = _view.state.selection;
          if ($from.parent.type.name === "paragraph" && $from.parent.content.size === 0) {
            event.preventDefault();
            onEmptySpace();
            return true;
          }
        }
        // The link menu is handled before the slash menu so the two never both
        // respond to the same key. Enter inserts the active record's [[title]].
        if (link) {
          const matches = candidatesRef.current(link.query);
          if (matches.length > 0) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setLinkActive(
                (current) => (current + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length,
              );
              return true;
            }
            if (event.key === "Enter" || event.key === "Escape") {
              event.preventDefault();
              if (event.key === "Escape") {
                setLink(null);
                return true;
              }
              const match = matches[Math.min(linkActive, matches.length - 1)];
              editor
                ?.chain()
                .focus()
                .deleteRange({ from: link.from, to: link.to })
                .insertContent(linkTargetInsertion(match))
                .run();
              setLink(null);
              return true;
            }
          }
        }
        if (!slash) return false;
        const matches = filterBlockCommands(slash.query);
        if (!matches.length) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setSlashActive(
            (current) => (current + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length,
          );
          return true;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          const command = matches[Math.min(slashActive, matches.length - 1)];
          editor?.chain().focus().deleteRange({ from: slash.from, to: slash.to }).run();
          if (command) applyBlock(editor as Editor, command);
          setSlash(null);
          return true;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setSlash(null);
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        // An image on the clipboard is a capture, not text: it uploads through
        // the same multipart route every intake path uses and lands as a
        // markdown link to the stored bytes once the blob exists.
        const image = Array.from(event.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
        if (image) {
          event.preventDefault();
          void insertImageCapture(image, editor, notify);
          return true;
        }
        const pasted = event.clipboardData?.getData("text/plain") || "";
        const reason = markdownSourceReason(pasted);
        if (!reason) return false;
        event.preventDefault();
        editor?.chain().focus().insertContent(pasted, { contentType: "markdown" }).run();
        notify(
          `This paste contains ${reason}, which rich editing cannot preserve. It was inserted as plain text; switch to Markdown source to restore its structure.`,
        );
        onStructuredPasteDropped?.();
        return true;
      },
      handleDrop: (_view, event) => {
        const image = Array.from(event.dataTransfer?.files ?? []).find((f) => f.type.startsWith("image/"));
        if (!image) {
          if (!event.dataTransfer?.files.length) return false;
          event.preventDefault();
          notify("Only images drop in as captures. Other files go through the library or the inbox attach button.");
          return true;
        }
        event.preventDefault();
        void insertImageCapture(image, editor, notify);
        return true;
      },
      attributes: {
        role: "textbox",
        "aria-label": "Rich note content",
        "aria-multiline": "true",
        class: `${compact ? "min-h-24 p-2 text-body-dense leading-6" : floating ? "prose-reading flex-1 cursor-text font-[family-name:var(--font-reading)] text-foreground" : "min-h-72 max-w-[var(--measure-prose)] p-4 text-sm leading-7"} ${editable ? "writing-surface outline-none" : "outline-none [&_*]:cursor-text"} [&_p]:mb-4 [&_h1]:text-2xl [&_h2]:text-xl [&_h2]:mb-3 [&_h3]:text-lg [&_h3]:mb-2 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6 [&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-1 [&_li[data-type=taskItem]]:flex [&_li[data-type=taskItem]]:items-start [&_li[data-type=taskItem]]:gap-2 [&_li[data-type=taskItem]>label]:mt-[0.3em] [&_li[data-type=taskItem]>label]:select-none [&_li[data-type=taskItem]>div]:min-w-0 [&_li[data-type=taskItem]>div]:flex-1 [&_li[data-type=taskItem]_p]:mb-1 [&_li[data-type=taskItem][data-checked=true]>div]:text-muted-foreground [&_li[data-type=taskItem][data-checked=true]>div]:line-through [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:italic [&_pre]:overflow-auto [&_pre]:bg-muted [&_pre]:p-3 [&_a]:text-[var(--link)] [&_a]:no-underline [&_a:hover]:underline`,
      },
    },
    onSelectionUpdate: ({ editor }) => {
      const sel = editor.state.selection;
      onSelectionChange?.(sel.empty ? "" : editor.state.doc.textBetween(sel.from, sel.to, " "));
      if (!floating || !editable) return;
      if (sel.empty) {
        setFloatAt(null);
        return;
      }
      const container = containerRef.current;
      if (!container) return;
      const coords = editor.view.coordsAtPos(sel.from);
      const box = container.getBoundingClientRect();
      setFloatAt({
        top: coords.top - box.top - 8,
        left: Math.max(0, Math.min(coords.left - box.left, box.width - 330)),
      });
    },
    onUpdate: ({ editor }) => {
      onChange(richEditorMarkdown(editor.getMarkdown()));
      const { from } = editor.state.selection;
      const query = editor.state.selection.empty
        ? slashQuery(editor.state.doc.textBetween(Math.max(0, from - 40), from, "\n"))
        : undefined;
      setSlash(query === undefined ? null : { query, from: from - query.length - 1, to: from });
      if (query !== undefined) setSlashActive(0);
      const linkText = editor.state.selection.empty
        ? linkQuery(editor.state.doc.textBetween(Math.max(0, from - 60), from, "\n"))
        : undefined;
      setLink(linkText === undefined ? null : { query: linkText, from: from - linkText.length - 2, to: from });
      if (linkText !== undefined) setLinkActive(0);
    },
  });
  useEffect(() => {
    // Silent: setEditable emits an update by default, which would hand the
    // editor's re-serialized Markdown to onChange and rewrite untouched notes.
    if (editor && editor.isEditable !== editable) editor.setEditable(editable, false);
  }, [editor, editable]);
  const slashMatches = slash ? filterBlockCommands(slash.query) : [];
  const linkMatches = link ? candidates(link.query) : [];
  const formatting = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor?.isActive("bold"),
      italic: editor?.isActive("italic"),
      bulletList: editor?.isActive("bulletList"),
      orderedList: editor?.isActive("orderedList"),
      blockquote: editor?.isActive("blockquote"),
      heading: editor?.isActive("heading", { level: 2 }),
      canUndo: editor?.can().undo(),
      canRedo: editor?.can().redo(),
    }),
  });
  // Menus open under the caret line, inside the panel, so they never cover the text being typed.
  const menuAnchor = link?.to ?? slash?.to ?? null;
  useEffect(() => {
    const panel = containerRef.current;
    if (!editor || !panel || menuAnchor === null) return;
    try {
      const caret = editor.view.coordsAtPos(menuAnchor);
      const box = panel.getBoundingClientRect();
      setMenuPos({
        top: caret.bottom - box.top + 4,
        left: Math.max(8, Math.min(caret.left - box.left, box.width - 296)),
      });
    } catch {
      setMenuPos(null);
    }
  }, [editor, menuAnchor]);
  // Later preview changes (a server render after mount) redraw in place.
  useEffect(() => {
    if (editor && linkPreviews) refreshWikiPreviews(editor, linkPreviews, missingLinkTitles);
  }, [editor, linkPreviews, missingLinkTitles]);
  useEffect(() => {
    if (editor && richEditorMarkdown(editor.getMarkdown()) !== content)
      editor.commands.setContent(content, { contentType: "markdown", emitUpdate: false });
  }, [content, editor]);
  const formatButtons = [
    { label: "Bold", icon: Bold, active: formatting?.bold, run: () => editor?.chain().focus().toggleBold().run() },
    {
      label: "Italic",
      icon: Italic,
      active: formatting?.italic,
      run: () => editor?.chain().focus().toggleItalic().run(),
    },
    {
      label: "Bullet list",
      icon: List,
      active: formatting?.bulletList,
      run: () => editor?.chain().focus().toggleBulletList().run(),
    },
    {
      label: "Ordered list",
      icon: ListOrdered,
      active: formatting?.orderedList,
      run: () => editor?.chain().focus().toggleOrderedList().run(),
    },
    {
      label: "Quote",
      icon: Quote,
      active: formatting?.blockquote,
      run: () => editor?.chain().focus().toggleBlockquote().run(),
    },
  ];
  const linkDialog = (
    <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size={floating ? "sm" : undefined}>
          Link
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Link selected text</DialogTitle>
        <DialogDescription>
          Select text in the editor first. Enter an http, https or relative Polymath URL; leave blank to remove a link.
        </DialogDescription>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            // A relative link is a Polymath path ("/polymath/notes?id=..."); "//host" and
            // "/\host" are another site in disguise, so they are refused with the other schemes.
            if (url && !/^(https?:\/\/|\/(?![/\\]))/.test(url)) {
              notify(
                "Use an http or https link, or a Polymath path such as /polymath/notes. Other schemes are not allowed.",
              );
              return;
            }
            if (url) editor?.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
            else editor?.chain().focus().unsetLink().run();
            setLinkOpen(false);
          }}
        >
          <Input aria-label="Link URL" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Button type="submit">Apply link</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
  const recordDialog = (
    <Dialog open={recordOpen} onOpenChange={setRecordOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost">
          Link an artifact
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogTitle>Insert canonical artifact link</DialogTitle>
        <DialogDescription>
          Equivalent to linking a knowledge page: inserts a Markdown link to an existing artifact identity. Save in
          Notebook to capture its backlink.
        </DialogDescription>
        <SearchField value={recordQuery} onChange={setRecordQuery} placeholder="Search notes and knowledge" />
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {findLinkTargets
            ? remote.map((item) => (
                <Button
                  type="button"
                  key={item.id}
                  className="w-full justify-start"
                  variant="ghost"
                  onClick={() => {
                    editor?.chain().focus().insertContent(linkTargetInsertion(item)).run();
                    setRecordOpen(false);
                  }}
                >
                  {item.title}
                </Button>
              ))
            : state.artifacts
                .filter((item) => item.title.toLowerCase().includes(recordQuery.toLowerCase()))
                .map((item) => (
                  <Button
                    type="button"
                    key={item.id}
                    className="w-full justify-start"
                    variant="ghost"
                    onClick={() => {
                      editor
                        ?.chain()
                        .focus()
                        .insertContent({
                          type: "text",
                          text: item.title,
                          marks: [{ type: "link", attrs: { href: artifactHref(item) } }],
                        })
                        .run();
                      setRecordOpen(false);
                    }}
                  >
                    {item.title}
                  </Button>
                ))}
        </div>
      </DialogContent>
    </Dialog>
  );
  // Notion-style: the blank page below the last block belongs to the writing
  // area, so a click there puts the caret at the end of the note. On click,
  // not mousedown: the host may make the editor editable on this same click,
  // so focus waits a tick for that to land.
  const focusEndFromBlankSpace = (event: MouseEvent<HTMLDivElement>) => {
    if (!editor || !floating) return;
    const root = editor.view.dom;
    if (event.target !== root && event.target !== event.currentTarget) return;
    const last = root.lastElementChild;
    if (last && event.clientY < last.getBoundingClientRect().bottom) return;
    setTimeout(() => {
      if (editor.isEditable && !editor.isDestroyed) editor.commands.focus("end");
    }, 0);
  };
  return (
    <div
      ref={containerRef}
      className={floating ? "relative flex flex-1 flex-col" : "relative panel overflow-hidden rounded-lg"}
      onClick={focusEndFromBlankSpace}
    >
      {slash && slashMatches.length > 0 && (
        <div className="absolute z-50 top-12 left-0" style={menuPos ?? undefined}>
          <SlashMenu
            items={slashMatches}
            active={slashActive}
            onPick={(command) => {
              editor?.chain().focus().deleteRange({ from: slash.from, to: slash.to }).run();
              if (editor) applyBlock(editor, command);
              setSlash(null);
            }}
          />
        </div>
      )}
      {link && linkMatches.length > 0 && (
        <div className="absolute z-50 top-12 left-0" style={menuPos ?? undefined}>
          <div
            role="listbox"
            aria-label="Link a record"
            className="panel z-50 max-h-64 w-72 overflow-y-auto rounded-lg p-1 text-body-dense"
          >
            {linkMatches.map((artifact, index) => (
              <button
                key={artifact.id}
                type="button"
                role="option"
                aria-selected={index === linkActive}
                className={`flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left ${index === linkActive ? "bg-muted" : ""}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  editor
                    ?.chain()
                    .focus()
                    .deleteRange({ from: link.from, to: link.to })
                    .insertContent(linkTargetInsertion(artifact))
                    .run();
                  setLink(null);
                }}
              >
                <span className="font-medium">{artifact.title}</span>
                <span className="text-xs text-muted-foreground">
                  {artifact.kind}
                  {artifact.version !== undefined ? ` / v${artifact.version}` : ""}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      {floating && editable ? (
        floatAt ? (
          <div
            role="toolbar"
            aria-label="Formatting"
            style={{ top: floatAt.top, left: floatAt.left }}
            className="panel absolute z-20 flex w-max max-w-full -translate-y-full flex-wrap items-center gap-0.5 rounded-lg p-1 shadow-md"
            onMouseDown={(event) => event.preventDefault()}
          >
            {formatButtons.map(({ label, icon: Icon, active, run }) => (
              <Button
                type="button"
                key={label}
                size="icon"
                variant={active ? "secondary" : "ghost"}
                aria-label={label}
                title={label}
                aria-pressed={active}
                onClick={run}
                disabled={!editor}
              >
                <Icon aria-hidden />
              </Button>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={formatting?.heading}
              onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
              disabled={!editor}
            >
              Heading
            </Button>
            {linkDialog}
            {recordDialog}
          </div>
        ) : null
      ) : editable ? (
        <div role="toolbar" aria-label="Formatting" className="flex flex-wrap gap-1 border-b border-border p-2">
          {formatButtons.map(({ label, icon: Icon, active, run }) => (
            <Button
              type="button"
              key={label}
              size="icon"
              variant={active ? "secondary" : "ghost"}
              aria-label={label}
              title={label}
              aria-pressed={active}
              onClick={run}
              disabled={!editor}
            >
              <Icon aria-hidden />
            </Button>
          ))}
          <Button
            type="button"
            variant="ghost"
            aria-pressed={formatting?.heading}
            onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
            disabled={!editor}
          >
            Heading
          </Button>
          {linkDialog}
          {recordDialog}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Undo"
            title="Undo"
            disabled={!editor || !formatting?.canUndo}
            onClick={() => editor?.chain().focus().undo().run()}
          >
            <Undo2 aria-hidden />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Redo"
            title="Redo"
            disabled={!editor || !formatting?.canRedo}
            onClick={() => editor?.chain().focus().redo().run()}
          >
            <Redo2 aria-hidden />
          </Button>
        </div>
      ) : null}
      <EditorContent editor={editor} className={floating ? "flex flex-1 flex-col" : undefined} />
    </div>
  );
}
