import { describe, expect, it, vi } from "vitest";
import {
  COMPLETION_BEFORE_CHARS,
  cleanCompletion,
  completeWriting,
  completionPrompt,
} from "@/domains/knowledge/writing-completion";
import type { GenerationProvider } from "@/integrations/generation/provider";

/*
 * Value: protects=a suggestion joins the note exactly (mid-word, next word, after punctuation), is one
 * short line, and is dropped when it repeats the note or is not a continuation; fails_when=the join
 * adds or loses a space, a repeat or a chatty reply is shown, or the caps stop applying;
 * why_new=the completion module is new; seam=none; no_claim=suggestion quality from a real model
 */

describe("cleanCompletion", () => {
  const cases: [name: string, raw: string, before: string, after: string, expected: string][] = [
    [
      "finishes a word the reply echoed",
      "interesting idea worth exploring.",
      "This is an interes",
      "",
      "ting idea worth exploring.",
    ],
    [
      "starts the next word after an echoed word",
      "notes should be atomic.",
      "Evergreen notes",
      "",
      " should be atomic.",
    ],
    ["matches the echo whatever the case", "world peace", "Hello Wor", "", "ld peace"],
    ["finishes a word inside a quote", "wait for me", 'He said "wai', "", "t for me"],
    [
      "begins a word after a space",
      "  to write less and think more.\nA second line",
      "The goal is ",
      "",
      "to write less and think more.",
    ],
    [
      "adds the space a new word needs when nothing was echoed",
      "is to write less.",
      "The goal",
      "",
      " is to write less.",
    ],
    ["keeps punctuation tight against the word", ", in short, is clarity.", "The goal", "", ", in short, is clarity."],
    [
      "adds a space after a finished sentence",
      "Next comes the review.",
      "The draft is done.",
      "",
      " Next comes the review.",
    ],
    ["adds no space after an opening bracket", "see the appendix)", "The data (", "", "see the appendix)"],
    [
      "drops a repeat of the text before the cursor",
      "should be atomic and linked.",
      "Notes should be atomic",
      "",
      " and linked.",
    ],
    ["keeps one sentence", "is short. And then it rambles on for a while.", "The rule ", "", "is short."],
    ["shows nothing for a chatty reply", "Sure, here is the continuation: more text", "The goal is ", "", ""],
    [
      "shows nothing when the text after the cursor already says it",
      "on Friday.",
      "We ship ",
      "on Friday. Then we rest.",
      "",
    ],
    ["shows nothing for punctuation alone", "...", "The goal is ", "", ""],
    ["unwraps a fenced reply", "```\nto ship it\n```", "The goal is ", "", "to ship it"],
  ];
  it.each(cases)("%s", (_name, raw, before, after, expected) => {
    expect(cleanCompletion(raw, before, after)).toBe(expected);
  });

  it("caps a run-on reply at 24 words", () => {
    const raw = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    expect(cleanCompletion(raw, "Start ", "").split(" ")).toHaveLength(24);
  });
});

describe("completeWriting", () => {
  const provider = (text: string) => {
    const generate = vi.fn(
      async (input: { prompt: string; maxTokens?: number; signal?: AbortSignal }) => (void input, { text }),
    );
    // "stub" has no registry entry, so the quota ledger (and the database) is not involved.
    return { generate, provider: { name: "stub:model", registryId: "stub", generate } as GenerationProvider };
  };
  const auth = { workspaceId: "w1" };

  it("sends a bounded window around the cursor and returns the cleaned continuation", async () => {
    const { generate, provider: stub } = provider("notes should be atomic.");
    const before = `${"x".repeat(5_000)} Evergreen notes`;
    const out = await completeWriting(auth, { title: "Method", before, after: "tail" }, { provider: stub });
    expect(out).toEqual({ completion: " should be atomic." });
    const input = generate.mock.calls[0][0];
    expect(input.prompt).toContain("Note title: Method");
    expect(input.prompt).toContain(`<before>${before.slice(-COMPLETION_BEFORE_CHARS)}</before>`);
    expect(input.prompt).toContain("<after>tail</after>");
    expect(input.maxTokens).toBeGreaterThan(0);
    expect(input.signal).toBeInstanceOf(AbortSignal);
  });

  it("makes no model call when there is too little to continue", async () => {
    const { generate, provider: stub } = provider("anything");
    expect(await completeWriting(auth, { before: " a " }, { provider: stub })).toEqual({ completion: "" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("leaves the title line out when the note has none", () => {
    expect(completionPrompt({ before: "a", after: "" })).not.toContain("Note title");
  });
});
