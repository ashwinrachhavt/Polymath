"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Gem } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { Empty, Field, Panel, Screen, SearchField, Stat, Status, Unavailable } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import type { Task } from "@/components/workspace/types";
import { brainDumpLines, countLabel, eventEnd, localDate, shiftDate, validDate } from "./planning";
import { EventDialog } from "./calendar-screens";
import { NewNote, NoteInspector } from "./workspace-screens";
import { NewTask, TaskRow } from "./task-components";
import { BarChart, Meter } from "@/components/workspace/chart";
import { focusRecords, focusStreak, minutesByDay, shardLedger, stonesPerShard } from "@/components/workspace/rewards";
import { StoneArt } from "./stone-art";
import { stoneCollection, stoneReason } from "./stones";
import "./neuralflow-stones.css";

type DraftTask = { id: string; title: string; description: string; priority: Task["priority"]; estimate: number; projectId: string; selected: boolean };
export function BrainDumpScreen() {
  const { state, addTask, addCapture, updateCapture, addArtifact, updateArtifact, notify } = useWorkspace();
  const [text, setText] = useState(""); const [source, setSource] = useState(""); const [drafts, setDrafts] = useState<DraftTask[] | null>(null); const [error, setError] = useState("");
  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const lines = brainDumpLines(text);
    if (!lines.length) { setError("Write at least one line before preparing a local plan."); return; }
    setSource(text); setDrafts(lines.map((title) => ({ id: crypto.randomUUID(), title, description: "", priority: "Medium", estimate: 25, projectId: "", selected: true }))); setError("");
  }
  function update(id: string, patch: Partial<DraftTask>) { setDrafts((drafts || []).map((draft) => draft.id === id ? { ...draft, ...patch } : draft)); }
  function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (text !== source) { setError("The original text changed after this plan was prepared. Prepare it again before accepting."); return; }
    const chosen = (drafts || []).filter((draft) => draft.selected);
    if (!chosen.length || chosen.some((draft) => !draft.title.trim() || !Number.isFinite(draft.estimate) || draft.estimate < 0 || draft.estimate > 1440)) { setError("Select at least one task, with a nonempty title and an estimate from 0 to 1440 minutes."); return; }
    const capture = addCapture(source); if (!capture) return;
    const created = chosen.flatMap((draft) => { const record = addTask(draft.title, { status: "INBOX", description: draft.description, priority: draft.priority, estimate: draft.estimate, projectId: draft.projectId || undefined, tags: ["Brain dump"] }); return record ? [record] : []; });
    const provenance = addArtifact("Brain dump: accepted local plan", "note", `Original capture: ${capture.id}\n\n${source}\n\nPrepared by a deterministic newline splitter, not AI. Selected tasks were edited and accepted by the owner into Inbox.`);
    if (provenance) updateArtifact(provenance.id, { links: created.map((task) => task.id), tags: ["Planning", "Original capture"] });
    updateCapture(capture.id, { status: "TASK" });
    setDrafts((drafts || []).filter((draft) => !draft.selected)); setError(""); notify(`${created.length} canonical tasks captured locally. Original text retained in Inbox and a linked planning note. No AI ran.`);
  }
  const selected = (drafts || []).filter((draft) => draft.selected).length;
  return <Screen title="Brain dump" description="Get commitments out of your head, then review what becomes a task. This local planning tool splits your own lines; it does not infer, enrich, generate, or call AI.">
    <Unavailable feature="AI planning">For now, one nonempty line becomes one editable task proposal, repeated lines are removed, and the first 30 unique lines are used. Estimates default to 25 minutes; they are not model predictions.</Unavailable>
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]"><Panel title="Original capture" description="The text and proposals are unsaved drafts until acceptance."><form onSubmit={prepare} className="space-y-4"><Field label="What's on your mind?"><Textarea value={text} rows={14} required onChange={(event) => setText(event.target.value)} placeholder="One possible commitment per line" /></Field><div className="flex flex-wrap gap-2"><Button type="submit">Prepare local plan (not AI)</Button><Button type="button" variant="outline" onClick={() => { setText(""); setSource(""); setDrafts(null); setError(""); }}>Clear draft</Button></div></form></Panel><Panel title="Review task proposals" description="Nothing enters the shared task queue before you accept it.">{drafts === null ? <Empty title="No proposals yet" description="Write one commitment per line and prepare a local plan." /> : !drafts.length ? <Empty title="All proposals handled" description="Accepted tasks are now in the canonical Inbox state. Prepare another plan or open your task queue." action={<Button variant="outline" asChild><Link href="/apps/neuralflow/tasks">Open tasks</Link></Button>} /> : <form onSubmit={accept} className="space-y-4"><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" type="button" onClick={() => setDrafts(drafts.map((draft) => ({ ...draft, selected: true })))}>Select all</Button><Button variant="outline" size="sm" type="button" onClick={() => setDrafts(drafts.map((draft) => ({ ...draft, selected: false })))}>Select none</Button></div>{drafts.map((draft, index) => <Panel key={draft.id} title={`Proposal ${index + 1}`} actions={<label className="flex items-center gap-2 text-xs"><input type="checkbox" className="size-4" checked={draft.selected} onChange={(event) => update(draft.id, { selected: event.target.checked })} />Include</label>}><div className="space-y-3"><Field label="Task title"><Input value={draft.title} onChange={(event) => update(draft.id, { title: event.target.value })} /></Field><Field label="Description"><Textarea value={draft.description} rows={2} onChange={(event) => update(draft.id, { description: event.target.value })} /></Field><div className="grid grid-cols-2 gap-3"><Field label="Priority"><Select value={draft.priority} onChange={(event) => update(draft.id, { priority: event.target.value as Task["priority"] })}>{["High", "Medium", "Low"].map((value) => <option key={value}>{value}</option>)}</Select></Field><Field label="Estimate (minutes)"><Input type="number" min={0} max={1440} value={draft.estimate} onChange={(event) => update(draft.id, { estimate: Number(event.target.value) })} /></Field></div><Field label="Project"><Select value={draft.projectId} onChange={(event) => update(draft.id, { projectId: event.target.value })}><option value="">No project</option>{state.projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}</Select></Field><Button type="button" size="sm" variant="ghost" onClick={() => setDrafts(drafts.filter((item) => item.id !== draft.id))}>Reject this proposal</Button></div></Panel>)}<div className="flex flex-wrap gap-2"><Button type="submit" disabled={!selected}>Accept {countLabel(selected, "task")} locally</Button><Button variant="outline" type="button" onClick={() => setDrafts([])}>Reject all</Button></div></form>}</Panel></div>{error && <p role="alert" className="text-[13px] text-destructive">{error}</p>}
  </Screen>;
}

export function MeetingsScreen() {
  const { state } = useWorkspace(); const [search, setSearch] = useState(""); const [period, setPeriod] = useState("all");
  const today = localDate();
  const meetings = state.events.filter((event) => event.type === "Meeting").filter((event) => `${event.title} ${event.location || ""}`.toLowerCase().includes(search.toLowerCase()) && (period === "all" || (period === "upcoming" ? eventEnd(event).date >= today : eventEnd(event).date < today))).sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  return <Screen title="Meetings" description="A meeting is a canonical calendar event with linked notes and explicit action items. This browser preview does not invite attendees, record calls, or transcribe conversations." actions={<EventDialog date={today} trigger="New local meeting" defaultType="Meeting" />}>
    <Unavailable feature="Meeting providers and transcription">Create a local meeting or take your own notes. No participant invitations, calendar synchronization, audio capture, or AI action-item extraction will report success.</Unavailable>
    <div className="flex flex-wrap items-end gap-4"><SearchField value={search} onChange={setSearch} placeholder="Search meetings and locations" /><Field label="Period"><Select value={period} onChange={(event) => setPeriod(event.target.value)}><option value="all">All meetings</option><option value="upcoming">Upcoming and today</option><option value="past">Past</option></Select></Field></div>
    {meetings.length ? meetings.map((meeting) => {
      const notes = state.artifacts.filter((artifact) => artifact.kind === "note" && (artifact.id === meeting.notesArtifactId || artifact.links.includes(meeting.id)));
      const taskIds = new Set(notes.flatMap((note) => note.links));
      const actions = state.tasks.filter((task) => task.id === meeting.taskId || taskIds.has(task.id));
      const end = eventEnd(meeting);
      return <Panel key={meeting.id} title={meeting.title} description={`${meeting.date} ${meeting.start} to ${end.date} ${end.time}${meeting.location ? `; ${meeting.location}` : ""}`} actions={<EventDialog event={meeting} date={meeting.date} trigger={meeting.provider === "local" ? "Edit meeting" : "Inspect event"} />}><div className="mb-4 flex flex-wrap gap-2"><Status>{meeting.provider === "local" ? "Local meeting" : "Provider meeting"}</Status>{meeting.tags?.map((tag) => <Status key={tag}>{tag}</Status>)}</div><div className="grid gap-6 md:grid-cols-2"><div><h3 className="mb-3 text-[13px] font-medium">Canonical meeting notes</h3>{notes.map((note) => <div key={note.id} className="mb-3"><NoteInspector note={note} /><p className="mt-2 line-clamp-3 text-xs text-muted-foreground">{note.body || "Open to write your notes."}</p></div>)}<NewNote link={meeting.id} label="Add linked note" /></div><div><h3 className="mb-3 text-[13px] font-medium">Linked action items</h3>{actions.length ? actions.map((task) => <TaskRow key={task.id} task={task} />) : <p className="mb-3 text-xs text-muted-foreground">No action items linked. Create a task, then link it from a meeting note, or choose it in Edit meeting.</p>}<NewTask label="Create action task" /></div></div></Panel>;
    }) : <Empty title="No matching meetings" description="Create a local Meeting event. Ordinary focus blocks are not counted as meetings merely because they have no linked task." action={<EventDialog date={today} trigger="Create a local meeting" defaultType="Meeting" />} />}
  </Screen>;
}

import { ServerWeek } from "./server-week";
export function ReportsScreen() {
  const { state, addArtifact, updateArtifact, notify } = useWorkspace();
  const [end, setEnd] = useState(localDate); const [start, setStart] = useState(() => shiftDate(localDate(), -6)); const [project, setProject] = useState("all");
  const [reflection, setReflection] = useState(""); const [error, setError] = useState("");
  const tasks = state.tasks.filter((task) => project === "all" || task.projectId === project);
  const records = state.rewards.filter((reward) => {
    const date = localDate(new Date(reward.earnedAt));
    const taskId = reward.sessionId.split(":")[1];
    return date >= start && date <= end && reward.sessionId.startsWith("neuralflow-focus:") && (project === "all" || tasks.some((task) => task.id === taskId));
  });
  const minutes = focusRecords(records).reduce((sum, record) => sum + record.minutes, 0);
  const streak = focusStreak(state.rewards, localDate());
  const blocks = state.events.filter((event) => event.provider === "local" && event.date >= start && event.date <= end && (project === "all" || tasks.some((task) => task.id === event.taskId)));
  const summary = `Local reflection snapshot\nWindow: ${start} to ${end}\nScope: ${project === "all" ? "All projects" : state.projects.find((item) => item.id === project)?.title || "Project"}\n\nRecorded completed focus intervals: ${records.length}\nRecorded focus minutes: ${minutes}\nPlanned local blocks: ${blocks.length}\n\nCurrent task states (not completions during this window):\nActive: ${tasks.filter((task) => task.status !== "DONE").length}\nDone: ${tasks.filter((task) => task.status === "DONE").length}\nWaiting: ${tasks.filter((task) => task.status === "WAITING").length}\n\nOwner reflection\n${reflection || "Not entered."}\n\nBrowser-local preview data only. Task completion timestamps and production sessions are not available. No AI analysis ran.`;
  function changePeriod(days: number) { setStart(shiftDate(start, days)); setEnd(shiftDate(end, days)); }
  function saveSnapshot() {
    if (!validDate(start) || !validDate(end) || start > end) { setError("Choose valid dates with the end on or after the start."); return; }
    const note = addArtifact(`Work reflection: ${start} to ${end}`, "note", summary);
    if (!note) return;
    if (!updateArtifact(note.id, { tags: ["Weekly review", "Local snapshot"], links: project === "all" ? [] : [project] }).ok) return;
    notify("Report snapshot saved as a canonical local note. No AI analysis ran."); setError("");
  }
  function exportSnapshot() {
    if (!validDate(start) || !validDate(end) || start > end) { setError("Choose a valid reporting range before exporting."); return; }
    const url = URL.createObjectURL(new Blob([JSON.stringify({ scope: "Browser-local preview only", start, end, summary, focusRewards: records, plannedBlocks: blocks }, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `neuralflow-local-report-${start}.json`; anchor.click(); URL.revokeObjectURL(url);
  }
  return <Screen title="Reports" description="Reflect on evidence you actually recorded. Focus metrics use local completion rewards; task counts describe current state, not fabricated weekly completion history." actions={<><Button variant="outline" onClick={exportSnapshot}>Export local snapshot</Button><Button onClick={saveSnapshot}>Save snapshot as note</Button></>}>
    <ServerWeek />
    <Panel title="Reflection window"><div className="flex flex-wrap items-end gap-3"><Field label="From"><Input type="date" value={start} onChange={(event) => event.target.value && setStart(event.target.value)} /></Field><Field label="Through"><Input type="date" value={end} onChange={(event) => event.target.value && setEnd(event.target.value)} /></Field><Field label="Project"><Select value={project} onChange={(event) => setProject(event.target.value)}><option value="all">All projects</option>{state.projects.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</Select></Field><Button variant="outline" onClick={() => changePeriod(-7)}>Previous week</Button><Button variant="outline" onClick={() => { setStart(shiftDate(localDate(), -6)); setEnd(localDate()); }}>Last seven days</Button><Button variant="outline" onClick={() => changePeriod(7)}>Next week</Button></div></Panel>
    {start > end && <p role="alert" className="text-[13px] text-destructive">The reporting range is reversed. Select an end date on or after the start.</p>}
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-5"><Stat label="Recorded focus intervals" value={records.length} hint="Completed and explicitly recorded in this window" /><Stat label="Recorded focus minutes" value={minutes} hint="Actual completed interval durations, not task estimates" /><Stat label="Current streak" value={`${streak.current} ${streak.current === 1 ? "day" : "days"}`} hint={`Longest recorded run is ${streak.longest} ${streak.longest === 1 ? "day" : "days"}`} /><Stat label="Planned local blocks" value={blocks.length} hint="Plans do not establish work performed" /><Stat label="Current done tasks" value={tasks.filter((task) => task.status === "DONE").length} hint="Not a weekly completion count" /></div>
    <Panel title="Recorded focus per day" description="Every bar is a real ledger entry, repeated as a table below so the chart is not the only way to read it."><BarChart points={minutesByDay(state.rewards, start, end).map((entry) => ({ label: entry.day, value: entry.minutes, caption: String(entry.sessions) }))} unit="minutes" emptyLabel="No chart data for this range." /></Panel>
    <div className="grid gap-6 lg:grid-cols-2"><Panel title="Recorded focus evidence">{records.length ? <ul className="divide-y divide-border">{records.map((reward) => <li key={reward.id} className="py-3 text-[13px]"><p>{reward.title}</p><p className="readout mt-1 text-xs text-muted-foreground">{new Date(reward.earnedAt).toLocaleString()}</p><p className="mt-1 break-all text-xs text-muted-foreground">Session: {reward.sessionId}</p></li>)}</ul> : <Empty title="No recorded intervals in this window" description="Complete and record a focus session, or choose another period. An empty ledger is not a provider failure or a claim that no work happened." action={<Button variant="outline" asChild><Link href="/apps/neuralflow/focus">Open focus</Link></Button>} />}</Panel><Panel title="Owner reflection" description="Write your own observations, then save the report as a shared note."><Field label="What worked, what changed, and what will you try next?"><Textarea rows={12} value={reflection} onChange={(event) => setReflection(event.target.value)} /></Field><div className="mt-4 flex gap-2"><Button onClick={saveSnapshot}>Save snapshot as note</Button><Button variant="outline" asChild><Link href="/apps/neuralflow/notes">Open notes</Link></Button></div></Panel></div>
    <Unavailable feature="AI weekly analysis">Sentiment, SWOT, inferred deep-work totals, task completion trends, and automatic report notifications require reliable production history and a supervised run. Streaks and totals above are counted from the local ledger only; none of them are inferred from task estimates or current status.</Unavailable>{error && <p role="alert" className="text-[13px] text-destructive">{error}</p>}
  </Screen>;
}

export function RewardsScreen() {
  const { state, updatePreferences } = useWorkspace(); const [filter, setFilter] = useState<"all" | "earned">("all");
  const streak = focusStreak(state.rewards, localDate()); const shards = shardLedger(state.rewards);
  const visible = stoneCollection(state.rewards, filter);
  const motion = !state.preferences.reducedMotion;
  return <Screen title="Stone collection" description="Small, optional feedback for recorded focus. Inventory derives from the shared idempotent local reward ledger, not simulated awards or a shard-claim economy. Stone art comes from the original catalog.">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Stat label="Local stones earned" value={state.rewards.length} /><Stat label="Current streak" value={`${streak.current} ${streak.current === 1 ? "day" : "days"}`} hint={`Longest recorded run is ${streak.longest} ${streak.longest === 1 ? "day" : "days"}`} /><Stat label="Shards minted" value={shards.shards} hint={`${stonesPerShard} stones fuse into one shard`} /><Stat label="Reward rule" value="One per interval" hint="Completed focus only; no reward for breaks or early endings" /></div>
    <Panel title="Shard progress" description="Shards are bookkeeping over the same ledger, not a second currency you can spend or claim."><Meter value={shards.remainder} max={stonesPerShard} label={`Stones toward shard ${shards.shards + 1}`} /><p className="mt-3 text-xs text-muted-foreground">Next shard in {shards.toNextShard} recorded {shards.toNextShard === 1 ? "stone" : "stones"}. Nothing is auto-claimed and no shard has monetary value.</p></Panel>
    <Panel title="Collection controls"><div className="flex flex-wrap items-end gap-5"><Field label="Collection filter"><Select value={filter} onChange={(event) => setFilter(event.target.value === "earned" ? "earned" : "all")}><option value="all">All stone definitions</option><option value="earned">Earned only</option></Select></Field><label className="flex min-h-9 items-center gap-2 text-[13px]"><input type="checkbox" className="size-4" checked={state.preferences.celebrations} onChange={(event) => updatePreferences({ celebrations: event.target.checked })} />Allow optional celebrations</label><label className="flex min-h-9 items-center gap-2 text-[13px]"><input type="checkbox" className="size-4" checked={state.preferences.reducedMotion} onChange={(event) => updatePreferences({ reducedMotion: event.target.checked })} />Reduce motion</label></div><p className="mt-3 text-xs text-muted-foreground">Celebrations show a short stone reveal after you record a completed interval in Focus. Reduce motion keeps it still. Nothing blocks the screen, auto-claims, or awards XP.</p></Panel>
    {visible.length ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{visible.map((entry) => {
      const { stone, earned, title } = entry;
      const locked = !earned.length;
      const label = earned.length ? `Earned: ${earned.length}` : entry.earnable ? "Not yet earned" : "No earning rule yet";
      return <Dialog key={entry.key}><DialogTrigger asChild><button type="button" className={`panel nf-tile flex items-start gap-4 rounded-xl p-4 text-left hover:bg-muted/40`}>{stone ? <StoneArt stone={stone} size={64} locked={locked} sheen={!locked && motion} /> : <Gem aria-hidden className="size-16 shrink-0 p-3 text-muted-foreground" />}<span className="flex min-w-0 flex-col items-start gap-1.5"><span className="text-[13px] font-medium">{title}</span>{stone && <span className="text-xs text-muted-foreground">{stone.name}; {stone.rarity.toLowerCase()}</span>}<Status>{label}</Status><span className="text-xs leading-relaxed text-muted-foreground">{earned.length ? `Latest: ${stoneReason(earned[earned.length - 1], state.tasks)}` : stone ? stone.rule : "Inspect the actual local ledger entries for this stone."}</span></span></button></DialogTrigger><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{earned.length ? `${earned.length} actual browser-local ledger entries. A session can award only once.` : entry.earnable ? "Not unlocked. A completed focus session earns one clarity stone when its outcome is recorded." : "Part of the original stone catalog. Polymath has no earning rule for this stone yet, so it cannot be unlocked."}</DialogDescription></DialogHeader>{stone ? <div className="flex items-center gap-4"><StoneArt stone={stone} size={128} locked={locked} decorative={false} /><div className="text-xs leading-relaxed text-muted-foreground"><p className="text-[13px] font-medium text-foreground">{stone.name}</p><p className="mt-1">{stone.theme}</p><p className="mt-1">{stone.rarity}</p></div></div> : <Gem aria-hidden className="size-12 text-muted-foreground" />}{earned.length ? <ul className="space-y-3">{earned.map((reward) => <li key={reward.id} className="panel rounded-lg p-3"><p className="text-[13px]">{stoneReason(reward, state.tasks)}</p><p className="readout mt-1 text-xs text-muted-foreground">{new Date(reward.earnedAt).toLocaleString()}</p><p className="mt-2 break-all text-xs text-muted-foreground">Session key: {reward.sessionId}</p></li>)}</ul> : entry.earnable ? <Button asChild><Link href="/apps/neuralflow/focus">Start a focus interval</Link></Button> : null}<p className="text-xs text-muted-foreground">Local preview reward, no monetary value. No AI lore or provider claim was generated.</p></DialogContent></Dialog>;
    })}</div> : <Empty title="No earned stones yet" description="Complete a focus interval and record its outcome. Locked definitions are not marked unlocked just because an asset exists." action={<Button asChild><Link href="/apps/neuralflow/focus">Open focus</Link></Button>} />}
  </Screen>;
}
