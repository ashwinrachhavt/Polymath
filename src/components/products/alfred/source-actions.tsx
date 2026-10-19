"use client";

import { Select } from "@/components/ui/select";

import { useState } from "react";
import Link from "next/link";
import { ListTodo, NotebookPen, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import type { Artifact } from "@/components/workspace/types";

export default function SourceActions({ source, quote }: { source: Artifact; quote: string }) {
  const { state, addTask, addArtifact, updateArtifact, notify } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  function note(blog: boolean) {
    const record = addArtifact(`${blog ? "Draft" : "Reading note"}: ${source.title}`, "note", `Source: ${source.title} (v${source.version})\n\nSelected passage:\n${quote || "No passage selected. Inspect the linked source."}\n\nMy ${blog ? "draft" : "observations"}:\n`);
    if (!record) return;
    updateArtifact(record.id, { links: [source.id], tags: [blog ? "Blog draft" : "Reading note"] });
    notify(blog ? "Source-linked blog draft created locally. Open Blog studio to write." : "Source-linked reading note created locally. Open Notebook to continue.");
  }
  return <div className="mt-3 flex flex-wrap gap-2"><Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button variant="outline"><ListTodo aria-hidden />Create source-linked task</Button></DialogTrigger><DialogContent className="sm:max-w-lg"><DialogTitle>Clarify a source into a commitment</DialogTitle><DialogDescription>Manual task creation, not AI extraction. This is the same task shown in NeuralFlow, linked back to {source.title} v{source.version}.</DialogDescription><form className="space-y-4" onSubmit={(e) => { e.preventDefault(); const task = addTask(title, { status: "BACKLOG", projectId: projectId || undefined, description: `${description}\n\nSource: ${source.title} (${source.id}) v${source.version}\n${quote}` }); if (task) { updateArtifact(source.id, { links: [...source.links, task.id] }); setOpen(false); setTitle(""); notify("Canonical task created and linked to its source. No extraction ran."); } }}><Field label="Commitment"><Input required value={title} onChange={(e) => setTitle(e.target.value)} /></Field><Field label="Description and evidence"><Textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} /></Field><Field label="Project (optional)"><Select value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">No project</option>{state.projects.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</Select></Field><Button type="submit" disabled={!title.trim()}>Create canonical task</Button></form></DialogContent></Dialog><Button variant="ghost" onClick={() => note(false)}><NotebookPen aria-hidden />Create reading note</Button><Button variant="ghost" onClick={() => note(true)}><PenLine aria-hidden />Start blog draft</Button><Button asChild variant="ghost"><Link href={`/apps/alfred/chat?id=${source.id}`}>Ask about this source</Link></Button></div>;
}
