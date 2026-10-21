import { afterEach, describe, expect, it, vi } from "vitest";
import { createPreviewWorkspace } from "@/components/workspace/workspace-provider";

function browserStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  return values;
}
/*
 * A mutation that commits reads storage twice: once to build the next state
 * and once inside commit to check it against what is stored. A concurrent tab
 * can write between those reads, so this storage rewrites the saved value on
 * the nth read after it is armed, which is what makes a tab stale mid-write.
 */
function switchingStorage() {
  const values = browserStorage();
  let pending: { remaining: number; run: (key: string) => void } | undefined;
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => {
      if (pending && --pending.remaining === 0) {
        const { run } = pending;
        pending = undefined;
        run(key);
      }
      return values.get(key) ?? null;
    },
    setItem: (key: string, value: string) => { values.set(key, value); },
  });
  return { values, onRead(n: number, run: (key: string) => void) { pending = { remaining: n, run }; } };
}
type Preview = ReturnType<typeof createPreviewWorkspace>;
/*
 * Arms a write from another tab to land between a mutation's base read and its
 * commit check, then returns the base state the foreign snapshot was built on.
 */
function staleTab(scope: string, checkRead = 2) {
  const storage = switchingStorage();
  const workspace = createPreviewWorkspace(scope);
  const base = workspace.getSnapshot();
  const otherTab = { id: "other-tab", title: "Saved in the other tab", detail: "", at: "2026-01-15T12:00:00.000Z" };
  storage.onRead(checkRead, () => storage.values.set(`axiom-ui-preview-v1:${scope}`, JSON.stringify({ ...base, activity: [otherTab, ...base.activity] })));
  return { workspace, otherTab };
}
afterEach(() => vi.unstubAllGlobals());
describe("browser preview persistence", () => {
  it("refreshes another tab's saved records before updating preferences", () => {
    browserStorage();
    const first = createPreviewWorkspace("shared-owner");
    const second = createPreviewWorkspace("shared-owner");
    first.getSnapshot();
    second.getSnapshot();
    first.addTask("Saved in another tab");
    second.updatePreferences({ weekStart: "Sunday" });
    expect(second.getSnapshot().tasks.some((t) => t.title === "Saved in another tab")).toBe(true);
    expect(first.getSnapshot().preferences.weekStart).toBe("Sunday");
  });
  it("keeps persisted snapshots isolated by authenticated scope", () => {
    const values = browserStorage();
    const first = createPreviewWorkspace("first-owner");
    const second = createPreviewWorkspace("second-owner");
    first.addTask("First owner private draft");
    second.addTask("Second owner private draft");
    expect(values.size).toBe(2);
    expect(second.getSnapshot().tasks.some((t) => t.title === "First owner private draft")).toBe(false);
  });
  it("keeps storage failure visible despite an ordinary success notification", () => {
    browserStorage();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } });
    const workspace = createPreviewWorkspace("quota-owner");
    workspace.addTask("Available for export, not persisted");
    workspace.notify("Task saved locally");
    expect(workspace.getStorageWarning()).toContain("could not save");
    expect(workspace.getStorageWarning()).toContain("refreshing will lose");
    expect(workspace.getSnapshot().tasks.some((t) => t.title.includes("Available for export"))).toBe(true);
  });
  it("subscribes and cleans up cross-tab storage notifications", () => {
    browserStorage();
    const workspace = createPreviewWorkspace("events-owner");
    const unsubscribe = workspace.subscribe(vi.fn());
    expect(window.addEventListener).toHaveBeenCalledWith("storage", expect.any(Function));
    unsubscribe();
    expect(window.removeEventListener).toHaveBeenCalledWith("storage", expect.any(Function));
  });
  it("returns no task when another tab moved first, and keeps that tab's record", () => {
    const storage = switchingStorage();
    const stale = createPreviewWorkspace("stale-owner");
    const otherTabTask = { id: "other-tab", title: "Saved in the other tab", status: "INBOX", priority: "Medium", estimate: 25, description: "", tags: [], version: 1, rank: 1 };
    const otherTabRaw = JSON.stringify({ ...stale.getSnapshot(), tasks: [otherTabTask, ...stale.getSnapshot().tasks] });
    // The second read is the one commit uses for its expected-raw check, so
    // this lands after addTask read the base state and before it commits.
    storage.onRead(2, () => storage.values.set("axiom-ui-preview-v1:stale-owner", otherTabRaw));
    expect(stale.addTask("Written by the stale tab")).toBeUndefined();
    expect(stale.getStorageWarning()).toContain("Another tab changed");
    expect(stale.getSnapshot().tasks.some((task) => task.title === "Written by the stale tab")).toBe(false);
    expect(stale.getSnapshot().tasks.some((task) => task.title === "Saved in the other tab")).toBe(true);
  });
  it("reports a refused update instead of a silent success", () => {
    const storage = switchingStorage();
    const stale = createPreviewWorkspace("stale-update-owner");
    // The preview boots empty, so the row under test has to exist first.
    const created = stale.addTask("Original title");
    if (!created) throw new Error("Expected a task");
    const target = stale.getSnapshot().tasks.find((task) => task.id === created.id);
    if (!target) throw new Error("Expected the created task");
    const otherTabRaw = JSON.stringify({ ...stale.getSnapshot(), preferences: { ...stale.getSnapshot().preferences, weekStart: "Sunday" } });
    // updateTask reads twice for the patch and the next state; the third read
    // is commit's stale check, where the other tab's write lands.
    storage.onRead(3, () => storage.values.set("axiom-ui-preview-v1:stale-update-owner", otherTabRaw));
    expect(stale.updateTask(target.id, { title: "Renamed in a stale tab" })).toEqual({ ok: false, persisted: false });
    expect(stale.getStorageWarning()).toContain("Another tab changed");
    expect(stale.getSnapshot().tasks.find((task) => task.id === target.id)?.title).toBe(target.title);
  });
  it("still returns the created task on a saved write", () => {
    browserStorage();
    const workspace = createPreviewWorkspace("saved-owner");
    const created = workspace.addTask("Committed task");
    expect(created?.title).toBe("Committed task");
    expect(workspace.getSnapshot().tasks.find((task) => task.id === created?.id)?.title).toBe("Committed task");
  });
  it.each([
    ["artifact", (workspace: Preview) => workspace.addArtifact("Stale note", "note", "Body")],
    ["project", (workspace: Preview) => workspace.addProject({ title: "Stale project", description: "", status: "Active" })],
    ["event", (workspace: Preview) => workspace.addEvent({ title: "Stale block", date: "2026-01-15", start: "10:00", duration: 25, provider: "local" })],
    ["contact", (workspace: Preview) => workspace.addContact({ name: "Stale contact", email: "", company: "", role: "", status: "New", notes: "" })],
    ["company", (workspace: Preview) => workspace.addCompany({ name: "Stale company", industry: "", domain: "", notes: "" })],
    ["opportunity", (workspace: Preview) => workspace.addOpportunity({ title: "Stale opportunity", company: "", stage: "Saved", value: "", notes: "" })],
    ["review", (workspace: Preview) => workspace.addReview({ title: "Stale proposal", kind: "Email", risk: "External write", payload: "" })],
  ] as const)("returns no %s when another tab moved first", (_kind, create) => {
    const { workspace, otherTab } = staleTab(`stale-${_kind}-owner`);
    expect(create(workspace)).toBeUndefined();
    expect(workspace.getStorageWarning()).toContain("Another tab changed");
    expect(workspace.getSnapshot().activity.some((entry) => entry.id === otherTab.id)).toBe(true);
  });
  it("does not claim a reset that was refused", () => {
    // resetPreview builds its state from emptyWorkspaceState, so the first
    // read is already commit's stale check.
    const { workspace } = staleTab("stale-reset-owner", 1);
    expect(workspace.resetPreview()).toEqual({ ok: false, persisted: false });
    expect(workspace.getNotice()).not.toContain("were replaced");
    expect(workspace.getStorageWarning()).toContain("Another tab changed");
  });
  it("refuses to delete a provider event locally", () => {
    const values = browserStorage();
    const base = createPreviewWorkspace("provider-event-owner").getSnapshot();
    values.set("axiom-ui-preview-v1:provider-event-owner", JSON.stringify({ ...base, events: [...base.events, { id: "google-event", title: "Provider block", date: "2026-01-15", start: "09:00", duration: 25, provider: "google" }] }));
    const workspace = createPreviewWorkspace("provider-event-owner");
    expect(workspace.deleteEvent("google-event")).toEqual({ ok: false, persisted: false });
    expect(workspace.getNotice()).toContain("read-only");
    expect(workspace.getSnapshot().events.some((event) => event.id === "google-event")).toBe(true);
  });
});
