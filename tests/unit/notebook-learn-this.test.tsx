import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The Notebook's one learning action (consolidation Task 4.2). Learn this
 * opens a sheet with Quiz, Flashcards and Explain It; the default sends every
 * ready source and no count, so the server sizes the set from the sources;
 * Adjust holds the source checkboxes and an exact 5-100 count. Results show
 * the latest of each as a card that opens in place.
 *
 * Value: protects=the default path needing no choices, the sheet handing a
 * quiz or deck over instead of holding the learner, and results opening where
 * they were made; fails_when=Create sends a hard-coded count or a single
 * source, an out-of-range count reaches the server, the sheet stays open or
 * shows no row once the work is accepted, or a deck card navigates away
 * instead of opening in place; seam=the client components
 * under jsdom with the server actions mocked; no_claim=generation itself
 * (tests/integration/flashcards-batching.test.ts) and the revalidated server
 * render (tests/e2e/learn-loop.spec.ts).
 */

const actions = vi.hoisted(() => ({
  make: vi.fn(),
  explain: vi.fn(),
  rate: vi.fn(),
}));

vi.mock("@/app/(workspace)/projects/[projectId]/notebook/learning-actions", () => ({
  makeNotebookLearningAction: actions.make,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/projects/p/notebook",
}));
vi.mock("@/domains/jobs/actions", () => ({
  retryGenerationJobAction: vi.fn(),
  dismissGenerationJobAction: vi.fn(),
  startWaitingGenerationJobAction: vi.fn(),
}));
vi.mock("@/app/(workspace)/projects/[projectId]/notebook/flashcard-actions", () => ({
  rateNotebookFlashcardAction: actions.rate,
}));
vi.mock("@/app/(workspace)/projects/[projectId]/notebook/explain-actions", () => ({
  startNotebookExplainItAction: actions.explain,
  answerNotebookExplainItAction: vi.fn(),
}));
vi.mock("@/components/feedback/rate-output-action", () => ({ rateOutputAction: vi.fn() }));
vi.mock("@/app/(workspace)/learn/actions", () => ({ completeQuizAttemptAction: vi.fn() }));

const { LearningStudio: LearningStudioView } =
  await import("@/app/(workspace)/projects/[projectId]/notebook/learning-studio");
const { useSurfaceJobs } = await import("@/components/jobs/generation-job-rows");
const { LEARNING_JOB_KIND_PREFIX, learningJobSubject } = await import("@/domains/learning/job-names");
const { LearningResults } = await import("@/app/(workspace)/projects/[projectId]/notebook/learning-results");

const PROJECT = "11111111-1111-4111-8111-111111111111";

/** The page owns the jobs hook (so the rail can show a dot while they run); the tests mount it the same way. */
function LearningStudio({
  projectId,
  sources,
}: {
  projectId: string;
  sources: { documentId: string; title: string }[];
}) {
  const surface = useSurfaceJobs([], {
    kindPrefix: LEARNING_JOB_KIND_PREFIX,
    subject: learningJobSubject.notebook(projectId),
  });
  return <LearningStudioView projectId={projectId} sources={sources} surface={surface} />;
}
const SOURCES = [
  { documentId: "22222222-2222-4222-8222-222222222222", title: "Chapter one" },
  { documentId: "33333333-3333-4333-8333-333333333333", title: "Chapter two" },
];

const accepted = {
  id: "job-1",
  kind: "learning.flashcards",
  subject: `notebook:${PROJECT}`,
  status: "queued" as const,
  title: "Flashcards: Chapter one + 1 more",
  attempt: 1,
  href: null,
  notice: null,
  error: null,
  createdAt: "2026-11-11T10:00:00.000Z",
  updatedAt: "2026-11-11T10:00:00.000Z",
};

beforeEach(() => {
  for (const action of Object.values(actions)) action.mockReset();
});

function openSheet() {
  fireEvent.click(screen.getByRole("button", { name: "Learn this" }));
  return screen.getByRole("dialog", { name: "Learn this" });
}

describe("Learn this", () => {
  it("offers Quiz, Flashcards and Explain It, and the default uses every ready source with no count", async () => {
    actions.make.mockResolvedValue({ ok: true, job: accepted });
    render(<LearningStudio projectId={PROJECT} sources={SOURCES} />);

    const sheet = openSheet();
    expect(within(sheet).getByText("Uses all 2 ready sources.")).toBeTruthy();
    for (const name of [/Quiz/, /Flashcards/, /Explain It/])
      expect(within(sheet).getByRole("radio", { name })).toBeTruthy();

    fireEvent.click(within(sheet).getByRole("radio", { name: /Flashcards/ }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(actions.make).toHaveBeenCalledTimes(1));
    const sent = actions.make.mock.calls[0][0];
    expect(sent.projectId).toBe(PROJECT);
    expect(sent.kind).toBe("flashcards");
    expect(sent.documentIds).toEqual(SOURCES.map((source) => source.documentId));
    expect(sent.count).toBeUndefined();
    expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    // The sheet hands the work over: it closes, and a row says the deck is on its way.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Learn this" })).toBeNull());
    expect(screen.getByText("Flashcards: Chapter one + 1 more")).toBeTruthy();
    expect(screen.getByText("Waiting to start. You can leave this page.")).toBeTruthy();
  });

  it("Adjust sends exactly the chosen sources and count", async () => {
    actions.make.mockResolvedValue({ ok: true, job: accepted });
    render(<LearningStudio projectId={PROJECT} sources={SOURCES} />);

    const sheet = openSheet();
    fireEvent.click(within(sheet).getByText("Adjust"));
    fireEvent.click(within(sheet).getByRole("checkbox", { name: "Chapter one" }));
    fireEvent.change(within(sheet).getByRole("spinbutton", { name: /How many questions/ }), {
      target: { value: "30" },
    });
    expect(within(sheet).getByText("Uses 1 of 2 ready sources.")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(actions.make).toHaveBeenCalledTimes(1));
    expect(actions.make.mock.calls[0][0]).toMatchObject({
      kind: "quiz",
      documentIds: [SOURCES[1].documentId],
      count: 30,
    });
  });

  it("holds Create back, with the reason, for a count outside 5 to 100 or no source", () => {
    render(<LearningStudio projectId={PROJECT} sources={SOURCES} />);
    const sheet = openSheet();
    fireEvent.click(within(sheet).getByText("Adjust"));
    fireEvent.change(within(sheet).getByRole("spinbutton", { name: /How many questions/ }), {
      target: { value: "101" },
    });
    expect(within(sheet).getByText("Choose a number from 5 to 100, or leave it blank.")).toBeTruthy();
    expect((within(sheet).getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(sheet).getByRole("spinbutton", { name: /How many questions/ }), { target: { value: "" } });
    for (const source of SOURCES) fireEvent.click(within(sheet).getByRole("checkbox", { name: source.title }));
    expect(within(sheet).getByText("Choose at least one source.")).toBeTruthy();
    expect((within(sheet).getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    expect(actions.make).not.toHaveBeenCalled();
  });

  it("says why nothing can be made before a source is ready", () => {
    render(<LearningStudio projectId={PROJECT} sources={[]} />);
    const sheet = openSheet();
    expect(within(sheet).getByText("A source must finish reading before it can be studied.")).toBeTruthy();
    expect((within(sheet).getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the server's reason when making fails", async () => {
    actions.explain.mockResolvedValue({ ok: false, error: "Choose sources that belong to this notebook." });
    render(<LearningStudio projectId={PROJECT} sources={SOURCES} />);
    const sheet = openSheet();
    fireEvent.click(within(sheet).getByRole("radio", { name: /Explain It/ }));
    // Explain It sets its own length: no count to adjust.
    fireEvent.click(within(sheet).getByText("Adjust"));
    expect(within(sheet).queryByRole("spinbutton")).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Choose sources that belong to this notebook.")).toBeTruthy();
  });
});

describe("Results", () => {
  const card = (n: number) => ({
    id: `c${n}`,
    prompt: `Prompt ${n}`,
    answer: `Answer ${n}`,
    evidence: {
      quote: `Quote ${n}`,
      source: { documentId: SOURCES[0].documentId, extractionId: "e", title: "Chapter one" },
    },
    dueAt: new Date("2026-11-10T00:00:00Z"),
  });

  it("shows the latest deck as a card that opens in place", () => {
    render(
      <LearningResults
        projectId={PROJECT}
        results={{
          quiz: null,
          explain: null,
          deck: {
            id: "deck-1",
            title: "Chapter one flashcards",
            ago: "just now",
            cardCount: 8,
            note: "The sources support no more.",
            dueCards: [card(1), card(2)],
            rating: null,
          },
        }}
        initiallyOpen={null}
      />,
    );
    const results = screen.getByRole("region", { name: "Results" });
    const deck = within(results).getByRole("article", { name: "Flashcards: Chapter one flashcards" });
    expect(within(deck).getByText("8 cards")).toBeTruthy();
    expect(within(deck).getByText("The sources support no more.")).toBeTruthy();
    expect(within(deck).queryByText("Card 1 of 2")).toBeNull();

    const open = within(deck).getByRole("button", { name: "Open result" });
    expect(open.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(open);
    expect(within(deck).getByText("Card 1 of 2")).toBeTruthy();
    expect(within(deck).getByRole("button", { name: "Close result" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("says what Learn this makes when nothing is made yet", () => {
    render(
      <LearningResults projectId={PROJECT} results={{ quiz: null, deck: null, explain: null }} initiallyOpen={null} />,
    );
    expect(
      within(screen.getByRole("region", { name: "Results" })).getByText(
        "Nothing made yet. Learn this makes a quiz, flashcards or an Explain It session from your sources.",
      ),
    ).toBeTruthy();
  });
});
