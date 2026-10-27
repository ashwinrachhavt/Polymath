"use client";

import { useEffect, useRef, useState } from "react";
import { linkTargetInsertion, type LinkTarget } from "./link-target-insertion";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { Bold, Italic, List, ListOrdered, Quote, Undo2, Redo2 } from "lucide-react";
import { filterBlockCommands, slashQuery, type BlockCommand } from "@/components/workspace/slash-commands";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { markdownEditorMode, markdownSourceReason, type MarkdownEditorMode } from "./markdown-preservation";
import { SearchField, Unavailable } from "@/components/workspace/ui";
import { artifactHref } from "./artifact-controls";
import { NoteAIMenu, type NoteAIRequest } from "./note-ai-menu";

/** A card the `[[` picker can offer. `version` only comes from the local preview store. */
export type { LinkTarget } from "./link-target-insertion";
export { linkTargetInsertion };
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
  mode: controlledMode,
  onModeChange,
}: {
  content: string;
  onChange: (content: string) => void;
  ai?: RichEditorAI;
  findLinkTargets?: FindLinkTargets;
  chrome?: "full" | "minimal";
  /** Short inline editor (task cards) instead of the full-page writing height. */
  compact?: boolean;
  mode?: MarkdownEditorMode;
  onModeChange?: (mode: MarkdownEditorMode) => void;
}) {
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
    setSelection(textarea.selectionStart === textarea.selectionEnd ? "" : textarea.value.slice(textarea.selectionStart, textarea.selectionEnd));
  };
  const minimal = chrome === "minimal";
  return (
    <div className={minimal ? "relative" : "space-y-3"}>
      {minimal ? (
        ai ? (
          <div className="mb-2 flex justify-end">
            <NoteAIMenu selection={selection} pending={ai.pending} onAction={ai.onAction} open={ai.open} onOpenChange={ai.onOpenChange} />
          </div>
        ) : null
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant={mode === "rich" ? "secondary" : "outline"} aria-pressed={mode === "rich"} disabled={!!reason} onClick={() => setPreferred("rich")}>Rich text</Button>
          <Button type="button" variant={mode === "source" ? "secondary" : "outline"} aria-pressed={mode === "source"} onClick={() => setPreferred("source")}>Markdown source</Button>
          {ai ? <NoteAIMenu selection={selection} pending={ai.pending} onAction={ai.onAction} open={ai.open} onOpenChange={ai.onOpenChange} /> : null}
        </div>
      )}
      {reason && <p role="status" className="mb-3 text-[13px] leading-relaxed text-muted-foreground">This document contains {reason}, which this rich editor cannot preserve. Source mode keeps the original Markdown, URLs and states intact. Rich editing is disabled until you deliberately remove or rewrite those constructs in source.</p>}
      {mode === "source" ? (
        <Textarea
          aria-label="Markdown source"
          className={minimal ? "writing-surface min-h-[55vh] border-0 bg-transparent px-0 font-mono text-[13px] shadow-none focus-visible:ring-0" : "min-h-72 font-mono text-[13px]"}
          value={content}
          onChange={(event) => onChange(event.target.value)}
          onSelect={(event) => readTextareaSelection(event.currentTarget)}
          onKeyUp={(event) => readTextareaSelection(event.currentTarget)}
        />
      ) : (
        <RichMarkdownEditor findLinkTargets={findLinkTargets} content={content} onChange={onChange} onSelectionChange={ai ? setSelection : undefined} hidePlaceholderAI={!!ai} compact={compact} onEmptySpace={ai?.onOpenChange ? () => ai.onOpenChange!(true) : undefined} floating={minimal} />
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
export function linkQuery(textBeforeCursor: string) {
  const match = /\[\[([^\]\n]*)$/.exec(textBeforeCursor);
  return match ? match[1].toLowerCase() : undefined;
}

function SlashMenu({ items, active, onPick }: { items: BlockCommand[]; active: number; onPick: (command: BlockCommand) => void }) {
  return <div role="listbox" aria-label="Insert block" className="panel absolute z-50 max-h-64 w-64 overflow-y-auto rounded-lg p-1 text-[13px]">
    {items.map((command, index) => <button key={command.id} type="button" role="option" aria-selected={index === active} className={`flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left ${index === active ? "bg-muted" : ""}`} onMouseDown={(event) => { event.preventDefault(); onPick(command); }}>
      <span className="font-medium">{command.label}</span>
      <span className="text-xs text-muted-foreground">{command.hint}</span>
    </button>)}
  </div>;
}

function RichMarkdownEditor({ content, onChange, onSelectionChange, hidePlaceholderAI, onEmptySpace, findLinkTargets, floating, compact }: { compact?: boolean; findLinkTargets?: FindLinkTargets; content: string; onChange: (content: string) => void; onSelectionChange?: (text: string) => void; hidePlaceholderAI?: boolean; onEmptySpace?: () => void; floating?: boolean }) {
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
    void findLinkTargets(query, "keyword").then((rows) => { if (live) setRemote(rows); });
    const timer = query.trim() ? setTimeout(() => { void findLinkTargets(query, "hybrid").then((rows) => { if (live) setRemote(rows); }); }, 250) : undefined;
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [findLinkTargets, wanted]);
  const candidates = (query: string): LinkTarget[] =>
    findLinkTargets ? remote : state.artifacts.filter((artifact) => artifact.id !== undefined && artifact.title.toLowerCase().includes(query)).slice(0, 8);
  const candidatesRef = useRef(candidates);
  useEffect(() => { candidatesRef.current = candidates; });
  const editor = useEditor({ extensions: [StarterKit.configure({ link: { openOnClick: false } }), Placeholder.configure({ placeholder: "Write. Press space for AI, / for a block, [[ to link a note." }), Markdown], content, contentType: "markdown", immediatelyRender: false, editorProps: { handleKeyDown: (_view, event) => {
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
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setLinkActive((current) => (current + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length); return true; }
        if (event.key === "Enter" || event.key === "Escape") {
          event.preventDefault();
          if (event.key === "Escape") { setLink(null); return true; }
          const match = matches[Math.min(linkActive, matches.length - 1)];
          editor?.chain().focus().deleteRange({ from: link.from, to: link.to }).insertContent(linkTargetInsertion(match)).run();
          setLink(null);
          return true;
        }
      }
    }
    if (!slash) return false;
    const matches = filterBlockCommands(slash.query);
    if (!matches.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSlashActive((current) => (current + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length); return true; }
    if (event.key === "Enter") { event.preventDefault(); const command = matches[Math.min(slashActive, matches.length - 1)]; editor?.chain().focus().deleteRange({ from: slash.from, to: slash.to }).run(); if (command) applyBlock(editor as Editor, command); setSlash(null); return true; }
    if (event.key === "Escape") { event.preventDefault(); setSlash(null); return true; }
    return false;
  }, handlePaste: (_view, event) => { const pasted = event.clipboardData?.getData("text/plain") || ""; if (!markdownSourceReason(pasted)) return false; event.preventDefault(); notify("This paste contains unsupported Markdown. Switch to Markdown source and paste there to preserve it; nothing was inserted."); return true; }, handleDrop: (_view, event) => { if (!event.dataTransfer?.files.length) return false; event.preventDefault(); notify("File and image insertion is unavailable. Preserve image references through Markdown source instead."); return true; }, attributes: { role: "textbox", "aria-label": "Rich note content", "aria-multiline": "true", class: `${compact ? "min-h-24 p-2 text-[13px] leading-6" : floating ? "min-h-[55vh] font-[family-name:var(--font-reading)] text-[16px] leading-[1.75] text-foreground" : "min-h-72 max-w-[75ch] p-4 text-sm leading-7"} writing-surface outline-none [&_p]:mb-4 [&_h1]:text-2xl [&_h2]:text-xl [&_h3]:text-lg [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:italic [&_pre]:overflow-auto [&_pre]:bg-muted [&_pre]:p-3 [&_a]:text-primary [&_a]:underline` } }, onSelectionUpdate: ({ editor }) => {
    const sel = editor.state.selection;
    onSelectionChange?.(sel.empty ? "" : editor.state.doc.textBetween(sel.from, sel.to, " "));
    if (!floating) return;
    if (sel.empty) {
      setFloatAt(null);
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const coords = editor.view.coordsAtPos(sel.from);
    const box = container.getBoundingClientRect();
    setFloatAt({ top: coords.top - box.top - 8, left: Math.max(0, Math.min(coords.left - box.left, box.width - 330)) });
  }, onUpdate: ({ editor }) => {
    onChange(editor.getMarkdown());
    const { from } = editor.state.selection;
    const query = editor.state.selection.empty ? slashQuery(editor.state.doc.textBetween(Math.max(0, from - 40), from, "\n")) : undefined;
    setSlash(query === undefined ? null : { query, from: from - query.length - 1, to: from });
    if (query !== undefined) setSlashActive(0);
    const linkText = editor.state.selection.empty ? linkQuery(editor.state.doc.textBetween(Math.max(0, from - 60), from, "\n")) : undefined;
    setLink(linkText === undefined ? null : { query: linkText, from: from - linkText.length - 2, to: from });
    if (linkText !== undefined) setLinkActive(0);
  } });
  const slashMatches = slash ? filterBlockCommands(slash.query) : [];
  const linkMatches = link ? candidates(link.query) : [];
  const formatting = useEditorState({ editor, selector: ({ editor }) => ({ bold: editor?.isActive("bold"), italic: editor?.isActive("italic"), bulletList: editor?.isActive("bulletList"), orderedList: editor?.isActive("orderedList"), blockquote: editor?.isActive("blockquote"), heading: editor?.isActive("heading", { level: 2 }), canUndo: editor?.can().undo(), canRedo: editor?.can().redo() }) });
  // Menus open under the caret line, inside the panel, so they never cover the text being typed.
  const menuAnchor = link?.to ?? slash?.to ?? null;
  useEffect(() => {
    const panel = containerRef.current;
    if (!editor || !panel || menuAnchor === null) return;
    try {
      const caret = editor.view.coordsAtPos(menuAnchor);
      const box = panel.getBoundingClientRect();
      setMenuPos({ top: caret.bottom - box.top + 4, left: Math.max(8, Math.min(caret.left - box.left, box.width - 296)) });
    } catch {
      setMenuPos(null);
    }
  }, [editor, menuAnchor]);
  useEffect(() => { if (editor && editor.getMarkdown() !== content) editor.commands.setContent(content, { contentType: "markdown", emitUpdate: false }); }, [content, editor]);
  const formatButtons = [
    { label: "Bold", icon: Bold, active: formatting?.bold, run: () => editor?.chain().focus().toggleBold().run() },
    { label: "Italic", icon: Italic, active: formatting?.italic, run: () => editor?.chain().focus().toggleItalic().run() },
    { label: "Bullet list", icon: List, active: formatting?.bulletList, run: () => editor?.chain().focus().toggleBulletList().run() },
    { label: "Ordered list", icon: ListOrdered, active: formatting?.orderedList, run: () => editor?.chain().focus().toggleOrderedList().run() },
    { label: "Quote", icon: Quote, active: formatting?.blockquote, run: () => editor?.chain().focus().toggleBlockquote().run() },
  ];
  const linkDialog = (
    <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
      <DialogTrigger asChild><Button type="button" variant="ghost" size={floating ? "sm" : undefined}>Link</Button></DialogTrigger>
      <DialogContent><DialogTitle>Link selected text</DialogTitle><DialogDescription>Select text in the editor first. Enter an http, https or relative Polymath URL; leave blank to remove a link.</DialogDescription><form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (url && !/^(https?:\/\/|\/apps\/)/.test(url)) { notify("Use an http, https or /apps/ link. Other schemes are not allowed."); return; } if (url) editor?.chain().focus().extendMarkRange("link").setLink({ href: url }).run(); else editor?.chain().focus().unsetLink().run(); setLinkOpen(false); }}><Input aria-label="Link URL" value={url} onChange={(e) => setUrl(e.target.value)} /><Button type="submit">Apply link</Button></form></DialogContent>
    </Dialog>
  );
  const recordDialog = (
    <Dialog open={recordOpen} onOpenChange={setRecordOpen}><DialogTrigger asChild><Button type="button" variant="ghost">Link an artifact</Button></DialogTrigger><DialogContent className="sm:max-w-lg"><DialogTitle>Insert canonical artifact link</DialogTitle><DialogDescription>Equivalent to linking a knowledge page: inserts a Markdown link to an existing artifact identity. Save in Notebook to capture its backlink.</DialogDescription><SearchField value={recordQuery} onChange={setRecordQuery} placeholder="Search notes and knowledge" /><div className="max-h-72 space-y-1 overflow-y-auto">{findLinkTargets
            ? remote.map((item) => <Button type="button" key={item.id} className="w-full justify-start" variant="ghost" onClick={() => { editor?.chain().focus().insertContent(linkTargetInsertion(item)).run(); setRecordOpen(false); }}>{item.title}</Button>)
            : state.artifacts.filter((item) => item.title.toLowerCase().includes(recordQuery.toLowerCase())).map((item) => <Button type="button" key={item.id} className="w-full justify-start" variant="ghost" onClick={() => { editor?.chain().focus().insertContent({ type: "text", text: item.title, marks: [{ type: "link", attrs: { href: artifactHref(item) } }] }).run(); setRecordOpen(false); }}>{item.title}</Button>)}</div></DialogContent></Dialog>
  );
  return (
    <div ref={containerRef} className={floating ? "relative" : "relative panel overflow-hidden rounded-lg"}>
      {slash && slashMatches.length > 0 && <div className="absolute z-50 top-12 left-0" style={menuPos ?? undefined}><SlashMenu items={slashMatches} active={slashActive} onPick={(command) => { editor?.chain().focus().deleteRange({ from: slash.from, to: slash.to }).run(); if (editor) applyBlock(editor, command); setSlash(null); }} /></div>}
      {link && linkMatches.length > 0 && <div className="absolute z-50 top-12 left-0" style={menuPos ?? undefined}><div role="listbox" aria-label="Link a record" className="panel z-50 max-h-64 w-72 overflow-y-auto rounded-lg p-1 text-[13px]">{linkMatches.map((artifact, index) => <button key={artifact.id} type="button" role="option" aria-selected={index === linkActive} className={`flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left ${index === linkActive ? "bg-muted" : ""}`} onMouseDown={(event) => { event.preventDefault(); editor?.chain().focus().deleteRange({ from: link.from, to: link.to }).insertContent(linkTargetInsertion(artifact)).run(); setLink(null); }}><span className="font-medium">{artifact.title}</span><span className="text-xs text-muted-foreground">{artifact.kind}{artifact.version !== undefined ? ` / v${artifact.version}` : ""}</span></button>)}</div></div>}
      {floating ? (
        floatAt ? (
          <div
            role="toolbar"
            aria-label="Formatting"
            style={{ top: floatAt.top, left: floatAt.left }}
            className="panel absolute z-20 flex w-max max-w-full -translate-y-full flex-wrap items-center gap-0.5 rounded-lg p-1 shadow-md"
            onMouseDown={(event) => event.preventDefault()}
          >
            {formatButtons.map(({ label, icon: Icon, active, run }) => (
              <Button type="button" key={label} size="icon" variant={active ? "secondary" : "ghost"} aria-label={label} title={label} aria-pressed={active} onClick={run} disabled={!editor}><Icon aria-hidden /></Button>
            ))}
            <Button type="button" variant="ghost" size="sm" aria-pressed={formatting?.heading} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} disabled={!editor}>Heading</Button>
            {linkDialog}
            {recordDialog}
          </div>
        ) : null
      ) : (
        <div role="toolbar" aria-label="Formatting" className="flex flex-wrap gap-1 border-b border-border p-2">
          {formatButtons.map(({ label, icon: Icon, active, run }) => (
            <Button type="button" key={label} size="icon" variant={active ? "secondary" : "ghost"} aria-label={label} title={label} aria-pressed={active} onClick={run} disabled={!editor}><Icon aria-hidden /></Button>
          ))}
          <Button type="button" variant="ghost" aria-pressed={formatting?.heading} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} disabled={!editor}>Heading</Button>
          {linkDialog}
          {recordDialog}
          <Button type="button" size="icon" variant="ghost" aria-label="Undo" title="Undo" disabled={!editor || !formatting?.canUndo} onClick={() => editor?.chain().focus().undo().run()}><Undo2 aria-hidden /></Button>
          <Button type="button" size="icon" variant="ghost" aria-label="Redo" title="Redo" disabled={!editor || !formatting?.canRedo} onClick={() => editor?.chain().focus().redo().run()}><Redo2 aria-hidden /></Button>
          {hidePlaceholderAI ? null : <Dialog><DialogTrigger asChild><Button type="button" variant="ghost">Ask AI</Button></DialogTrigger><DialogContent><DialogTitle>Contextual writing assistance</DialogTitle><DialogDescription>Inline assistance controls are represented here, but no model-generated edits are simulated.</DialogDescription><Unavailable feature="Inline writing AI" /><div className="grid grid-cols-2 gap-2">{["Improve writing", "Fix spelling", "Make shorter", "Make longer", "Simplify", "Continue", "Summarize", "Extract action items", "Translate", "Change tone"].map((label) => <Button type="button" key={label} disabled variant="outline">{label}</Button>)}</div><p className="text-xs text-muted-foreground">Production edits must be staged as a reviewable proposal before acceptance. No generated text has been inserted.</p></DialogContent></Dialog>}
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
