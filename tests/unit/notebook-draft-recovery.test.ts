import { afterEach, describe, expect, it, vi } from "vitest";
import { createPreviewWorkspace } from "@/components/workspace/workspace-provider";
import { clearDraft, readDraft, writeDraft } from "@/components/products/alfred/working-draft";

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

describe("working draft recovery", () => {
  it("survives a reload and is scoped to one owner and one note", () => {
    browserStorage();
    writeDraft("owner-one", "note-1", { title: "Half written", body: "Unsaved words", tags: "draft" });
    expect(readDraft("owner-one", "note-1")).toMatchObject({ title: "Half written", body: "Unsaved words", tags: "draft" });
    expect(readDraft("owner-two", "note-1")).toBeUndefined();
    expect(readDraft("owner-one", "note-2")).toBeUndefined();
  });
  it("is cleared once the note is saved", () => {
    browserStorage();
    writeDraft("owner-one", "note-1", { title: "t", body: "b", tags: "" });
    clearDraft("owner-one", "note-1");
    expect(readDraft("owner-one", "note-1")).toBeUndefined();
  });
  it("degrades to no draft rather than throwing when storage is blocked", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } });
    expect(writeDraft("owner-one", "note-1", { title: "t", body: "b", tags: "" })).toBe(false);
    expect(readDraft("owner-one", "note-1")).toBeUndefined();
    expect(() => clearDraft("owner-one", "note-1")).not.toThrow();
  });
});
