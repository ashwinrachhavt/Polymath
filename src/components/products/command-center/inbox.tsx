"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Empty, Field, Panel, Screen, Status, Unavailable } from "@/components/workspace/ui";
import { ImportedFileState } from "@/components/workspace/import-drop";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import { Select } from "./controls";

const labels = { UNPROCESSED: "To clarify", TASK: "Turned into a task", NOTE: "Turned into a note", ARCHIVED: "Archived", All: "All captures" };

export default function Inbox() {
  const { state, addCapture, clarifyCapture, updateCapture, notify } = useWorkspace();
  const [filter, setFilter] = useState<keyof typeof labels>("UNPROCESSED");
  const [text, setText] = useState("");
  const captures = state.captures.filter((capture) => filter === "All" || capture.status === filter);
  const pending = state.captures.filter((capture) => capture.status === "UNPROCESSED").length;

  return <Screen title="Inbox" description="Original text and attachments stay here after conversion. This inbox is a browser preview, not a connected mailbox." actions={<><Status>{pending} to clarify</Status><Button variant="outline" size="sm" asChild><Link href="/command-center/inbox">Open durable inbox</Link></Button></>}>
    <Panel title="Capture material" description="Remote content is not fetched.">
      <form className="grid gap-3" onSubmit={(event) => {
        event.preventDefault();
        if (addCapture(text, /^https?:\/\//i.test(text.trim()) ? "url" : "text")) { setText(""); setFilter("UNPROCESSED"); notify("Item added to the preview inbox."); }
        else notify("This capture was not saved. Another tab may have changed the workspace; your text is still in the form.");
      }}>
        <Field label="Original material"><Textarea required maxLength={20000} value={text} onChange={(event) => setText(event.target.value)} placeholder="Paste a thought, source excerpt, or URL" /></Field>
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Use Capture in the header to attach a local file.</p><Button type="submit" disabled={!text.trim()}>Capture to inbox</Button></div>
      </form>
    </Panel>
    <div className="flex flex-wrap items-end justify-between gap-3">
      <Field label="Triage status"><Select value={filter} onChange={(event) => setFilter(event.target.value as keyof typeof labels)} className="max-w-xs">{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
      <Button variant="outline" asChild><Link href="/alfred/knowledge">Upload and extract documents</Link></Button>
    </div>
    <Panel title={`${captures.length} ${captures.length === 1 ? "capture" : "captures"}`}>
      <div className="divide-y divide-border">{captures.map((capture) => <article key={capture.id} className="py-4 first:pt-0">
        <div className="mb-2 flex flex-wrap items-center gap-2"><Status>{labels[capture.status]}</Status><span className="text-xs text-muted-foreground">{capture.kind}</span><time className="readout text-xs text-muted-foreground" dateTime={capture.createdAt}>{new Intl.DateTimeFormat("en", { timeZone: state.preferences.timezone, dateStyle: "medium" }).format(new Date(capture.createdAt))}</time></div>
        <p className="whitespace-pre-wrap break-words text-[13px]">{capture.text}</p>
        {capture.attachment && <div className="mt-3"><ImportedFileState name={capture.attachment.label} size={capture.attachment.size} value={capture.attachment.value} /></div>}
        {capture.status === "UNPROCESSED" && <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => { if (clarifyCapture(capture.id, "task")) notify("Task created in Work. Original material retained in the inbox."); }}>Make task</Button>
          <Button size="sm" variant="outline" onClick={() => { if (clarifyCapture(capture.id, "note")) notify("Note created in the library. Original material retained in the inbox."); }}>Make note</Button>
          <Button size="sm" variant="ghost" onClick={() => updateCapture(capture.id, { status: "ARCHIVED" })}>Archive</Button>
        </div>}
        {capture.derivedId && <Button size="sm" variant="outline" className="mt-3" asChild><Link href={capture.status === "TASK" ? `/neuralflow/work?task=${encodeURIComponent(capture.derivedId)}` : `/apps/alfred/notebook?id=${encodeURIComponent(capture.derivedId)}`}>{capture.status === "TASK" ? "Open task in Work" : "Open note in the assistant"}</Link></Button>}
        {capture.status === "ARCHIVED" && <Button className="mt-3" size="sm" variant="outline" onClick={() => updateCapture(capture.id, { status: "UNPROCESSED" })}>Restore capture</Button>}
      </article>)}</div>
      {!captures.length && <Empty title="Nothing in this view" description="Nothing in this view." />}
    </Panel>
    <Unavailable feature="Mailbox acquisition">No messages are pulled on arrival. Explicit mailbox reads require a configured account and authenticated read adapter.</Unavailable>
  </Screen>;
}
