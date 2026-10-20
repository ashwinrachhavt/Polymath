import { beforeEach, describe, expect, it } from "vitest";
import { createPreviewWorkspace, previewWorkspace as workspace } from "@/components/workspace/workspace-provider";
import { products, productHref } from "@/lib/products";

describe("browser-only UI preview", () => {
  beforeEach(() => workspace.resetPreview());
  it("isolates separate authenticated preview store instances", () => {
    const first = createPreviewWorkspace("owner-one");
    const second = createPreviewWorkspace("owner-two");
    first.addTask("Only the first owner should see this");
    expect(first.getSnapshot().tasks).toHaveLength(1);
    expect(second.getSnapshot().tasks).toHaveLength(0);
    expect(second.getSnapshot().tasks.some((t) => t.title.includes("first owner"))).toBe(false);
  });
  it("captures a task without requiring a board", () => {
    const task = workspace.addTask("A task from any product");
    expect(task?.status).toBe("INBOX");
    expect(workspace.getSnapshot().tasks.find((r) => r.id === task?.id)?.title).toBe("A task from any product");
    expect(task).not.toHaveProperty("boardId");
  });
  it("keeps standalone notes with multiple record links", () => {
    const note = workspace.addArtifact("Shared note", "note", "A source-grounded idea");
    expect(note).toBeDefined();
    if (!note) throw new Error("Expected a note");
    const other = workspace.addArtifact("Linked target", "note", "A second note");
    if (!other) throw new Error("Expected a second note");
    workspace.updateArtifact(note.id, { links: [note.id, other.id] });
    expect(workspace.getSnapshot().artifacts.find((r) => r.id === note.id)?.links).toHaveLength(2);
  });
  it("changes task presentation state without replacing the record", () => {
    const added = workspace.addTask("Present me", { description: "Original description" });
    if (!added) throw new Error("Expected a task");
    const before = workspace.getSnapshot().tasks.find((r) => r.id === added.id)!;
    workspace.updateTask(before.id, { status: "DONE" });
    const after = workspace.getSnapshot().tasks.find((r) => r.id === before.id);
    expect(after?.description).toBe(before.description);
    expect(after?.version).toBe(before.version + 1);
    expect(workspace.getSnapshot().tasks).toHaveLength(1);
  });
  it("keeps immutable checkpoints when a shared note changes", () => {
    const note = workspace.addArtifact("Versioned note", "note", "Original text");
    if (!note) throw new Error("Expected a note");
    workspace.updateArtifact(note.id, { body: "Revised text" });
    const versions = workspace.getSnapshot().artifactVersions.filter((v) => v.artifactId === note.id);
    expect(versions.map((v) => v.body)).toEqual(["Original text", "Revised text"]);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });
  it("invalidates local approval whenever the reviewed payload changes", () => {
    const review = workspace.addReview({ title: "Send the brief", kind: "Email", risk: "External write", payload: "Original payload" });
    workspace.updateReview(review.id, { status: "Approved locally" });
    workspace.updateReview(review.id, { payload: "Revised payload", status: "Approved locally" });
    const revised = workspace.getSnapshot().reviews.find((r) => r.id === review.id);
    expect(revised?.status).toBe("Pending");
    expect(revised?.revision).toBe(2);
    expect(workspace.getSnapshot().activity[0].detail).toBe("No external action was performed");
  });
  it("does not award the same preview focus session twice", () => {
    const reward = { title: "Focus stone", earnedAt: "2026-10-11", sessionId: "session-one" };
    workspace.awardReward(reward);
    workspace.awardReward(reward);
    expect(workspace.getSnapshot().rewards).toHaveLength(1);
  });
  it("persists the local focus lifecycle in the same workspace snapshot", () => {
    workspace.updateFocus({ taskId: "task-architecture", startedAt: 12345, remaining: 1500, duration: 1500, status: "paused", completed: 0 });
    expect(workspace.getSnapshot().focus?.status).toBe("paused");
    workspace.updateFocus(null);
    expect(workspace.getSnapshot().focus).toBeNull();
  });
  it("has unique product routes for every visible destination", () => {
    const routes = products.flatMap((p) => p.destinations.map((d) => productHref(p, d.slug)));
    expect(new Set(routes).size).toBe(routes.length);
    expect(products.map((p) => p.id)).toEqual(["command-center", "neuralflow", "alfred"]);
  });
});
