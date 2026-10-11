"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Empty, Field, Panel, Screen, Stat, Status, Unavailable } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import type { CalendarEvent } from "@/components/workspace/types";
import { calendarDaySegments, eventEnd, hasConflict, localDate, minuteOfDay, proposeSchedule, shiftDate, validDate, type ScheduleProposal } from "./planning";
import { selectClass } from "./task-components";

export function EventDialog({ event, date, trigger = "Add work block", defaultType = "Focus", triggerClassName }: { event?: CalendarEvent; date: string; trigger?: string; defaultType?: CalendarEvent["type"]; triggerClassName?: string }) {
  const { state, addEvent, updateEvent, addArtifact, updateArtifact, notify } = useWorkspace();
  const linkedNote = state.artifacts.find((artifact) => artifact.id === event?.notesArtifactId);
  const [noteVersion, setNoteVersion] = useState(linkedNote?.version);
  const end = event ? eventEnd(event) : { date, time: "09:25" };
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [original, setOriginal] = useState<CalendarEvent | undefined>(event);
  function save(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const data = new FormData(formEvent.currentTarget);
    const title = String(data.get("title") || "").trim();
    const startValue = String(data.get("start")); const endValue = String(data.get("end"));
    const [blockDate, start] = startValue.split("T"); const [endDate] = endValue.split("T");
    const duration = (new Date(endValue).getTime() - new Date(startValue).getTime()) / 60000;
    if (!title || !validDate(blockDate) || !validDate(endDate) || !/^\d{2}:\d{2}$/.test(start || "") || !Number.isFinite(duration) || duration <= 0 || duration > 10080) { setError("Enter a title and valid start/end times. End must follow start by at most seven days."); return; }
    if (linkedNote?.version !== noteVersion) { setError("The linked event note changed. Close and reopen to load its latest revision."); return; }
    if (event?.provider === "google") { setError("Provider events cannot be changed from this preview."); return; }
    if (original && JSON.stringify(state.events.find((item) => item.id === original.id)) !== JSON.stringify(original)) { setError("This block changed while the form was open. Close and reopen it before saving."); return; }
    if (hasConflict(state.events, blockDate, start, duration, event?.id) && !data.get("overlap")) { setError("This overlaps another local preview block. Choose another time or explicitly allow overlap."); return; }
    const noteBody = String(data.get("notes") || "");
    const payload = { title, date: blockDate, start, endDate, duration, taskId: String(data.get("task") || "") || undefined, provider: "local" as const, type: String(data.get("type")) as CalendarEvent["type"], location: String(data.get("location") || ""), tags: String(data.get("tags") || "").split(",").map((tag) => tag.trim()).filter(Boolean) };
    const record = event || addEvent(payload);
    let notesArtifactId = event?.notesArtifactId;
    if (linkedNote) updateArtifact(linkedNote.id, { body: noteBody });
    else if (noteBody.trim() || payload.type === "Meeting") {
      const note = addArtifact(`${title}: notes`, "note", noteBody);
      if (note) { notesArtifactId = note.id; updateArtifact(note.id, { links: [record.id], tags: payload.type === "Meeting" ? ["Meeting notes"] : ["Event notes"] }); }
    }
    updateEvent(record.id, { ...payload, notesArtifactId, notes: undefined });
    setOpen(false); notify("Work block and linked canonical notes saved locally. No provider event was created or changed.");
  }
  return <Dialog open={open} onOpenChange={(value) => { setOpen(value); if (value) { setOriginal(event); setNoteVersion(linkedNote?.version); setError(""); } }}><DialogTrigger asChild><Button variant="outline" className={triggerClassName} size={event ? "sm" : "default"}>{trigger}</Button></DialogTrigger><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>{event ? "Work block details" : "Create a local work block"}</DialogTitle><DialogDescription>{event?.provider === "google" ? "Read-only provider event. Changes require a connected account and exact-payload review." : "Browser-local planning only. This does not reserve time on a provider calendar."}</DialogDescription></DialogHeader>{open && <form onSubmit={save} className="space-y-4"><fieldset disabled={event?.provider === "google"} className="space-y-4 disabled:opacity-70"><Field label="Block title"><Input name="title" defaultValue={event?.title} required /></Field><Field label="Block type"><select name="type" className={selectClass} defaultValue={event?.type || defaultType}>{["Focus", "Meeting", "Personal", "Break"].map((type) => <option key={type}>{type}</option>)}</select></Field><Field label="Starts (browser local)"><Input type="datetime-local" name="start" defaultValue={`${event?.date || date}T${event?.start || "09:00"}`} required /></Field><Field label="Ends (browser local)"><Input type="datetime-local" name="end" defaultValue={`${end.date}T${end.time}`} required /></Field><Field label="Location"><Input name="location" defaultValue={event?.location} /></Field><Field label="Tags (comma-separated)"><Input name="tags" defaultValue={event?.tags?.join(", ")} /></Field><Field label="Canonical event notes"><Textarea name="notes" rows={5} defaultValue={linkedNote?.body || event?.notes || ""} /></Field><Field label="Linked task"><select name="task" className={selectClass} defaultValue={event?.taskId || ""}><option value="">No linked task</option>{state.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></Field><label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="overlap" className="size-4" />Allow overlap with another local block</label></fieldset>{error && <p role="alert" className="text-[13px] text-destructive">{error}</p>}<div className="flex justify-end gap-2"><Button variant="outline" type="button" onClick={() => setOpen(false)}>Close</Button>{event?.provider !== "google" && <Button type="submit">Save block locally</Button>}</div></form>}</DialogContent></Dialog>;
}

function AgendaEvent({ event, compact }: { event: CalendarEvent; compact: boolean }) {
  const { state } = useWorkspace();
  const task = state.tasks.find((item) => item.id === event.taskId);
  const end = eventEnd(event);
  return <li className="panel rounded-lg p-3"><div className="readout text-xs text-muted-foreground">{end.date !== event.date ? `${event.date} ` : ""}{event.start}–{end.date !== event.date ? `${end.date} ` : ""}{end.time}</div><p className="mt-1 text-[13px] font-medium">{event.title}</p><div className="mt-2"><Status>{event.provider === "local" ? "Local work block" : "Provider event"}</Status></div>{!compact && <><p className="mt-2 text-xs text-muted-foreground">{event.type || "Focus"}; {event.duration} minutes{event.location ? `; ${event.location}` : ""}</p>{event.tags?.length ? <p className="mt-1 text-xs text-muted-foreground">{event.tags.join(", ")}</p> : null}{event.notesArtifactId && <Link href={`/apps/neuralflow/notes?note=${event.notesArtifactId}`} className="mt-2 block text-xs underline">Open canonical event notes</Link>}{task && <Link href={`/apps/neuralflow/tasks?task=${task.id}`} className="mt-2 block text-xs underline">Task: {task.title}</Link>}<div className="mt-3"><EventDialog date={event.date} event={event} trigger={event.provider === "local" ? "Edit block" : "Inspect event"} /></div></>}</li>;
}

function CalendarTimeGrid({ days, events }: { days: string[]; events: CalendarEvent[] }) {
  return <Panel title="Weekly time grid" description="Overnight blocks are split across days; overlaps have separate lanes. Use Add block or an event button to edit exact times. An accessible agenda view is available above."><div className="max-h-[42rem] overflow-auto rounded-lg border border-border"><div className="grid min-w-[1120px] grid-cols-[56px_repeat(7,minmax(140px,1fr))]"><div className="sticky top-0 z-20 border-b border-border bg-card p-2 text-xs">Local</div>{days.map((day) => <div key={day} className="sticky top-0 z-20 border-b border-l border-border bg-card p-2 text-xs"><p className="font-medium">{new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" })}</p><p className="readout mb-2 text-muted-foreground">{day}</p><EventDialog date={day} trigger="Add block" /></div>)}<div className="relative h-[960px]">{Array.from({ length: 24 }, (_, hour) => <div key={hour} className="readout h-10 border-t border-border px-1 text-[11px] text-muted-foreground">{String(hour).padStart(2, "0")}:00</div>)}</div>{days.map((day) => <div key={day} className="relative h-[960px] border-l border-border">{Array.from({ length: 24 }, (_, hour) => <div key={hour} className="pointer-events-none h-10 border-t border-border" />)}{calendarDaySegments(events, day).map((segment) => <div key={segment.event.id} className="absolute p-0.5" style={{ top: segment.from / 1.5, height: Math.max(28, (segment.to - segment.from) / 1.5), left: `${segment.lane / segment.laneCount * 100}%`, width: `${100 / segment.laneCount}%` }}><EventDialog event={segment.event} date={day} trigger={`${segment.event.start} ${segment.event.title}; ${segment.event.type || "Focus"}; ${segment.event.provider === "local" ? "local" : "provider"}`} triggerClassName="h-full w-full justify-start overflow-hidden whitespace-normal bg-card px-1 text-left text-xs" /></div>)}</div>)}</div></div>{!events.length && <p className="mt-3 text-xs text-muted-foreground">No matching local records. Provider availability remains unknown.</p>}</Panel>;
}

export function CalendarScreen({ initialDate }: { initialDate?: string }) {
  const { state } = useWorkspace();
  const [date, setDate] = useState(validDate(initialDate) ? initialDate : localDate());
  const [mode, setMode] = useState("week");
  const [provider, setProvider] = useState("all");
  const [compact, setCompact] = useState(false);
  const [types, setTypes] = useState<string[]>(["Focus", "Meeting", "Personal", "Break"]);
  const dayIndex = new Date(`${date}T12:00:00`).getDay();
  const start = shiftDate(date, -(state.preferences.weekStart === "Monday" ? (dayIndex + 6) % 7 : dayIndex));
  const days = mode === "day" ? [date] : Array.from({ length: 7 }, (_, index) => shiftDate(start, index));
  const visible = state.events.filter((event) => event.date <= days[days.length - 1] && eventEnd(event).date >= days[0] && (provider === "all" || event.provider === provider) && types.includes(event.type || "Focus")).sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  return <Screen title="Calendar" description="Review local work blocks separately from provider events. Times use the browser's local clock; no external calendar synchronization or free/busy is available." actions={<EventDialog date={date} />}>
    <Unavailable feature="Google Calendar">Provider events, attendees, recurrence, and calendar writes need a connected account. The empty provider filter is a configuration state, not evidence of availability.</Unavailable>
    <Panel title={mode === "day" ? date : `${start} to ${shiftDate(start, 6)}`}><div className="flex flex-wrap items-end gap-3"><Button variant="outline" onClick={() => setDate(shiftDate(date, mode === "day" ? -1 : -7))}>Previous {mode === "day" ? "day" : "week"}</Button><Button variant="outline" onClick={() => setDate(localDate())}>Today</Button><Button variant="outline" onClick={() => setDate(shiftDate(date, mode === "day" ? 1 : 7))}>Next {mode === "day" ? "day" : "week"}</Button><Field label="Jump to date"><Input type="date" value={date} onChange={(event) => validDate(event.target.value) && setDate(event.target.value)} /></Field><Field label="View"><select className={selectClass} value={mode} onChange={(event) => setMode(event.target.value)}><option value="week">Week agenda</option><option value="timeline">Weekly time grid</option><option value="day">Day</option><option value="agenda">Agenda list</option></select></Field><Field label="Calendar source"><select className={selectClass} value={provider} onChange={(event) => setProvider(event.target.value)}><option value="all">All records</option><option value="local">Local work blocks</option><option value="google">Provider events</option></select></Field><Button variant="outline" aria-pressed={compact} onClick={() => setCompact(!compact)}>{compact ? "Show details" : "Compact"}</Button></div><fieldset className="mt-4 flex flex-wrap gap-4"><legend className="mb-2 text-xs text-muted-foreground">Block types (deselecting all shows none)</legend>{["Focus", "Meeting", "Personal", "Break"].map((type) => <label key={type} className="flex items-center gap-2 text-xs"><input type="checkbox" className="size-4" checked={types.includes(type)} onChange={(event) => setTypes(event.target.checked ? [...types, type] : types.filter((value) => value !== type))} />{type} ({state.events.filter((event) => days.includes(event.date) && (event.type || "Focus") === type).length})</label>)}</fieldset></Panel>
    {provider === "google" && !visible.length ? <Empty title="No provider events loaded" description="Google Calendar is not connected. Local work blocks are deliberately excluded by this filter." /> : mode === "timeline" ? <CalendarTimeGrid days={days} events={visible} /> : mode === "agenda" ? <Panel title="Weekly agenda">{visible.length ? <ul className="grid gap-3 md:grid-cols-2">{visible.map((event) => <li key={event.id}><p className="mb-2 text-xs text-muted-foreground">{event.date}</p><ul><AgendaEvent event={event} compact={compact} /></ul></li>)}</ul> : <Empty title="No local blocks this week" description="Create a work block or review proposals in Scheduler. Your external availability remains unknown." />}</Panel> : <div className={`grid gap-3 ${mode === "week" ? "md:grid-cols-2 xl:grid-cols-4" : ""}`}>{days.map((day) => <Panel key={day} title={new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "long" })} description={day} actions={<EventDialog date={day} trigger="Add block" />}><ul className="space-y-3">{visible.filter((event) => event.date <= day && eventEnd(event).date >= day).map((event) => <AgendaEvent key={event.id} event={event} compact={compact} />)}</ul>{!visible.some((event) => event.date <= day && eventEnd(event).date >= day) && <p className="text-xs text-muted-foreground">No local records. Provider availability unknown.</p>}</Panel>)}</div>}
    <p className="text-xs text-muted-foreground">Drag-to-create, recurrence, attendee invitations, and work-block deletion are not supported in this preview. Use the explicit keyboard-accessible block form to create or move a block; no unsupported delete action is shown.</p>
  </Screen>;
}

export function SchedulerScreen() {
  const { state, addEvent, notify } = useWorkspace();
  const [proposals, setProposals] = useState<ScheduleProposal[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [windowStart, setWindowStart] = useState("09:00");
  const [windowEnd, setWindowEnd] = useState("17:00");
  const [date, setDate] = useState(localDate);
  const [error, setError] = useState("");
  function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validDate(date) || minuteOfDay(windowStart) >= minuteOfDay(windowEnd)) { setError("Choose a valid date and a work window whose end follows its start."); return; }
    const results = proposeSchedule(state.tasks, state.events, date, windowStart, windowEnd);
    setProposals(results); setSelected(results.map((proposal) => proposal.taskId)); setError("");
  }
  function accept() {
    const chosen = (proposals || []).filter((proposal) => selected.includes(proposal.taskId));
    if (!chosen.length) return;
    for (const proposal of chosen) {
      const task = state.tasks.find((item) => item.id === proposal.taskId);
      if (task?.version !== proposal.taskVersion || !["READY", "IN_PROGRESS"].includes(task.status) || hasConflict(state.events, proposal.date, proposal.start, proposal.duration) || state.events.some((event) => event.taskId === proposal.taskId && event.date === proposal.date)) { setError("A task or local calendar block changed after this proposal was prepared. Refresh proposals before accepting; no blocks were added."); return; }
    }
    chosen.forEach((proposal) => addEvent({ title: proposal.title, taskId: proposal.taskId, date: proposal.date, start: proposal.start, duration: proposal.duration, provider: "local" }));
    setProposals((proposals || []).filter((proposal) => !selected.includes(proposal.taskId))); setSelected([]); setError(""); notify(`${chosen.length} reviewed work blocks added to this browser only. No provider writes were performed.`);
  }
  return <Screen title="Scheduler" description="Prepare, inspect, and deliberately accept a small local schedule. Deterministic rules—not AI—use priority, estimates, and the blocks already in this preview." actions={<Button variant="outline" asChild><Link href="/apps/neuralflow/calendar">Open calendar</Link></Button>}>
    <Unavailable feature="Provider free/busy and external scheduling">Suggestions only avoid local preview blocks. They do not check meetings from a real account. Accepting below creates local blocks, not approved or successful provider events.</Unavailable>
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"><Panel title="Planning window" description="Only Ready and In progress tasks are eligible. At most five proposals are prepared."><form onSubmit={generate} className="space-y-4"><Field label="Planning date"><Input type="date" value={date} required onChange={(event) => setDate(event.target.value)} /></Field><Field label="Work starts (browser local)"><Input type="time" value={windowStart} required onChange={(event) => setWindowStart(event.target.value)} /></Field><Field label="Work ends (browser local)"><Input type="time" value={windowEnd} required onChange={(event) => setWindowEnd(event.target.value)} /></Field><Button type="submit">{proposals ? "Refresh local proposals" : "Prepare local proposals"}</Button></form></Panel><Panel title="Review proposed blocks" description="Each proposal retains its task revision. Acceptance checks it again and refuses stale or conflicting plans.">
      {proposals === null ? <Empty title="No plan prepared" description="Choose a planning window and prepare proposals. Nothing is scheduled merely by viewing this screen." /> : !proposals.length ? <Empty title="No remaining proposals" description="Eligible tasks may already have blocks, may not fit the window, or may have been accepted or dismissed. Adjust the window and refresh." /> : <><div className="mb-4 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => setSelected(proposals.map((proposal) => proposal.taskId))}>Select all</Button><Button size="sm" variant="outline" onClick={() => setSelected([])}>Select none</Button></div><ul className="space-y-3">{proposals.map((proposal) => <li key={proposal.taskId} className="panel rounded-lg p-4"><label className="flex gap-3 text-[13px]"><input type="checkbox" className="mt-1 size-4" checked={selected.includes(proposal.taskId)} onChange={(event) => setSelected(event.target.checked ? [...selected, proposal.taskId] : selected.filter((id) => id !== proposal.taskId))} /><span><span className="font-medium">{proposal.title}</span><span className="readout mt-1 block text-xs">{proposal.date} {proposal.start}; {proposal.duration} min; task revision {proposal.taskVersion}</span></span></label><p className="mt-3 text-xs leading-relaxed text-muted-foreground">{proposal.reason}</p><Button className="mt-3" size="sm" variant="ghost" onClick={() => { setProposals(proposals.filter((item) => item.taskId !== proposal.taskId)); setSelected(selected.filter((id) => id !== proposal.taskId)); }}>Dismiss proposal</Button></li>)}</ul><div className="mt-4 flex flex-wrap gap-3"><Button disabled={!selected.length} onClick={accept}>Accept {selected.length} local blocks</Button><Button variant="outline" onClick={() => { setProposals([]); setSelected([]); }}>Reject all</Button></div></>}
    </Panel></div>{error && <p role="alert" className="text-[13px] text-destructive">{error}</p>}<Stat label="Existing local blocks" value={state.events.filter((event) => event.provider === "local").length} hint="No external account is included in this count" />
  </Screen>;
}
