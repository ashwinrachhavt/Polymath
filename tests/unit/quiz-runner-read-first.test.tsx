import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuizForSitting } from "@/domains/learning/queries";

/*
 * Read first: a quiz with passages shows each passage on its own screen,
 * then the questions about it; the learner can turn that off before the
 * first answer, and the choice is remembered in this browser.
 *
 * Value: protects=reading before answering, the way back to the passage, and
 * a sitting that still submits every question once; fails_when=a question
 * shows before its passage, Re-read loses the question, the toggle does not
 * restore plain order or is not remembered, or a question is skipped or sent
 * twice; seam=the client runner under jsdom with the completion action
 * mocked; no_claim=how passages are cut (tests/unit/learning-quiz-passages.test.ts)
 * and server grading (tests/integration/learning-loop.test.ts).
 */

const complete = vi.hoisted(() => vi.fn());
vi.mock("@/app/(workspace)/learn/actions", () => ({ completeQuizAttemptAction: complete }));
vi.mock("@/app/(workspace)/artifacts/[artifactId]/artifact-feedback", () => ({ ArtifactFeedback: () => null }));

const { QuizRunner } = await import("@/app/(workspace)/learn/[documentId]/quiz-runner");

const TOGGLE = "Read the passage before each question";

function makeQuestion(n: number): QuizForSitting["questions"][number] {
  return {
    id: `q${n}`,
    ordinal: n,
    prompt: `Prompt ${n}?`,
    choices: [
      { value: "right", label: `Right ${n}` },
      { value: "wrong", label: `Wrong ${n}` },
    ],
    answerValue: "right",
    explanation: `Explanation ${n}.`,
    evidence: { quote: `quote ${n}`, startOffset: 0, endOffset: 7 },
  };
}

/** Reading order differs from ordinal order, and q4 has no passage. */
const QUIZ: QuizForSitting = {
  id: "quiz-1",
  notebookId: null,
  documentId: "doc-1",
  title: "Otters",
  sourceManifest: [],
  questions: [1, 2, 3, 4].map(makeQuestion),
  passages: [
    { id: "e:900", sourceTitle: "Field guide", body: "Otters hold hands while they sleep.", questionIds: ["q3"] },
    { id: "e:10", sourceTitle: "Field guide", body: "Otters eat sea urchins.", questionIds: ["q1", "q2"] },
  ],
};

beforeEach(() => {
  complete.mockReset();
  complete.mockResolvedValue({
    ok: true,
    result: {
      attemptId: "a",
      correctCount: 4,
      totalCount: 4,
      stoneEarned: true,
      emeraldEarned: true,
      replayed: false,
    },
    announcement: null,
  });
  window.localStorage.clear();
});

function answerAndGo(n: number, button: "Next question" | "Finish" = "Next question") {
  expect(screen.getByText(`Prompt ${n}?`)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: `Right ${n}` }));
  fireEvent.click(screen.getByRole("button", { name: button }));
}

function continuePast(body: string) {
  expect(screen.getByText(body)).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Answer choices" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("read-first quiz runner", () => {
  it("shows each passage before its questions, and submits every question once", async () => {
    render(<QuizRunner quiz={QUIZ} rating={null} />);

    expect(screen.getByText("Passage 1 of 2")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Read this first" }));
    // One source: its title is already the quiz title, so the passage does not repeat it.
    expect(screen.queryByText("From Field guide")).toBeNull();
    continuePast("Otters hold hands while they sleep.");
    expect(screen.getByText("Question 1 of 4")).toBeTruthy();
    answerAndGo(3);

    expect(screen.getByText("Passage 2 of 2")).toBeTruthy();
    continuePast("Otters eat sea urchins.");
    expect(screen.getByText("Question 2 of 4")).toBeTruthy();
    answerAndGo(1);
    answerAndGo(2);

    // No passage for q4: straight to the question.
    expect(screen.getByText("Question 4 of 4")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Re-read the passage" })).toBeNull();
    answerAndGo(4, "Finish");

    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    const sent = complete.mock.calls[0][0] as { answers: Array<{ questionId: string; selectedValue: string }> };
    expect(sent.answers.map((a) => a.questionId)).toEqual(["q3", "q1", "q2", "q4"]);
    expect(sent.answers.every((a) => a.selectedValue === "right")).toBe(true);
    expect(await screen.findByText("4 of 4")).toBeTruthy();
  });

  it("Re-read goes back to the passage and Continue returns to the same question", () => {
    render(<QuizRunner quiz={QUIZ} rating={null} />);
    continuePast("Otters hold hands while they sleep.");
    answerAndGo(3);
    continuePast("Otters eat sea urchins.");
    answerAndGo(1);

    // On q2, the second question of the second passage.
    expect(screen.getByText("Prompt 2?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Re-read the passage" }));
    expect(screen.queryByText("Prompt 2?")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Read this first" }));
    continuePast("Otters eat sea urchins.");
    expect(screen.getByText("Question 3 of 4")).toBeTruthy();
    expect(screen.getByText("Prompt 2?")).toBeTruthy();

    // Once answered, the way back is gone.
    fireEvent.click(screen.getByRole("button", { name: "Right 2" }));
    expect(screen.queryByRole("button", { name: "Re-read the passage" })).toBeNull();
  });

  it("with the toggle off, asks in ordinal order with no passages, and remembers the choice", async () => {
    const first = render(<QuizRunner quiz={QUIZ} rating={null} />);
    fireEvent.click(screen.getByRole("switch", { name: TOGGLE }));

    expect(screen.queryByText("Passage 1 of 2")).toBeNull();
    expect(screen.getByText("Question 1 of 4")).toBeTruthy();
    answerAndGo(1);
    // The order is fixed once the sitting has an answer.
    expect((screen.getByRole("switch", { name: TOGGLE }) as HTMLButtonElement).disabled).toBe(true);
    answerAndGo(2);
    answerAndGo(3);
    answerAndGo(4, "Finish");
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(complete.mock.calls[0][0].answers.map((a: { questionId: string }) => a.questionId)).toEqual([
      "q1",
      "q2",
      "q3",
      "q4",
    ]);
    first.unmount();

    render(<QuizRunner quiz={QUIZ} rating={null} />);
    expect(screen.getByRole("switch", { name: TOGGLE }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Prompt 1?")).toBeTruthy();
  });

  it("turning it back on before answering restarts at the first passage", () => {
    render(<QuizRunner quiz={QUIZ} rating={null} />);
    const toggle = () => screen.getByRole("switch", { name: TOGGLE });
    fireEvent.click(toggle());
    expect(screen.getByText("Prompt 1?")).toBeTruthy();
    fireEvent.click(toggle());
    expect(screen.getByText("Passage 1 of 2")).toBeTruthy();
  });

  it("without passages, runs exactly as before and offers no toggle", () => {
    render(<QuizRunner quiz={{ ...QUIZ, passages: [] }} rating={null} />);
    expect(screen.queryByRole("switch", { name: TOGGLE })).toBeNull();
    expect(screen.getByText("Question 1 of 4")).toBeTruthy();
    expect(screen.getByText("Prompt 1?")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Re-read the passage" })).toBeNull();
  });
});
