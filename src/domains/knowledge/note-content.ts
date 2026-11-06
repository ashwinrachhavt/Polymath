import { MarkdownManager } from "@tiptap/markdown";
import { StarterKit } from "@tiptap/starter-kit";
import type { NoteContent } from "./notes";

/*
 * Notes are stored in two shapes. The editor writes { format: "markdown",
 * text } (note-editor.tsx body()); the direct-creation paths — zettel cards,
 * chat saves, decomposition — write Tiptap doc JSON with the text nested
 * per node. Every reader goes through here, so both shapes read back as
 * Markdown regardless of which writer produced the row.
 */

let manager: MarkdownManager | null = null;

function mdManager(): MarkdownManager {
  // Same extension set the notes editor mounts (note-editor's StarterKit),
  // so serialization round-trips what the editor itself would emit.
  if (!manager) manager = new MarkdownManager({ extensions: [StarterKit] });
  return manager;
}

export function noteContentToMarkdown(content: NoteContent | null | undefined): string {
  if (!content) return "";
  if (typeof content.text === "string") return content.text;
  if (content.type !== "doc" || !Array.isArray(content.content)) return "";
  try {
    return mdManager().serialize(content as Parameters<MarkdownManager["serialize"]>[0]);
  } catch {
    // A doc the serializer rejects (unknown node types from a newer writer)
    // must not blank the note; fall back to the version's plain text downstream.
    return "";
  }
}
