import { describe, expect, it } from "vitest";
import {
  NOTEBOOK_CHAT_OBJECTIVE_PREFIX,
  isNotebookChatObjective,
  notebookChatObjective,
} from "@/domains/knowledge/notebook-chat";

/*
 * The chat-vs-Studio contract (ASH-179). A notebook chat is a run bound to the
 * dossier, same as a Studio Generate run; the objective prefix is the only
 * marker that tells them apart, and three readers depend on it agreeing:
 * startNotebookRun (writes), listNotebookChats (history), and the Studio Runs
 * panel (excludes chats). These tests pin the contract so an edit to the
 * wording breaks loudly here rather than silently misclassifying runs.
 */

describe("notebook chat objective contract", () => {
  it("classifies exactly the objectives startNotebookRun writes", () => {
    const objective = notebookChatObjective("Housing");
    expect(isNotebookChatObjective(objective)).toBe(true);
    expect(objective.startsWith(NOTEBOOK_CHAT_OBJECTIVE_PREFIX)).toBe(true);
    expect(objective).toContain('"Housing"');
    expect(objective).toContain("Cite the sources");
  });

  it("does not classify Studio Generate objectives as chats", () => {
    // The generation briefs open with "Using only the documents in the
    // dossier", never the chat prefix.
    expect(isNotebookChatObjective('Using only the documents in the dossier "Housing", write a draft report: x.')).toBe(false);
    expect(isNotebookChatObjective("Draft")).toBe(false);
    expect(isNotebookChatObjective("")).toBe(false);
  });

  it("the prefix is a safe LIKE pattern (no wildcards)", () => {
    expect(NOTEBOOK_CHAT_OBJECTIVE_PREFIX).not.toMatch(/[%_]/);
  });
});
