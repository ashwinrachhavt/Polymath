import { afterEach, describe, expect, it, vi } from "vitest";
import { createPreviewWorkspace } from "@/components/workspace/workspace-provider";

function browserStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  return values;
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
});
