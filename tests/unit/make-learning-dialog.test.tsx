import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The Make flashcards or a quiz dialog, opened from Learn or with inbox
 * captures in hand.
 *
 * Value: protects=a retry after a failure actually retrying, the learner
 * hearing about sources left out of the request and about a deck or quiz
 * that came out short; fails_when=a retry replays the failed request's key,
 * extra picks are dropped without a word, or a short result navigates in
 * silence; seam=the client component under jsdom with the server actions,
 * the router and the workspace notice mocked; no_claim=what the server does
 * with a key (tests/integration/make-learning-action.test.ts).
 */

const mocks = vi.hoisted(() => ({
  make: vi.fn(),
  find: vi.fn(),
  push: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("@/app/(workspace)/learn/make-actions", () => ({
  makeFlashcardsOrQuizAction: mocks.make,
  findLearningSourcesAction: mocks.find,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/components/workspace/workspace-provider", () => ({ useWorkspace: () => ({ notify: mocks.notify }) }));

const { MakeLearningButton } = await import("@/app/(workspace)/learn/make-learning-dialog");

function capture(n: number) {
  return {
    type: "capture" as const,
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    version: 1,
    title: `Capture ${n}`,
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.find.mockResolvedValue({ ok: true, documents: [], captures: [] });
});

function open(sources: ReturnType<typeof capture>[]) {
  render(<MakeLearningButton initialSources={sources}>Make</MakeLearningButton>);
  fireEvent.click(screen.getByRole("button", { name: "Make" }));
  return screen.getByRole("dialog");
}

describe("MakeLearningButton", () => {
  it("sends a fresh key when the learner tries again after a failure", async () => {
    mocks.make
      .mockResolvedValueOnce({ ok: false, error: "The quiz generator did not answer. Try again in a moment." })
      .mockResolvedValueOnce({ ok: true, href: "/learn/quizzes/q", notice: null });
    const dialog = open([capture(1)]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Make flashcards" }));
    await within(dialog).findByText("The quiz generator did not answer. Try again in a moment.");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Make flashcards" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/learn/quizzes/q"));

    const [first, second] = mocks.make.mock.calls.map(([input]) => input.idempotencyKey);
    expect(second).not.toBe(first);
  });

  it("says how many picked sources were left out of a request", () => {
    const dialog = open(Array.from({ length: 12 }, (_, i) => capture(i + 1)));

    expect(within(dialog).getByText("8 of 8 sources picked.")).toBeTruthy();
    expect(within(dialog).getByText(/4 more selected were left out/)).toBeTruthy();
  });

  it("tells the learner when a result came out short, and still opens it", async () => {
    mocks.make.mockResolvedValue({
      ok: true,
      href: "/learn/decks/d",
      notice: "Made 8 of 30 flashcards before a batch failed. Make them again for more.",
    });
    const dialog = open([capture(1)]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Make flashcards" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/learn/decks/d"));
    expect(mocks.notify).toHaveBeenCalledWith(
      "Made 8 of 30 flashcards before a batch failed. Make them again for more.",
    );
  });
});
