import { describe, expect, it, vi } from "vitest";
import { defaultFlashcardGenerator } from "@/integrations/learning/flashcard-generator";
import { defaultQuizGenerator } from "@/integrations/learning/quiz-generator";

vi.mock("@/domains/billing/resolver", async () =>
  (await import("../helpers/house-generation-resolver")).houseGenerationResolver(),
);

/*
 * A long source is read through a different window on each batch, so a large
 * request is not asked of the same first few thousand characters every time.
 * The provider is a fetch double; no network, no quota (no workspace id).
 */

const env: NodeJS.ProcessEnv = { NODE_ENV: "test", OPENROUTER_API_KEY: "k" };
const text = Array.from({ length: 2000 }, (_, n) => `Fact ${n} holds.`).join(" ");

function recordingFetch(content: unknown) {
  const sent: Array<{ system: string; user: string }> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    sent.push({
      system: body.messages.find((m) => m.role === "system")?.content ?? "",
      user: body.messages.find((m) => m.role === "user")?.content ?? "",
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  };
  return { fetchImpl, sent };
}

describe("learning generator windows", () => {
  it("flashcards: each part reads a different window and asks for an exact count", async () => {
    const { fetchImpl, sent } = recordingFetch({
      cards: [{ prompt: "What holds?", answer: "Fact 0.", quote: "Fact 0 holds.", sourceIndex: 0 }],
    });
    const generator = await defaultFlashcardGenerator("w1", env, fetchImpl);
    for (const part of [0, 1]) {
      await generator.generateFromSources([{ title: "Facts", text }], { cardCount: 25, part });
    }
    const windows = sent.map((call) => (JSON.parse(call.user) as { sources: Array<{ text: string }> }).sources[0].text);
    expect(windows[0]).toBe(text.slice(0, 9000));
    expect(windows[1]).not.toBe(windows[0]);
    expect(text.includes(windows[1])).toBe(true);
    expect(sent[0].system).toContain("Return exactly 25 cards when the sources support them.");
    expect(sent[0].system).not.toContain("up to");
  });

  it("quiz: a single long source reads a different window per part", async () => {
    const { fetchImpl, sent } = recordingFetch({
      questions: [
        {
          prompt: "What holds?",
          choices: [
            { value: "a", label: "Fact 0" },
            { value: "b", label: "Fact 1" },
          ],
          answerValue: "a",
          explanation: "The text says so.",
          quote: "Fact 0 holds.",
        },
      ],
    });
    const generator = await defaultQuizGenerator("w1", env, fetchImpl);
    await generator.generate(text, { questionCount: 25, part: 0 });
    await generator.generate(text, { questionCount: 25, part: 1 });
    expect(sent[0].user).toBe(text.slice(0, 12000));
    expect(sent[1].user).not.toBe(sent[0].user);
    expect(text.includes(sent[1].user)).toBe(true);
  });
});
