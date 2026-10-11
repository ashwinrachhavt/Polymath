"use client";

import { useEffect, useState } from "react";
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

export default function RichEditor({ content, onChange }: { content: string; onChange: (content: string) => void }) {
  const [preferred, setPreferred] = useState<MarkdownEditorMode>(() => markdownEditorMode(content));
  const reason = markdownSourceReason(content);
  const mode = markdownEditorMode(content, preferred);
  return <div className="space-y-3"><div className="flex flex-wrap items-center gap-2"><Button type="button" variant={mode === "rich" ? "secondary" : "outline"} aria-pressed={mode === "rich"} disabled={!!reason} onClick={() => setPreferred("rich")}>Rich text</Button><Button type="button" variant={mode === "source" ? "secondary" : "outline"} aria-pressed={mode === "source"} onClick={() => setPreferred("source")}>Markdown source</Button></div>{reason && <p role="status" className="text-[13px] leading-relaxed text-muted-foreground">This document contains {reason}, which this rich editor cannot preserve. Source mode keeps the original Markdown, URLs and states intact. Rich editing is disabled until you deliberately remove or rewrite those constructs in source.</p>}{mode === "source" ? <Textarea aria-label="Markdown source" className="min-h-72 font-mono text-[13px]" value={content} onChange={(event) => onChange(event.target.value)} /> : <RichMarkdownEditor content={content} onChange={onChange} />}</div>;
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

function RichMarkdownEditor({ content, onChange }: { content: string; onChange: (content: string) => void }) {
  const { state, notify } = useWorkspace();
  const [slash, setSlash] = useState<{ query: string; from: number; to: number } | null>(null);
  const [link, setLink] = useState<{ query: string; from: number; to: number } | null>(null);
  const [linkActive, setLinkActive] = useState(0);
  const [slashActive, setSlashActive] = useState(0);
  const [url, setUrl] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [recordQuery, setRecordQuery] = useState("");
  const [recordOpen, setRecordOpen] = useState(false);
  const editor = useEditor({ extensions: [StarterKit.configure({ link: { openOnClick: false } }), Placeholder.configure({ placeholder: "Write a working note. Type / for a block, [[ to link a record." }), Markdown], content, contentType: "markdown", immediatelyRender: false, editorProps: { handleKeyDown: (_view, event) => {
    if (!slash) return false;
    const matches = filterBlockCommands(slash.query);
    if (!matches.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setSlashActive((current) => (current + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length); return true; }
    if (event.key === "Enter") { event.preventDefault(); const command = matches[Math.min(slashActive, matches.length - 1)]; editor?.chain().focus().deleteRange({ from: slash.from, to: slash.to }).run(); if (command) applyBlock(editor as Editor, command); setSlash(null); return true; }
    if (event.key === "Escape") { event.preventDefault(); setSlash(null); return true; }
    return false;
  }, handlePaste: (_view, event) => { const pasted = event.clipboardData?.getData("text/plain") || ""; if (!markdownSourceReason(pasted)) return false; event.preventDefault(); notify("This paste contains unsupported Markdown. Switch to Markdown source and paste there to preserve it; nothing was inserted."); return true; }, handleDrop: (_view, event) => { if (!event.dataTransfer?.files.length) return false; event.preventDefault(); notify("File and image insertion is unavailable. Preserve image references through Markdown source instead."); return true; }, attributes: { role: "textbox", "aria-label": "Rich note content", "aria-multiline": "true", class: "min-h-72 max-w-[75ch] p-4 text-sm leading-7 outline-none [&_p]:mb-3 [&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_pre]:overflow-auto [&_pre]:bg-muted [&_pre]:p-3 [&_a]:text-primary [&_a]:underline" } }, onUpdate: ({ editor }) => {
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
  const linkMatches = link ? state.artifacts.filter((artifact) => artifact.id !== undefined && artifact.title.toLowerCase().includes(link.query)).slice(0, 8) : [];
  const formatting = useEditorState({ editor, selector: ({ editor }) => ({ bold: editor?.isActive("bold"), italic: editor?.isActive("italic"), bulletList: editor?.isActive("bulletList"), orderedList: editor?.isActive("orderedList"), blockquote: editor?.isActive("blockquote"), heading: editor?.isActive("heading", { level: 2 }), canUndo: editor?.can().undo(), canRedo: editor?.can().redo() }) });
  useEffect(() => { if (editor && editor.getMarkdown() !== content) editor.commands.setContent(content, { contentType: "markdown", emitUpdate: false }); }, [content, editor]);
  return <div className="relative panel overflow-hidden rounded-lg">{slash && slashMatches.length > 0 && <div className="absolute top-12 left-4"><SlashMenu items={slashMatches} active={slashActive} onPick={(command) => { editor?.chain().focus().deleteRange({ from: slash.from, to: slash.to }).run(); if (editor) applyBlock(editor, command); setSlash(null); }} /></div>}{link && linkMatches.length > 0 && <div className="absolute top-12 left-4"><div role="listbox" aria-label="Link a record" className="panel z-50 max-h-64 w-72 overflow-y-auto rounded-lg p-1 text-[13px]">{linkMatches.map((artifact, index) => <button key={artifact.id} type="button" role="option" aria-selected={index === linkActive} className={`flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left ${index === linkActive ? "bg-muted" : ""}`} onMouseDown={(event) => { event.preventDefault(); editor?.chain().focus().deleteRange({ from: link.from, to: link.to }).insertContent(`[[${artifact.title}]] `).run(); setLink(null); }}><span className="font-medium">{artifact.title}</span><span className="text-xs text-muted-foreground">{artifact.kind} / v{artifact.version}</span></button>)}</div></div>}<div role="toolbar" aria-label="Formatting" className="flex flex-wrap gap-1 border-b border-border p-2">{[
    { label: "Bold", icon: Bold, active: formatting?.bold, run: () => editor?.chain().focus().toggleBold().run() },
    { label: "Italic", icon: Italic, active: formatting?.italic, run: () => editor?.chain().focus().toggleItalic().run() },
    { label: "Bullet list", icon: List, active: formatting?.bulletList, run: () => editor?.chain().focus().toggleBulletList().run() },
    { label: "Ordered list", icon: ListOrdered, active: formatting?.orderedList, run: () => editor?.chain().focus().toggleOrderedList().run() },
    { label: "Quote", icon: Quote, active: formatting?.blockquote, run: () => editor?.chain().focus().toggleBlockquote().run() },
    { label: "Undo", icon: Undo2, disabled: !formatting?.canUndo, run: () => editor?.chain().focus().undo().run() },
    { label: "Redo", icon: Redo2, disabled: !formatting?.canRedo, run: () => editor?.chain().focus().redo().run() },
  ].map(({ label, icon: Icon, active, disabled, run }) => <Button type="button" key={label} size="icon" variant={active ? "secondary" : "ghost"} aria-label={label} title={label} aria-pressed={active} onClick={run} disabled={!editor || disabled}><Icon aria-hidden /></Button>)}<Button type="button" variant="ghost" aria-pressed={formatting?.heading} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} disabled={!editor}>Heading</Button><Dialog open={linkOpen} onOpenChange={setLinkOpen}><DialogTrigger asChild><Button type="button" variant="ghost">Link</Button></DialogTrigger><DialogContent><DialogTitle>Link selected text</DialogTitle><DialogDescription>Select text in the editor first. Enter an http, https or relative Axiom URL; leave blank to remove a link.</DialogDescription><form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (url && !/^(https?:\/\/|\/apps\/)/.test(url)) { notify("Use an http, https or /apps/ link. Other schemes are not allowed."); return; } if (url) editor?.chain().focus().extendMarkRange("link").setLink({ href: url }).run(); else editor?.chain().focus().unsetLink().run(); setLinkOpen(false); }}><Input aria-label="Link URL" value={url} onChange={(e) => setUrl(e.target.value)} /><Button type="submit">Apply link</Button></form></DialogContent></Dialog><Dialog open={recordOpen} onOpenChange={setRecordOpen}><DialogTrigger asChild><Button type="button" variant="ghost">Link an artifact</Button></DialogTrigger><DialogContent className="sm:max-w-lg"><DialogTitle>Insert canonical artifact link</DialogTitle><DialogDescription>Equivalent to linking a knowledge page: inserts a Markdown link to an existing artifact identity. Save in Notebook to capture its backlink.</DialogDescription><SearchField value={recordQuery} onChange={setRecordQuery} placeholder="Search notes and knowledge" /><div className="max-h-72 space-y-1 overflow-y-auto">{state.artifacts.filter((item) => item.title.toLowerCase().includes(recordQuery.toLowerCase())).map((item) => <Button type="button" key={item.id} className="w-full justify-start" variant="ghost" onClick={() => { editor?.chain().focus().insertContent({ type: "text", text: item.title, marks: [{ type: "link", attrs: { href: artifactHref(item) } }] }).run(); setRecordOpen(false); }}>{item.title}</Button>)}</div></DialogContent></Dialog><Dialog><DialogTrigger asChild><Button type="button" variant="ghost">Ask AI</Button></DialogTrigger><DialogContent><DialogTitle>Contextual writing assistance</DialogTitle><DialogDescription>Inline assistance controls are represented here, but no model-generated edits are simulated.</DialogDescription><Unavailable feature="Inline writing AI" /><div className="grid grid-cols-2 gap-2">{["Improve writing", "Fix spelling", "Make shorter", "Make longer", "Simplify", "Continue", "Summarize", "Extract action items", "Translate", "Change tone"].map((label) => <Button type="button" key={label} disabled variant="outline">{label}</Button>)}</div><p className="text-xs text-muted-foreground">Production edits must be staged as a reviewable proposal before acceptance. No generated text has been inserted.</p></DialogContent></Dialog></div><EditorContent editor={editor} /></div>;
}
