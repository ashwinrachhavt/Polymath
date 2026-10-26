import { describe, expect, it } from "vitest";

import { parseNavigationIntent, SURFACE_HREF, SURFACE_LABEL } from "@/domains/supervisor/navigation";

describe("parseNavigationIntent", () => {
  it.each([
    ["show me my open tasks", "tasks"],
    ["Open tasks", "tasks"],
    ["list my tasks", "tasks"],
    ["show my notes", "notes"],
    ["open the calendar", "calendar"],
    ["show me my week", "calendar"],
    ["show runs", "runs"],
    ["view my agent runs", "runs"],
    ["show my decisions", "decisions"],
    ["open the review queue", "decisions"],
    ["open my library", "library"],
  ])("routes %j to the %s surface", (message, surface) => {
    expect(parseNavigationIntent(message)).toEqual({ kind: "surface", surface });
  });

  it("trims trailing punctuation before matching", () => {
    expect(parseNavigationIntent("Show me my open tasks!")).toEqual({ kind: "surface", surface: "tasks" });
  });

  it("parses open-note intents and keeps the query", () => {
    expect(parseNavigationIntent("open the note about API design")).toEqual({
      kind: "open_note",
      query: "API design",
    });
    expect(parseNavigationIntent("Find note titled weekly plan")).toEqual({
      kind: "open_note",
      query: "weekly plan",
    });
  });

  it("ignores note queries that are too short to search honestly", () => {
    expect(parseNavigationIntent("open note x")).toBeNull();
  });

  it("returns null for ordinary conversation", () => {
    expect(parseNavigationIntent("what did I capture yesterday?")).toBeNull();
    expect(parseNavigationIntent("summarize the working memory spec")).toBeNull();
  });

  it("every surface has a real destination and label", () => {
    for (const surface of Object.keys(SURFACE_HREF) as Array<keyof typeof SURFACE_HREF>) {
      expect(SURFACE_HREF[surface]).toMatch(/^\//);
      expect(SURFACE_LABEL[surface].length).toBeGreaterThan(0);
    }
  });
});
