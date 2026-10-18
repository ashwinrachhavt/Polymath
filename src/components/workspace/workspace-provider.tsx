"use client";

import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import { z } from "zod";
import { sampleState } from "./sample-state";
import { completionPatch, nextRank, reorderTasks, statusLabels } from "./tasks";
import type { Artifact, ArtifactKind, CalendarEvent, Capture, Company, Contact, Focus, Opportunity, Preferences, Project, Review, Task, TaskAttachment, TaskStatus, WorkspaceState } from "./types";

const task = z.object({ id: z.string(), title: z.string(), status: z.enum(["INBOX", "BACKLOG", "READY", "IN_PROGRESS", "WAITING", "DONE"]), priority: z.enum(["High", "Medium", "Low"]), projectId: z.string().optional(), dueDate: z.string().optional(), estimate: z.number().nonnegative(), description: z.string(), tags: z.array(z.string()), version: z.number().int().positive(), rank: z.number().optional(), recurrence: z.object({ frequency: z.enum(["daily", "weekly", "monthly"]), interval: z.number().int().positive(), until: z.string().optional(), count: z.number().int().positive().optional() }).optional(), attachments: z.array(z.object({ id: z.string(), kind: z.enum(["file", "url", "note"]), label: z.string(), value: z.string(), size: z.number().optional(), addedAt: z.string() })).optional(), completedAt: z.string().optional(), completionCount: z.number().int().nonnegative().optional() });
const artifact = z.object({ id: z.string(), title: z.string(), kind: z.enum(["note", "document", "zettel", "source", "dossier", "canvas"]), body: z.string(), tags: z.array(z.string()), links: z.array(z.string()), version: z.number().int().positive(), updatedAt: z.string() });
const schema = z.object({
  tasks: z.array(task), artifacts: z.array(artifact),
  artifactVersions: z.array(z.object({ id: z.string(), artifactId: z.string(), version: z.number().int().positive(), title: z.string(), body: z.string(), links: z.array(z.string()), tags: z.array(z.string()), createdAt: z.string() })).default([]),
  captures: z.array(z.object({ id: z.string(), text: z.string(), kind: z.enum(["text", "url", "file"]), status: z.enum(["UNPROCESSED", "TASK", "NOTE", "ARCHIVED"]), createdAt: z.string() })),
  contacts: z.array(z.object({ id: z.string(), name: z.string(), email: z.string(), company: z.string(), role: z.string(), status: z.enum(["Active", "Follow up", "New"]), notes: z.string() })),
  companies: z.array(z.object({ id: z.string(), name: z.string(), industry: z.string(), domain: z.string(), notes: z.string() })),
  opportunities: z.array(z.object({ id: z.string(), title: z.string(), company: z.string(), stage: z.enum(["Saved", "Preparing", "Applied", "Interview", "Offer", "Closed"]), value: z.string(), notes: z.string() })),
  reviews: z.array(z.object({ id: z.string(), title: z.string(), kind: z.string(), risk: z.enum(["External write", "Sensitive write", "Local change"]), status: z.enum(["Pending", "Approved locally", "Rejected"]), payload: z.string(), revision: z.number().int().positive() })),
  projects: z.array(z.object({ id: z.string(), title: z.string(), description: z.string(), status: z.string() })),
  events: z.array(z.object({ id: z.string(), title: z.string(), date: z.string(), start: z.string(), duration: z.number().positive(), taskId: z.string().optional(), provider: z.enum(["local", "google"]), type: z.enum(["Focus", "Meeting", "Personal", "Break"]).optional(), location: z.string().optional(), tags: z.array(z.string()).optional(), notes: z.string().optional(), notesArtifactId: z.string().optional(), endDate: z.string().optional(), recurrence: z.object({ frequency: z.enum(["daily", "weekly", "monthly"]), interval: z.number().int().positive(), until: z.string().optional(), count: z.number().int().positive().optional() }).optional(), exceptionDates: z.array(z.string()).optional() })),
  focus: z.object({ taskId: z.string(), startedAt: z.number(), remaining: z.number().nonnegative(), duration: z.number().positive(), status: z.enum(["running", "paused"]), completed: z.number().int().nonnegative() }).nullable(),
  rewards: z.array(z.object({ id: z.string(), title: z.string(), earnedAt: z.string(), sessionId: z.string() })),
  // `scheduler` carries a default so a workspace saved before this field
  // existed still loads instead of being rejected as an incompatible format.
  preferences: z.object({ celebrations: z.boolean(), reducedMotion: z.boolean(), killSwitch: z.boolean(), timezone: z.string(), weekStart: z.enum(["Monday", "Sunday"]), scheduler: z.object({ workStartHour: z.number().int(), workEndHour: z.number().int(), weekdays: z.array(z.number().int()), suggestionsEnabled: z.boolean(), eveningEnabled: z.boolean(), eveningStartHour: z.number().int(), eveningTitle: z.string(), topics: z.array(z.string()) }).default({ workStartHour: 9, workEndHour: 18, weekdays: [1, 2, 3, 4, 5], suggestionsEnabled: true, eveningEnabled: false, eveningStartHour: 19, eveningTitle: "Vibe coding", topics: [] }) }),
  activity: z.array(z.object({ id: z.string(), title: z.string(), detail: z.string(), at: z.string() })),
});

/*
 * localStorage is reachable as both a global and a window property depending
 * on the runtime, and reading it can throw in a locked-down privacy mode, so
 * every access goes through here.
 */
function resolveStorage(injected?: Pick<Storage, "getItem" | "setItem">) {
  if (injected) return injected;
  try { return globalThis.localStorage ?? window.localStorage; } catch { return undefined; }
}
/*
 * The second argument is the storage backend. It defaults to localStorage and
 * exists so a test can drive the real store without a browser; nothing in the
 * app passes it.
 */
export function createPreviewWorkspace(scope = "anonymous", storage?: Pick<Storage, "getItem" | "setItem">) {
const key = scope === "anonymous" ? "axiom-ui-preview-v1" : `axiom-ui-preview-v1:${scope}`;
let snapshot: WorkspaceState = sampleState;
let loaded = false;
let observedRaw: string | null = null;
let notice = "";
let storageWarning = "";
const listeners = new Set<() => void>();
function onStorage(event: StorageEvent) { if (event.key === key || event.key === null) { getSnapshot(); publish(); } }
function subscribe(listener: () => void) {
  if (!listeners.size && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
function publish() { for (const listener of listeners) listener(); }
function getSnapshot() {
  const store = resolveStorage(storage);
  if (store) {
    try {
      const raw = store.getItem(key);
      if (!loaded || raw !== observedRaw) {
        loaded = true;
        observedRaw = raw;
        if (raw) {
          const parsed = schema.safeParse(JSON.parse(raw));
          if (parsed.success) snapshot = parsed.data;
          else storageWarning = "Saved preview data has an incompatible format. Export any open work before resetting this preview.";
        } else snapshot = sampleState;
      }
    } catch { storageWarning = "Browser storage is unavailable. Preview changes will last only until refresh."; }
  }
  return snapshot;
}
/*
 * `ok` is false when the write was refused (another tab moved first), so an
 * in-memory change that never reached storage is not reported as saved.
 * `persisted` is false when storage itself failed; the caller must say so
 * rather than announce a save.
 */
function commitWithExpected(expectedRaw: string | null, next: WorkspaceState, title: string, detail = "Browser preview only"): { ok: boolean; persisted: boolean } {
  getSnapshot();
  if (expectedRaw !== observedRaw) {
    storageWarning = "Another tab changed this workspace. This change was not saved; inspect the latest record and try again.";
    publish();
    return { ok: false, persisted: false };
  }
  snapshot = { ...next, activity: [{ id: crypto.randomUUID(), title, detail, at: new Date().toISOString() }, ...next.activity].slice(0, 200) };
  const store = resolveStorage(storage);
  let persisted = true;
  try {
    const raw = JSON.stringify(snapshot);
    if (store) { store.setItem(key, raw); observedRaw = raw; }
    storageWarning = "";
  } catch { persisted = false; storageWarning = "Browser storage could not save this change. Keep this tab open or export your work; refreshing will lose unsaved changes."; }
  publish();
  return { ok: true, persisted };
}
function commit(next: WorkspaceState, title: string, detail = "Browser preview only"): { ok: boolean; persisted: boolean } {
  // Callers that just read through getSnapshot() observe the latest storage
  // state; their expectedRaw is the current one.
  return commitWithExpected(observedRaw, next, title, detail);
}
function notify(message: string) { notice = message; publish(); }
function addTask(title: string, extras: Partial<Omit<Task, "id" | "title" | "version" | "rank">> = {}) {
  const status = extras.status || "INBOX";
  const record: Task = { id: crypto.randomUUID(), title: title.trim(), priority: "Medium", estimate: 25, description: "", tags: [], ...extras, status, rank: nextRank(snapshot.tasks, status), version: 1 };
  if (!record.title) return undefined;
  commit({ ...getSnapshot(), tasks: [record, ...snapshot.tasks] }, "Task captured", record.title);
  return record;
}
function updateTask(id: string, patch: Partial<Task>) {
  const current = getSnapshot().tasks.find((task) => task.id === id);
  // Moving between columns lands at the end of the target column unless the
  // caller supplied an explicit index, so a status change never inherits a
  // rank that belongs to the lane it just left.
  const moved = current && patch.status && patch.status !== current.status && patch.rank === undefined ? { ...patch, rank: nextRank(snapshot.tasks.filter((task) => task.id !== id), patch.status) } : patch;
  commit({ ...getSnapshot(), tasks: snapshot.tasks.map((record) => record.id === id ? { ...record, ...moved, id: record.id, version: record.version + 1 } : record) }, "Task updated");
}
function reorderTask(id: string, status: TaskStatus, index: number) {
  const changed = reorderTasks(snapshot.tasks, id, status, index);
  if (!changed.length) return;
  const ranks = new Map(changed.map((entry) => [entry.id, entry.rank]));
  commit({ ...snapshot, tasks: snapshot.tasks.map((record) => ranks.has(record.id) ? { ...record, rank: ranks.get(record.id), version: record.version + 1 } : record) }, "Task order changed", `${changed.length} tasks renumbered in ${statusLabels[status]}`);
}
function completeTask(id: string) {
  const task = getSnapshot().tasks.find((record) => record.id === id);
  if (!task) return;
  const patch = completionPatch(task);
  const label = task.recurrence && patch.status !== "DONE" ? `${task.title} moves to ${patch.dueDate}` : task.title;
  commit({ ...getSnapshot(), tasks: snapshot.tasks.map((record) => record.id === id ? { ...record, ...patch, id: record.id, version: record.version + 1 } : record) }, task.recurrence ? "Recurring task advanced" : "Task completed", label);
}
function addAttachment(id: string, attachment: Omit<TaskAttachment, "id" | "addedAt">) {
  const task = getSnapshot().tasks.find((record) => record.id === id);
  if (!task) return;
  const record: TaskAttachment = { ...attachment, id: crypto.randomUUID(), addedAt: new Date().toISOString() };
  const existing = task.attachments || [];
  // Same URL or file name twice in one task is a duplicate, not a second copy.
  if (existing.some((item) => item.value === record.value && item.kind === record.kind)) { notify("That attachment is already on this task."); return; }
  updateTask(id, { attachments: [...existing, record] });
}
function removeAttachment(id: string, attachmentId: string) {
  const task = getSnapshot().tasks.find((record) => record.id === id);
  if (!task) return;
  updateTask(id, { attachments: (task.attachments || []).filter((item) => item.id !== attachmentId) });
}
function addArtifact(title: string, kind: ArtifactKind, body = "") {
  const record: Artifact = { id: crypto.randomUUID(), title: title.trim(), kind, body, tags: [], links: [], version: 1, updatedAt: new Date().toISOString() };
  if (!record.title) return undefined;
  commit({ ...getSnapshot(), artifacts: [record, ...snapshot.artifacts], artifactVersions: [...snapshot.artifactVersions, { id: crypto.randomUUID(), artifactId: record.id, version: 1, title: record.title, body, links: [], tags: [], createdAt: record.updatedAt }] }, `${kind} created`, record.title);
  return record;
}
function updateArtifact(id: string, patch: Partial<Artifact>) {
  // Capture before the read: getSnapshot() refreshes observedRaw to the
  // latest storage state, which would defeat commit's stale check — the
  // mutation would always compare the new observation against itself.
  const expectedRaw = observedRaw;
  const current = getSnapshot().artifacts.find((a) => a.id === id);
  if (!current) return { ok: false, persisted: false };
  const record = { ...current, ...patch, id: current.id, version: current.version + 1, updatedAt: new Date().toISOString() };
  const baseline = snapshot.artifactVersions.some((v) => v.artifactId === id && v.version === current.version) ? [] : [{ id: crypto.randomUUID(), artifactId: id, version: current.version, title: current.title, body: current.body, links: [...current.links], tags: [...current.tags], createdAt: current.updatedAt }];
  const version = { id: crypto.randomUUID(), artifactId: id, version: record.version, title: record.title, body: record.body, links: [...record.links], tags: [...record.tags], createdAt: record.updatedAt };
  return commitWithExpected(expectedRaw, { ...snapshot, artifacts: snapshot.artifacts.map((a) => a.id === id ? record : a), artifactVersions: [...snapshot.artifactVersions, ...baseline, version] }, "Artifact checkpoint saved");
}
function addCapture(text: string, kind: Capture["kind"] = "text") {
  const record: Capture = { id: crypto.randomUUID(), text: text.trim(), kind, status: "UNPROCESSED", createdAt: new Date().toISOString() };
  if (!record.text) return undefined;
  commit({ ...getSnapshot(), captures: [record, ...snapshot.captures] }, "Item captured", record.text);
  return record;
}
function updateCapture(id: string, patch: Partial<Capture>) { commit({ ...getSnapshot(), captures: snapshot.captures.map((r) => r.id === id ? { ...r, ...patch, id: r.id } : r) }, "Capture clarified"); }
function addContact(contact: Omit<Contact, "id">) { const record = { ...contact, id: crypto.randomUUID() }; commit({ ...getSnapshot(), contacts: [record, ...snapshot.contacts] }, "Contact created", record.name); return record; }
function updateContact(id: string, patch: Partial<Contact>) { commit({ ...getSnapshot(), contacts: snapshot.contacts.map((r) => r.id === id ? { ...r, ...patch, id: r.id } : r) }, "Contact updated"); }
function addCompany(company: Omit<Company, "id">) { const record = { ...company, id: crypto.randomUUID() }; commit({ ...getSnapshot(), companies: [record, ...snapshot.companies] }, "Company created", record.name); return record; }
function addOpportunity(opportunity: Omit<Opportunity, "id">) { const record = { ...opportunity, id: crypto.randomUUID() }; commit({ ...getSnapshot(), opportunities: [record, ...snapshot.opportunities] }, "Opportunity created", record.title); return record; }
function updateCompany(id: string, patch: Partial<Company>) { commit({ ...getSnapshot(), companies: snapshot.companies.map((r) => r.id === id ? { ...r, ...patch, id: r.id } : r) }, "Company updated"); }
function deleteContact(id: string) { commit({ ...getSnapshot(), contacts: snapshot.contacts.filter((r) => r.id !== id) }, "Contact removed from preview"); }
function deleteCompany(id: string) { commit({ ...getSnapshot(), companies: snapshot.companies.filter((r) => r.id !== id) }, "Company removed from preview"); }
function updateProject(id: string, patch: Partial<Project>) { commit({ ...getSnapshot(), projects: snapshot.projects.map((r) => r.id === id ? { ...r, ...patch, id: r.id } : r) }, "Project updated"); }
function addReview(review: Omit<Review, "id" | "status" | "revision">) { const record: Review = { ...review, id: crypto.randomUUID(), status: "Pending", revision: 1 }; commit({ ...getSnapshot(), reviews: [record, ...snapshot.reviews] }, "Local proposal created", "No external action was performed"); return record; }
function updateOpportunity(id: string, patch: Partial<Opportunity>) { commit({ ...getSnapshot(), opportunities: snapshot.opportunities.map((r) => r.id === id ? { ...r, ...patch, id: r.id } : r) }, "Opportunity updated"); }
function updateReview(id: string, patch: Partial<Review>) {
  commit({ ...getSnapshot(), reviews: snapshot.reviews.map((r) => r.id === id ? { ...r, ...patch, id: r.id, ...(patch.payload !== undefined && patch.payload !== r.payload ? { revision: r.revision + 1, status: "Pending" as const } : {}) } : r) }, "Review updated locally", "No external action was performed");
}
function updateFocus(focus: Focus | null) { commit({ ...getSnapshot(), focus }, focus ? "Focus session updated" : "Focus session ended"); }
function updatePreferences(patch: Partial<Preferences>) { commit({ ...getSnapshot(), preferences: { ...snapshot.preferences, ...patch } }, "Preview preferences updated"); }
function addEvent(event: Omit<CalendarEvent, "id">) { const record = { ...event, id: crypto.randomUUID() }; commit({ ...getSnapshot(), events: [...snapshot.events, record] }, "Local work block created"); return record; }
function deleteEvent(id: string) {
  const event = getSnapshot().events.find((item) => item.id === id);
  // A provider event is not ours to delete locally; it would reappear on the
  // next sync and the local record would silently disagree with the provider.
  if (!event || event.provider !== "local") { notify("Provider events are read-only in this preview. Removing one requires a reviewed provider write."); return; }
  commit({ ...getSnapshot(), events: snapshot.events.filter((item) => item.id !== id) }, "Local work block removed", event.title);
}
/*
 * Cancelling one occurrence of a repeating block records the date as an
 * exception, so the series stays intact and the change is reversible.
 */
function cancelOccurrence(id: string, date: string) {
  const event = getSnapshot().events.find((item) => item.id === id);
  if (!event) return;
  commit({ ...getSnapshot(), events: snapshot.events.map((item) => item.id === id ? { ...item, exceptionDates: [...new Set([...(item.exceptionDates || []), date])] } : item) }, "Occurrence cancelled", `${event.title} on ${date}`);
}
function updateEvent(id: string, patch: Partial<CalendarEvent>) { commit({ ...getSnapshot(), events: snapshot.events.map((r) => r.id === id ? { ...r, ...patch, id: r.id } : r) }, "Local work block updated"); }
function addProject(project: Omit<Project, "id">) { const record = { ...project, id: crypto.randomUUID() }; commit({ ...getSnapshot(), projects: [...snapshot.projects, record] }, "Project created", record.title); return record; }
function awardReward(reward: Omit<WorkspaceState["rewards"][number], "id">) {
  if (getSnapshot().rewards.some((r) => r.sessionId === reward.sessionId)) return;
  commit({ ...snapshot, rewards: [...snapshot.rewards, { ...reward, id: crypto.randomUUID() }] }, "Preview reward earned");
}
function resetPreview() { commit(sampleState, "Sample workspace reset"); notify("Sample workspace reset. Your previous browser preview changes were replaced."); }

return { storageScope: scope, subscribe, getSnapshot, getNotice: () => notice, getStorageWarning: () => storageWarning, addTask, updateTask, reorderTask, completeTask, addAttachment, removeAttachment, addArtifact, updateArtifact, addCapture, updateCapture, addContact, updateContact, deleteContact, addCompany, updateCompany, deleteCompany, updateProject, addReview, addOpportunity, updateOpportunity, updateReview, updateFocus, updatePreferences, addEvent, updateEvent, deleteEvent, cancelOccurrence, addProject, awardReward, resetPreview, notify };
}
export const previewWorkspace = createPreviewWorkspace();
const WorkspaceContext = createContext(previewWorkspace);
export function useWorkspace() {
  const workspace = useContext(WorkspaceContext);
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, () => sampleState);
  return { state, ...workspace };
}
export function PreviewStorageWarning() {
  const workspace = useContext(WorkspaceContext);
  const warning = useSyncExternalStore(workspace.subscribe, workspace.getStorageWarning, () => "");
  if (!warning) return null;
  function exportCurrent() {
    const blob = new Blob([JSON.stringify(workspace.getSnapshot(), null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "axiom-browser-preview.json";
    anchor.click();
    URL.revokeObjectURL(href);
  }
  return <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px]"><span className="min-w-0 flex-1">{warning}</span><button type="button" onClick={exportCurrent} className="min-h-8 shrink-0 rounded-md border border-border bg-card px-3 font-medium">Export current preview</button></div>;
}
export function WorkspaceProvider({ children, storageScope = "anonymous" }: { children: ReactNode; storageScope?: string }) {
  const [workspace] = useState(() => createPreviewWorkspace(storageScope));
  const message = useSyncExternalStore(workspace.subscribe, workspace.getNotice, () => "");
  return <WorkspaceContext.Provider value={workspace}>{children}{message && <div role="status" className="panel fixed right-4 bottom-20 z-50 flex max-w-sm items-start gap-3 rounded-xl p-4 text-[13px] md:bottom-4"><span>{message}</span><button type="button" className="shrink-0 text-muted-foreground underline" aria-label="Dismiss notification" onClick={() => workspace.notify("")}>Dismiss</button></div>}</WorkspaceContext.Provider>;
}
