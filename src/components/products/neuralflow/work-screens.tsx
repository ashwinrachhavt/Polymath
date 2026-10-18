"use client";

import Link from "next/link";
import { useState, useSyncExternalStore, type FormEvent } from "react";
import { createBoardViewStore, defaultBoardViews } from "./board-views";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Empty, Field, Panel, Screen, SearchField, Stat, Status, Unavailable } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import type { Task, TaskStatus } from "@/components/workspace/types";
import { countLabel, localDate, statusLabels, taskStatuses } from "./planning";
import { NewTask, SelectedTask, selectClass, TaskInspector, TaskRow } from "./task-components";
import { ReorderList } from "@/components/workspace/reorder";
import { compareTasks } from "@/components/workspace/tasks";
import { isTodayWork } from "./work-views";

export function Dashboard() {
  const { state } = useWorkspace();
  const [day, setDay] = useState(localDate);
  const active = state.tasks.filter((task) => task.status !== "DONE");
  const priorities = { High: 0, Medium: 1, Low: 2 };
  const queue = [...active].filter((task) => ["READY", "IN_PROGRESS"].includes(task.status)).sort((a, b) => priorities[a.priority] - priorities[b.priority] || (a.dueDate || "9999").localeCompare(b.dueDate || "9999"));
  const agenda = state.events.filter((event) => event.date === day).sort((a, b) => a.start.localeCompare(b.start));
  return <Screen title="Today's flow" description="Choose the next commitment, protect its time, and leave a useful reflection. These are fictional sample records and browser-local changes, not a connected daily briefing." actions={<><Button variant="outline" asChild><Link href="/apps/neuralflow/boards">Open board</Link></Button><NewTask /></>}>
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4"><Stat label="Ready to work" value={queue.length} hint="Ready and in-progress canonical tasks" /><Stat label="Waiting commitments" value={active.filter((task) => task.status === "WAITING").length} /><Stat label="Completed tasks" value={state.tasks.filter((task) => task.status === "DONE").length} hint="Current state, not today's completion history" /><Stat label="Focus stones earned" value={state.rewards.length} hint="Local preview reward ledger" /></div>
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]"><Panel title="Choose your next task" description="Highest priority first, then earliest due date. No AI ranking or silent status changes." actions={<Button variant="ghost" asChild><Link href="/apps/neuralflow/tasks">All tasks</Link></Button>}>
      {queue.length ? queue.slice(0, 5).map((task) => <TaskRow key={task.id} task={task} />) : <Empty title="No ready tasks" description="Clarify an inbox task and move it to Ready to build a deliberate queue." action={<NewTask status="READY" />} />}
      <div className="mt-4 flex gap-2"><Button asChild><Link href="/apps/neuralflow/focus">Start focus</Link></Button><Button variant="outline" asChild><Link href="/apps/neuralflow/brain-dump">Clarify a brain dump</Link></Button></div>
    </Panel><div className="space-y-6"><Panel title="Local agenda" actions={<Input aria-label="Agenda date" type="date" className="w-40" value={day} required onChange={(event) => event.target.value && setDay(event.target.value)} />}>
      {agenda.length ? <ul className="space-y-3">{agenda.map((event) => <li key={event.id} className="flex gap-3 text-[13px]"><span className="readout text-muted-foreground">{event.start}</span><div><Link href={`/apps/neuralflow/calendar?date=${day}`} className="hover:underline">{event.title}</Link><p className="mt-1 text-xs text-muted-foreground">{event.duration} min; {event.provider === "local" ? "local work block" : "provider event"}</p></div></li>)}</ul> : <Empty title="No local blocks on this date" description="This is not proof that your provider calendar is free. Review local block proposals in Scheduler." action={<Button variant="outline" asChild><Link href="/apps/neuralflow/scheduler">Plan a window</Link></Button>} />}
    </Panel><Panel title="Continue your reflection"><p className="mb-3 text-[13px] text-muted-foreground">Notes belong to the shared workspace and remain visible in Alfred.</p>{state.artifacts.filter((artifact) => artifact.kind === "note").slice(0, 3).map((note) => <Link key={note.id} href={`/apps/neuralflow/notes?note=${note.id}`} className="block py-2 text-[13px] hover:underline">{note.title}</Link>)}</Panel></div></div>
    <Unavailable feature="Calendar availability and AI planning">No calendar provider is connected. Local blocks cannot establish real free/busy. Scheduler creates reviewable local suggestions; Brain dump splits your own lines rather than calling AI.</Unavailable>
  </Screen>;
}

export function TasksScreen({ selectedTask, title = "Tasks", view = "list" }: { selectedTask?: string; title?: string; view?: "today" | "list" }) {
  const { state, addTask, updateTask, notify } = useWorkspace();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("active");
  const [priority, setPriority] = useState("all");
  const [project, setProject] = useState("all");
  const [sort, setSort] = useState("priority");
  const [selected, setSelected] = useState<string[]>([]);
  const [undo, setUndo] = useState<{ id: string; status: TaskStatus; version: number }[]>([]);
  const priorities = { High: 0, Medium: 1, Low: 2 };
  const queue = view === "today" ? state.tasks.filter(isTodayWork) : state.tasks;
  const visible = queue.filter((task) => `${task.title} ${task.description} ${task.tags.join(" ")}`.toLowerCase().includes(search.toLowerCase()) && (status === "all" || (status === "active" ? task.status !== "DONE" : task.status === status)) && (priority === "all" || task.priority === priority) && (project === "all" || task.projectId === project));
  visible.sort((a, b) => sort === "title" ? a.title.localeCompare(b.title) : sort === "estimate" ? a.estimate - b.estimate : sort === "due" ? (a.dueDate || "9999").localeCompare(b.dueDate || "9999") : sort === "manual" ? compareTasks(a, b) : priorities[a.priority] - priorities[b.priority]);
  function quickAdd(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const title = String(new FormData(event.currentTarget).get("title") || ""); if (addTask(title)) { event.currentTarget.reset(); notify("Task captured in Inbox locally. Choose List to clarify it; capture does not add it to Today."); } }
  function bulkDone() {
    const changed = state.tasks.filter((task) => selected.includes(task.id) && task.status !== "DONE");
    setUndo(changed.map((task) => ({ id: task.id, status: task.status, version: task.version + 1 })));
    changed.forEach((task) => updateTask(task.id, { status: "DONE" })); setSelected([]); notify(`${countLabel(changed.length, "task")} marked done locally.`);
  }
  function undoBulk() {
    const safe = undo.filter((previous) => state.tasks.find((task) => task.id === previous.id)?.version === previous.version);
    safe.forEach((previous) => updateTask(previous.id, { status: previous.status })); setUndo([]); notify(`${countLabel(safe.length, "task")} restored. Tasks edited since the bulk change were not overwritten.`);
  }
  return <Screen title={title} description={view === "today" ? "Today shows Ready and In progress work, not every captured thought. Move a task to Ready when you choose to work on it. This is a browser-only preview, not a connected daily plan." : "One task list, with details a click away. Capture into Inbox, then choose its status, priority, dates, and project. Changes stay in this browser preview."} actions={<NewTask />}>
    {selectedTask && <SelectedTask key={selectedTask} id={selectedTask} />}
    <form onSubmit={quickAdd} className="flex flex-wrap items-end gap-2"><div className="min-w-0 flex-1 basis-60"><Field label="Quick capture"><Input aria-label="Quick task title" name="title" placeholder="What needs your attention?" required maxLength={300} onKeyDown={(event) => { if (event.key === "Escape") event.currentTarget.value = ""; }} /></Field></div><Button type="submit">Capture task</Button><p className="w-full text-xs text-muted-foreground">New captures go to Inbox, not automatically into Today.{view === "today" && <> Find them in <Link href="/neuralflow/work?view=list" className="underline underline-offset-4">List</Link> and move chosen work to Ready.</>}</p></form>
    <Panel title={view === "today" ? "Today's work" : "Task queue"} description={countLabel(visible.length, "matching task")}><div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><SearchField value={search} onChange={setSearch} placeholder="Search tasks and tags" /><Field label="Status"><select className={selectClass} value={status} onChange={(event) => setStatus(event.target.value)}><option value="active">Active tasks</option><option value="all">All statuses</option>{taskStatuses.map((value) => <option key={value} value={value}>{statusLabels[value]}</option>)}</select></Field><Field label="Priority"><select className={selectClass} value={priority} onChange={(event) => setPriority(event.target.value)}><option value="all">All priorities</option>{["High", "Medium", "Low"].map((value) => <option key={value}>{value}</option>)}</select></Field><Field label="Project"><select className={selectClass} value={project} onChange={(event) => setProject(event.target.value)}><option value="all">All projects</option>{state.projects.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></Field><Field label="Sort"><select className={selectClass} value={sort} onChange={(event) => setSort(event.target.value)}><option value="priority">Priority</option><option value="due">Due date</option><option value="estimate">Estimate</option><option value="title">Title</option><option value="manual">Manual order</option></select></Field></div>
      <div className="mb-3 flex flex-wrap items-center gap-3"><label className="flex items-center gap-2 text-xs"><input type="checkbox" className="size-4" checked={visible.length > 0 && visible.every((task) => selected.includes(task.id))} onChange={(event) => setSelected(event.target.checked ? visible.map((task) => task.id) : [])} />Select visible tasks</label><Button size="sm" variant="outline" disabled={!selected.length} onClick={bulkDone}>Complete selected ({selected.length})</Button>{undo.length > 0 && <Button size="sm" variant="outline" onClick={undoBulk}>Undo bulk completion</Button>}</div>
      {visible.length ? visible.map((task) => <div className="flex items-start gap-2 border-b border-border last:border-b-0" key={task.id}><label className="mt-2.5 flex size-6 shrink-0 items-center justify-center"><input type="checkbox" aria-label={`Select ${task.title}`} checked={selected.includes(task.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, task.id] : selected.filter((id) => id !== task.id))} className="size-4" /></label><div className="min-w-0 flex-1"><TaskRow task={task} /></div></div>) : <Empty title={view === "today" && !queue.length ? "No chosen work yet" : "No tasks match"} description={view === "today" ? "Today only includes Ready and In progress tasks. Clarify captured work in List and choose its status, or clear your filters." : "Change your filters or capture a task. This local preview does not query external task providers."} action={<div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => { setSearch(""); setStatus("all"); setPriority("all"); setProject("all"); }}>Clear filters</Button>{view === "today" && <Button variant="outline" asChild><Link href="/neuralflow/work?view=list">Choose work from List</Link></Button>}</div>} />}
    </Panel>
  </Screen>;
}

export function BoardsScreen({ title = "Boards" }: { title?: string }) {
  const { storageScope } = useWorkspace();
  return <ScopedBoardsScreen key={storageScope} storageScope={storageScope} title={title} />;
}

function ScopedBoardsScreen({ storageScope, title }: { storageScope: string; title: string }) {
  const { state, updateTask, reorderTask, notify } = useWorkspace();
  const [viewStore] = useState(() => createBoardViewStore(storageScope));
  const views = useSyncExternalStore(viewStore.subscribe, viewStore.getSnapshot, () => defaultBoardViews);
  const viewReadNotice = useSyncExternalStore(viewStore.subscribe, viewStore.getNotice, () => "");
  const [viewId, setViewId] = useState("all");
  const [search, setSearch] = useState("");
  const [showDone, setShowDone] = useState(true);
  const [open, setOpen] = useState(false);
  const view = views.find((item) => item.id === viewId) || defaultBoardViews[0];
  const tasks = state.tasks.filter((task) => (view.project === "all" || task.projectId === view.project) && `${task.title} ${task.tags.join(" ")}`.toLowerCase().includes(view.query.toLowerCase()) && task.title.toLowerCase().includes(search.toLowerCase()));
  function saveView(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const title = String(data.get("title") || "").trim(); if (!title) return;
    const record = { id: crypto.randomUUID(), title, project: String(data.get("project")), query: String(data.get("query") || "").trim() };
    viewStore.addView(record);
    if (viewStore.getNotice()) notify(viewStore.getNotice());
    setViewId(record.id); setOpen(false);
  }
  function move(task: Task, status: TaskStatus) { updateTask(task.id, { status }); notify(`${task.title} moved to ${statusLabels[status]} locally.`); }
  return <Screen title={title} description="Saved Kanban views select the same tasks as your list, calendar, and focus session. Drag a tile by its handle to rank it, drag across lanes to change status, or use Alt + Left / Right from the keyboard. There is no separate board-owned task model." actions={<><Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button variant="outline">Save a view</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>Save a board view</DialogTitle><DialogDescription>Stores filters in this browser only, not tasks or production board configuration.</DialogDescription></DialogHeader><form onSubmit={saveView} className="space-y-3"><Field label="View name"><Input name="title" required /></Field><Field label="Project"><select name="project" className={selectClass}><option value="all">All projects</option>{state.projects.map((project) => <option value={project.id} key={project.id}>{project.title}</option>)}</select></Field><Field label="Title or tag contains"><Input name="query" /></Field><Button type="submit">Save view locally</Button></form></DialogContent></Dialog><NewTask /></>}>
    {viewReadNotice && <p role="status" className="text-[13px] text-muted-foreground">{viewReadNotice}</p>}
    <div className="flex flex-wrap items-end gap-4"><Field label="Saved view"><select className={selectClass} value={viewId} onChange={(event) => setViewId(event.target.value)}>{views.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></Field><SearchField value={search} onChange={setSearch} placeholder="Search board tasks" /><Button variant="outline" onClick={() => setShowDone(!showDone)}>{showDone ? "Hide done" : "Show done"}</Button><Status>{countLabel(tasks.length, "task")} in view</Status></div>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{taskStatuses.filter((status) => showDone || status !== "DONE").map((status) => {
      const lane = tasks.filter((task) => task.status === status);
      return <Panel key={status} title={statusLabels[status]} description={`${countLabel(lane.length, "task")}${status === "IN_PROGRESS" && lane.length > 3 ? "; above the suggested WIP limit of 3" : ""}`} actions={<NewTask status={status} label={`Add ${statusLabels[status].toLowerCase()} task`} />}
>
        {lane.length ? <ReorderList items={lane} getId={(task) => task.id} onReorder={(id, index) => reorderTask(id, status, index)} label={`${statusLabels[status]} tasks`} className="space-y-3" itemClassName="panel rounded-lg p-3" renderItem={(task, handle) => <div className="flex items-start gap-2">{handle}<div className="min-w-0 flex-1"><TaskInspector task={task}><button type="button" className="w-full text-left text-[13px] hover:underline focus-visible:outline-2 focus-visible:outline-ring" onKeyDown={(event) => { if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); const next = taskStatuses[taskStatuses.indexOf(task.status) + (event.key === "ArrowRight" ? 1 : -1)]; if (next) move(task, next); }}>{task.title}</button></TaskInspector><div className="my-2 flex flex-wrap gap-2 text-xs text-muted-foreground"><span>{task.priority}</span><span className="readout">{task.estimate} min</span>{task.dueDate && <span>Due {task.dueDate}</span>}</div><select aria-label={`Move ${task.title} to status`} className={selectClass} value={task.status} onChange={(event) => move(task, event.target.value as TaskStatus)}>{taskStatuses.map((next) => <option value={next} key={next}>{statusLabels[next]}</option>)}</select></div></div>} /> : <Empty title="No tasks in this lane" description="Move a matching task here or capture a new one. Filtered-out tasks remain in the shared workspace." />}
      </Panel>;
    })}</div>
  </Screen>;
}
