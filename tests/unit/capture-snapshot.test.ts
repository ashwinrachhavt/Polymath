// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { snapshotCaptureContext } from "@/components/shell/capture-context";

/*
 * Value: protects=Capture reads the page with no questions: selection as passage, surrounding text,
 * the chat turn, the project you are in, and ignores text being edited; fails_when=the editable
 * guard, the clip, or the turn/project lookup regress; why_new=the snapshot was untested;
 * seam=none; no_claim=real browser Selection quirks (jsdom)
 */

function select(node: Node, start: number, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
});

describe("snapshotCaptureContext", () => {
  it("records the time and the page with nothing selected", () => {
    document.title = "Notes";
    const { context, passage } = snapshotCaptureContext();
    expect(passage).toBeNull();
    expect(context.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(context.source).toMatchObject({ kind: "app", title: "Notes" });
    expect(context.suggestion).toBeUndefined();
  });

  it("suggests the project whose page is open", () => {
    history.replaceState(null, "", "/projects/0f8fad5b-d9cb-469f-a165-70867728950e/notebook");
    expect(snapshotCaptureContext().context.suggestion).toEqual({ projectId: "0f8fad5b-d9cb-469f-a165-70867728950e" });
  });

  it("keeps a selection as the passage with the text around it and its chat turn", () => {
    document.body.innerHTML =
      '<div data-turn-id="m7" data-turn-role="assistant"><p>Start here. The exact words matter. Then more.</p></div>';
    const text = document.querySelector("p")!.firstChild!;
    select(text, 12, 34);
    const { context, passage } = snapshotCaptureContext();
    expect(passage).toBe("The exact words matter");
    expect(context.surrounding).toEqual({ before: "Start here.", after: ". Then more." });
    expect(context.turn).toEqual({ messageId: "m7", role: "assistant" });
    expect(context.source?.kind).toBe("conversation");
  });

  it("ignores a selection inside something being edited", () => {
    document.body.innerHTML = '<div contenteditable="true"><p>draft words here</p></div>';
    select(document.querySelector("p")!.firstChild!, 0, 5);
    const { context, passage } = snapshotCaptureContext();
    expect(passage).toBeNull();
    expect(context.passage).toBeUndefined();
  });

  it("clips a very long selection and labels the capture partial", () => {
    document.body.innerHTML = `<p>${"a".repeat(12_000)}</p>`;
    select(document.querySelector("p")!.firstChild!, 0, 12_000);
    const { context, passage } = snapshotCaptureContext();
    expect(passage).toHaveLength(10_000);
    expect(context.partial?.reason).toContain("12,000");
  });
});
