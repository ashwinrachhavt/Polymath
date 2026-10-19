import { afterEach, describe, expect, it, vi } from "vitest";
import { createPreviewWorkspace } from "@/components/workspace/workspace-provider";

function browserStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  return values;
}
afterEach(() => vi.unstubAllGlobals());

describe("truthful artifact saves", () => {
  it("reports a persisted artifact write as saved", () => {
    browserStorage();
    const workspace = createPreviewWorkspace("save-owner");
    const note = workspace.addArtifact("Working note", "note", "First body")!;
    expect(workspace.updateArtifact(note.id, { body: "Second body" })).toEqual({ ok: true, persisted: true });
    expect(workspace.getSnapshot().artifacts.find((a) => a.id === note.id)?.body).toBe("Second body");
  });
  it("does not report success when browser storage refuses the write", () => {
    browserStorage();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: () => {} });
    const workspace = createPreviewWorkspace("quota-save-owner");
    const note = workspace.addArtifact("Working note", "note", "First body")!;
    expect(workspace.updateArtifact(note.id, { body: "Second body" })).toEqual({ ok: true, persisted: false });
    expect(workspace.getStorageWarning()).toContain("could not save");
  });
  it("refuses a stale-tab artifact save instead of claiming it applied", () => {
    browserStorage();
    const first = createPreviewWorkspace("stale-owner");
    const second = createPreviewWorkspace("stale-owner");
    const note = first.addArtifact("Shared note", "note", "Original")!;
    first.getSnapshot();
    second.getSnapshot();
    first.updateArtifact(note.id, { body: "First tab wins" });
    expect(second.updateArtifact(note.id, { body: "Second tab loses" })).toEqual({ ok: false, persisted: false });
    expect(first.getSnapshot().artifacts.find((a) => a.id === note.id)?.body).toBe("First tab wins");
  });
});
