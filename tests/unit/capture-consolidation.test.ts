import { describe, expect, it } from "vitest";
import { createPreviewWorkspace } from "@/components/workspace/workspace-provider";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe("shared capture clarification", () => {
  it("creates one task with its file while retaining the original capture across reload", () => {
    const store = storage();
    const workspace = createPreviewWorkspace("capture-owner", store);
    const attachment = { label: "field-notes.txt", value: "data:application/octet-stream;base64,bm90ZXM=", size: 5 };
    const capture = workspace.addCapture("Follow up on field notes\nOriginal context", "file", attachment);
    expect(capture).toBeDefined();
    const id = workspace.clarifyCapture(capture!.id, "task");
    expect(id).toBeDefined();
    expect(workspace.clarifyCapture(capture!.id, "task")).toBeUndefined();
    const reloaded = createPreviewWorkspace("capture-owner", store).getSnapshot();
    expect(reloaded.tasks.filter((task) => task.id === id)).toHaveLength(1);
    expect(reloaded.tasks.find((task) => task.id === id)?.attachments?.[0]).toMatchObject(attachment);
    expect(reloaded.captures.find((item) => item.id === capture!.id)).toMatchObject({ text: capture!.text, status: "TASK", derivedId: id, attachment });
  });

  it("creates a linked note and initial checkpoint in the same clarification", () => {
    const workspace = createPreviewWorkspace("note-owner", storage());
    const capture = workspace.addCapture("A decision worth keeping\nWith supporting details");
    expect(capture).toBeDefined();
    const id = workspace.clarifyCapture(capture!.id, "note");
    const state = workspace.getSnapshot();
    expect(state.artifacts.find((artifact) => artifact.id === id)).toMatchObject({ body: capture!.text, links: [capture!.id], version: 1 });
    expect(state.artifactVersions.filter((version) => version.artifactId === id)).toHaveLength(1);
    expect(state.captures.find((item) => item.id === capture!.id)?.status).toBe("NOTE");
    expect(workspace.clarifyCapture(capture!.id, "task")).toBeUndefined();
  });

  it("does not turn an archived or missing capture into work", () => {
    const workspace = createPreviewWorkspace("archive-owner", storage());
    const capture = workspace.addCapture("Keep for later");
    workspace.updateCapture(capture!.id, { status: "ARCHIVED" });
    expect(workspace.clarifyCapture(capture!.id, "task")).toBeUndefined();
    expect(workspace.clarifyCapture("unknown", "note")).toBeUndefined();
  });
});
