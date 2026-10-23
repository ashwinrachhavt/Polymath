"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode, type FormEvent } from "react";
import { Plus, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Select } from "@/components/ui/select";
import { Empty, Field, Status, Unavailable } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import type { Task, TaskAttachment, TaskStatus } from "@/components/workspace/types";
import { localDate, statusLabels, taskStatuses } from "./planning";
import { recurrenceForPreset, presetForRecurrence, recurrencePresets } from "@/components/workspace/slash-commands";
import { ImportDrop, ImportedFileState } from "@/components/workspace/import-drop";
import { recurrenceLabel } from "@/components/workspace/tasks";
import "./neuralflow-stones.css";


function TaskForm({ task, defaultStatus = "INBOX", onSaved }: { task?: Task; defaultStatus?: TaskStatus; onSaved: () => void }) {
  const { state, addTask, updateTask } = useWorkspace();
  const [error, setError] = useState("");
  const [baselineVersion] = useState(task?.version);
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const title = String(data.get("title") || "").trim();
    if (!title) { setError("Enter a task title."); return; }
    if (task && state.tasks.find((item) => item.id === task.id)?.version !== baselineVersion) { setError("This task changed while you were editing. Close and reopen the inspector to load its latest version."); return; }
    const recurrence = recurrenceForPreset(String(data.get("recurrence") || "none"));
    const typedDue = String(data.get("due") || "") || undefined;
    // A repeat rule with no date has nothing to advance, so it starts today
    // rather than silently doing nothing on completion.
    const dueDate = recurrence && !typedDue ? localDate() : typedDue;
    const patch = {
      status: String(data.get("status")) as TaskStatus,
      priority: String(data.get("priority")) as Task["priority"],
      projectId: String(data.get("project") || "") || undefined,
      dueDate,
      estimate: Number(data.get("estimate")),
      description: String(data.get("description") || ""),
      tags: String(data.get("tags") || "").split(",").map((tag) => tag.trim()).filter(Boolean),
      recurrence,
    };
    if (task) updateTask(task.id, { title, ...patch });
    else addTask(title, patch);
    onSaved();
  }
  return <form onSubmit={save} className="space-y-4">
    <Field label="Title"><Input name="title" required maxLength={300} defaultValue={task?.title} autoFocus /></Field>
    <Field label="Description"><Textarea name="description" defaultValue={task?.description} rows={4} /></Field>
    <div className="grid grid-cols-2 gap-3">
      <Field label="Status"><Select name="status" defaultValue={task?.status || defaultStatus}>{taskStatuses.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}</Select></Field>
      <Field label="Priority"><Select name="priority" defaultValue={task?.priority || "Medium"}>{["High", "Medium", "Low"].map((priority) => <option key={priority}>{priority}</option>)}</Select></Field>
      <Field label="Due date"><Input type="date" name="due" defaultValue={task?.dueDate} /></Field>
      <Field label="Estimate (minutes)"><Input type="number" name="estimate" min={0} max={1440} required defaultValue={task?.estimate ?? 25} /></Field>
      <Field label="Repeats"><Select name="recurrence" defaultValue={presetForRecurrence(task?.recurrence)}>{recurrencePresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</Select></Field>
    </div>
    {task?.recurrence && <p className="text-xs text-muted-foreground">Completing this task moves it to its next date instead of closing it. {recurrenceLabel(task.recurrence)}.</p>}
    <Field label="Project"><Select name="project" defaultValue={task?.projectId || ""}><option value="">No project</option>{state.projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</Select></Field>
    <Field label="Tags (comma-separated)"><Input name="tags" defaultValue={task?.tags.join(", ")} /></Field>
    {error && <p role="alert" className="text-[13px] text-destructive">{error}</p>}
    <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onSaved}>Cancel</Button><Button type="submit">{task ? "Save task locally" : "Create task locally"}</Button></div>
  </form>;
}

export function NewTask({ status = "INBOX", label = "New task" }: { status?: TaskStatus; label?: string }) {
  const [open, setOpen] = useState(false);
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button><Plus aria-hidden className="size-4" />{label}</Button></DialogTrigger><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>New task</DialogTitle><DialogDescription>Create one canonical task in this browser preview. A board is not required.</DialogDescription></DialogHeader>{open && <TaskForm defaultStatus={status} onSaved={() => setOpen(false)} />}</DialogContent></Dialog>;
}

function Attachments({ task }: { task: Task }) {
  const { addAttachment, removeAttachment, notify } = useWorkspace();
  const attached = task.attachments || [];
  function accept(result: { kind: TaskAttachment["kind"]; label: string; value: string; size?: number }) {
    if (result.kind === "file" && !result.value) { notify(`${result.label}. Files are limited to 1 MB in this preview.`); return; }
    addAttachment(task.id, { kind: result.kind, label: result.label, value: result.value, size: result.size });
  }
  return <div className="mt-6 space-y-3"><h3 className="text-[13px] font-medium">Attachments</h3>
    {attached.length ? attached.map((item) => <ImportedFileState key={item.id} name={item.label} size={item.size} value={item.value} onRemove={() => removeAttachment(task.id, item.id)} />) : <Empty title="No attachments" description="Nothing is uploaded in this preview." />}
    <ImportDrop onImport={accept} hint="Drop a file here, or paste a URL or some text. Files stay in this browser at up to 1 MB." accept={undefined} />
  </div>;
}

function InspectorContent({ task, close }: { task: Task; close: () => void }) {
  const { state } = useWorkspace();
  const notes = state.artifacts.filter((artifact) => artifact.kind === "note" && artifact.links.includes(task.id));
  return <><TaskForm task={task} onSaved={close} /><Attachments task={task} /><div className="mt-6 space-y-3"><h3 className="text-[13px] font-medium">Linked canonical notes</h3>{notes.length ? notes.map((note) => <Link key={note.id} href={`/apps/neuralflow/notes?note=${note.id}`} className="block text-[13px] underline underline-offset-4">{note.title}</Link>) : <Empty title="No linked notes" description="Opening this inspector does not create an empty note." />}<Button variant="outline" asChild><Link href={`/neuralflow/work?view=saved&task=${encodeURIComponent(task.id)}`}><Timer aria-hidden className="size-4" />Focus on this task</Link></Button><Unavailable feature="Task AI assistance">Enrichment, breakdown, and summaries require a supervised run. No generated content or task updates are simulated.</Unavailable></div></>;
}

function TaskSheet({ task, open, onOpenChange, trigger, onCloseAutoFocus }: { task: Task; open: boolean; onOpenChange: (open: boolean) => void; trigger?: ReactNode; onCloseAutoFocus?: (event: Event) => void }) {
  return <Sheet open={open} onOpenChange={onOpenChange}>{trigger && <SheetTrigger asChild>{trigger}</SheetTrigger>}<SheetContent className="w-full overflow-y-auto p-4 sm:max-w-lg" onCloseAutoFocus={onCloseAutoFocus}><SheetHeader className="px-0 pr-8"><SheetTitle>Task inspector</SheetTitle><SheetDescription>Canonical task, revision {task.version}. Changes stay in this browser.</SheetDescription></SheetHeader>{open && <InspectorContent task={task} close={() => onOpenChange(false)} />}</SheetContent></Sheet>;
}

export function TaskInspector({ task, children }: { task: Task; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <TaskSheet task={task} open={open} onOpenChange={setOpen} trigger={children} />;
}

/*
 * A `?task=` deep link opens the inspector with no visible trigger. Closing it
 * removes only `task` from the URL, so a refresh does not reopen it and other
 * parameters such as `view` survive. Focus returns to the task's row when it
 * is listed, otherwise to the workspace search that most deep links come from.
 */
export function SelectedTask({ id }: { id: string }) {
  const { state } = useWorkspace();
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const task = state.tasks.find((item) => item.id === id);
  function clearLink() {
    const url = new URL(window.location.href);
    url.searchParams.delete("task");
    router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false });
  }
  function returnFocus(event: Event) {
    event.preventDefault();
    const row = [...document.querySelectorAll<HTMLElement>("[data-task-trigger]")].find((element) => element.dataset.taskTrigger === id);
    (row ?? document.querySelector<HTMLElement>('button[aria-label="Search workspace"]'))?.focus();
  }
  if (!task) return <Empty title="Task not found in this preview" description="This link may refer to a record from another browser or a reset workspace." action={<Button variant="outline" size="sm" onClick={clearLink}>Clear task link</Button>} />;
  return <TaskSheet task={task} open={open} onOpenChange={(next) => { setOpen(next); if (!next) clearLink(); }} onCloseAutoFocus={returnFocus} />;
}

export function TaskRow({ task }: { task: Task }) {
  const { state, updateTask, completeTask, notify } = useWorkspace();
  const project = state.projects.find((item) => item.id === task.projectId);
  const done = task.status === "DONE";
  function toggleDone() {
    if (task.status === "DONE") { const reopened = updateTask(task.id, { status: "READY", completedAt: undefined }); if (!reopened.ok || !reopened.persisted) return; notify("Task reopened locally."); return; }
    const completed = completeTask(task.id); if (!completed.ok || !completed.persisted) return;
    notify(task.recurrence ? "Task completed locally and moved to its next date." : "Task marked done locally. Reopen with its checkbox; task completion does not grant focus rewards.");
  }
  return <div className={`nf-row grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 border-b border-border py-2.5 last:border-0 sm:grid-cols-[1.5rem_minmax(0,1fr)_auto]`} data-done={done} data-motion={state.preferences.reducedMotion ? "reduce" : "full"}>
    <label className="flex size-6 items-center justify-center"><input type="checkbox" checked={done} onChange={toggleDone} aria-label={`${done ? "Reopen" : "Complete"} ${task.title}`} className={`nf-check size-4 accent-primary`} /></label>
    <div className="min-w-0"><TaskInspector task={task}><button type="button" data-task-trigger={task.id} className={`min-h-6 text-left text-[13px] font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring ${done ? "text-muted-foreground" : ""}`}><span className="nf-title">{task.title}</span></button></TaskInspector><div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><Status>{statusLabels[task.status]}</Status><span>{task.priority} priority</span>{project && <span>{project.title}</span>}{task.recurrence && <span>{recurrenceLabel(task.recurrence)}</span>}{task.attachments?.length ? <span>{task.attachments.length} attached</span> : null}{task.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div></div>
    <div className="col-start-2 mt-1 flex items-center gap-3 text-xs text-muted-foreground sm:col-start-3 sm:mt-0 sm:min-h-6 sm:justify-end">{task.dueDate && <span>Due <span className="readout">{task.dueDate}</span></span>}<span className="readout">{task.estimate} min</span></div>
  </div>;
}
