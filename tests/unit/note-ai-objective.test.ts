import { describe, expect, it } from "vitest";
import { NOTE_AI_MARKER, buildNoteAIObjective } from "@/domains/knowledge/note-ai";

const base = { noteTitle: "Trip plan", noteMarkdown: "Fly out Monday. Book the coastal hotel." };

describe("buildNoteAIObjective", () => {
  it("improve on the full note quotes the whole note and demands text-only output", () => {
    const objective = buildNoteAIObjective({ action: "improve", ...base });
    expect(objective).toContain(NOTE_AI_MARKER);
    expect(objective).toContain('"Trip plan"');
    expect(objective).toContain("the note");
    expect(objective).toContain("Fly out Monday.");
    expect(objective).toContain("Return only the revised text");
  });

  it("a selection becomes the subject instead of the full note", () => {
    const objective = buildNoteAIObjective({ action: "shorten", ...base, selection: "Book the coastal hotel." });
    expect(objective).toContain("the selected passage");
    expect(objective).toContain("Book the coastal hotel.");
    expect(objective).not.toContain("Fly out Monday.");
  });

  it("translate names the target language", () => {
    const objective = buildNoteAIObjective({ action: "translate", ...base, language: "French" });
    expect(objective).toContain("into French");
    expect(objective).toContain("Preserve the Markdown structure");
  });

  it("ask carries the question and the wiki-link citation contract", () => {
    const objective = buildNoteAIObjective({ action: "ask", ...base, question: "Where am I staying?" });
    expect(objective).toContain("Question: Where am I staying?");
    expect(objective).toContain("[[wiki-link]]");
    expect(objective).toContain("search the workspace's saved notes");
    expect(objective).toContain("instead of inventing");
  });

  it("a note past the cap is quoted with an explicit cut, never silently truncated", () => {
    const long = "x".repeat(9000);
    const objective = buildNoteAIObjective({ action: "summarize", noteTitle: "Long", noteMarkdown: long });
    expect(objective).toContain("the note continues");
    expect(objective.length).toBeLessThan(9000);
  });
});
