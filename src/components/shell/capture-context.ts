import type { CaptureContext } from "@/domains/capture/context";

/*
 * What the page already knows at the moment Capture opens, so the person has
 * nothing to fill in: where they were, when, the words they had selected and
 * the text around them, the conversation turn those words came from, and the
 * project they were inside. Read once, at open, before the dialog takes focus
 * and the selection with it.
 */

const MAX_PASSAGE = 10_000;
const AROUND = 600;
const PROJECT_PATH = /^\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const BLOCK = "p, li, blockquote, td, pre, h1, h2, h3, h4, h5, h6, [data-turn-id]";

const clip = (value: string | null | undefined, max: number) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
};

export type CaptureSnapshot = { context: CaptureContext; passage: string | null };

export function snapshotCaptureContext(): CaptureSnapshot {
  const url = location.href.length <= 2_000 ? location.href : undefined;
  const context: CaptureContext = {
    capturedAt: new Date().toISOString(),
    source: { kind: "app", title: clip(document.title, 500), url },
  };
  const project = PROJECT_PATH.exec(location.pathname)?.[1];
  if (project) context.suggestion = { projectId: project };

  const selection = window.getSelection();
  const selected = selection && !selection.isCollapsed ? selection.toString().trim() : "";
  if (!selection || !selected) return { context, passage: null };
  const anchor = selection.getRangeAt(0).commonAncestorContainer;
  const element = anchor instanceof Element ? anchor : anchor.parentElement;
  // Text being edited is not a passage from a source.
  if (!element || element.closest("input, textarea, [contenteditable='true'], [role='dialog']")) {
    return { context, passage: null };
  }

  const passage = selected.slice(0, MAX_PASSAGE);
  context.passage = passage;
  if (selected.length > MAX_PASSAGE) {
    context.partial = {
      reason: `The selection was ${selected.length.toLocaleString()} characters; the first ${MAX_PASSAGE.toLocaleString()} are kept.`,
    };
  }

  // The surrounding text: the enclosing block, widened while it is little more
  // than the selection itself - never past a chat turn or out of <body>, where
  // the page title and scripts would read as context.
  let block: Element = element.closest(BLOCK) ?? element;
  for (
    let i = 0;
    i < 3 &&
    block.parentElement &&
    block.parentElement !== document.body &&
    !block.matches("[data-turn-id]") &&
    (block.textContent ?? "").length < selected.length + 40;
    i++
  ) {
    block = block.parentElement;
  }
  const whole = block.textContent ?? "";
  const at = whole.indexOf(selected.slice(0, 200));
  if (at >= 0) {
    const before = clip(whole.slice(Math.max(0, at - AROUND), at), 4_000);
    const after = clip(whole.slice(at + selected.length, at + selected.length + AROUND), 4_000);
    if (before || after) context.surrounding = { before, after };
  }

  const turn = element.closest<HTMLElement>("[data-turn-id]");
  if (turn) {
    const role = turn.dataset.turnRole;
    context.source = { ...context.source, kind: "conversation" };
    context.turn = {
      messageId: clip(turn.dataset.turnId, 200),
      role: role === "user" || role === "assistant" ? role : "other",
    };
  }
  return { context, passage };
}
