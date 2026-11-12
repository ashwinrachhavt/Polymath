import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthContext } from "@/lib/auth";
import { countDocumentInbox, getDocumentInbox, getDocumentReview } from "@/domains/knowledge/queries";
import { listRecentRuns } from "@/domains/agents/queries";
import { listProjects } from "@/domains/knowledge/projects";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { KnowledgeSurface } from "@/app/(workspace)/polymath/knowledge/page";
import { PolymathSurface } from "@/app/(workspace)/polymath/page";
import { UpNextCard, UpNextContent } from "@/app/(workspace)/polymath/up-next-card";
import { getUpNext } from "@/domains/learning/up-next";
import { ProjectsSurface } from "@/app/(workspace)/projects/page";
import { getVaultDocuments } from "@/domains/knowledge/vault-queries";
import { listFolders } from "@/domains/knowledge/library";

vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/auth", () => ({ getAuthContext: vi.fn() }));
vi.mock("@/domains/knowledge/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domains/knowledge/queries")>()),
  getDocumentInbox: vi.fn(),
  getDocumentReview: vi.fn(),
  countDocumentInbox: vi.fn(),
}));
// The list toolbar and pager read router state; static markup has no app router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/polymath",
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
  unstable_rethrow: vi.fn(),
}));
vi.mock("@/domains/conversations/queries", () => ({ listConversations: vi.fn(async () => []) }));
vi.mock("@/domains/knowledge/projects", () => ({
  listProjects: vi.fn(async () => []),
  projectDocumentIds: vi.fn(async () => []),
  getProjectDetail: vi.fn(async () => null),
}));
vi.mock("@/domains/knowledge/studio", () => ({
  draftsForRuns: vi.fn(async () => new Map()),
  getDraftDetail: vi.fn(async () => null),
}));
vi.mock("@/domains/knowledge/parties", () => ({ resolvePartyCandidates: vi.fn(async () => []) }));
vi.mock("@/domains/knowledge/search", () => ({ searchDocuments: vi.fn(async () => []) }));
vi.mock("@/domains/knowledge/vault-queries", () => ({ getVaultDocuments: vi.fn(async () => []) }));
vi.mock("@/domains/knowledge/library", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domains/knowledge/library")>()),
  listFolders: vi.fn(async () => []),
}));
vi.mock("@/domains/knowledge/classify", () => ({ getOpenClassification: vi.fn(async () => null) }));
// The statement panel is its own domain read; the page test is about the
// document workbench, so it stubs the lookup rather than opening a database.
vi.mock("@/domains/knowledge/statement-import", () => ({ statementForDocument: vi.fn(async () => null) }));
vi.mock("@/domains/agents/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domains/agents/queries")>()),
  listRecentRuns: vi.fn(async () => []),
  listDocumentSearchResults: vi.fn(async () => new Map()),
  // The Assistant reads the profile's model for its picker; these tests render
  // the page without a database, so the read is stubbed like its neighbours.
  getProfileModelPolicy: vi.fn(async () => null),
}));
vi.mock("@/domains/agents/thread", () => ({
  listThreads: vi.fn(async () => new Map()),
  isFinished: (s: string) => ["succeeded", "failed", "cancelled"].includes(s),
}));
vi.mock("@/domains/agents/eve-driver", () => ({ eveBridgeUnavailableReason: vi.fn() }));
// The onboarding gate is a real database read on the page; these tests render
// the page without a database, so it is stubbed like its neighbours.
vi.mock("@/domains/agents/onboarding", () => ({
  isWorkspaceOnboarded: vi.fn(async () => true),
  // The one-time welcome read: null means nothing to welcome, so the home
  // keeps its plain greeting in every fixture below.
  findUnwelcomedOnboardingSession: vi.fn(async () => null),
}));
// The composer's skill picker reads the workspace's enabled skills; static
// markup has no database, so the read is stubbed like every other one here.
vi.mock("@/domains/skills/queries", () => ({ listSkills: vi.fn(async () => []) }));
// Up next is its own domain read (tests/integration/up-next.test.ts); a fresh
// workspace has nothing due, no quiz and no streak.
vi.mock("@/domains/learning/up-next", () => ({
  getUpNext: vi.fn(async () => ({ dueCards: 0, firstDue: null, quizWaiting: null, streakDays: 0, disagreement: null })),
}));

const document = {
  id: "doc-fixture",
  title: "Existing document",
  filename: "fixture.pdf",
  mimeType: "application/pdf",
  createdAt: new Date(),
  extractionStatus: "succeeded",
  extractionCreatedAt: null,
  proposalStatus: "succeeded",
  undecidedProposals: 0,
  partyNames: [],
  sourceUrl: null,
  kind: "file" as const,
  fetchedAt: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgres://fixture-unused");
  vi.mocked(getAuthContext).mockResolvedValue({ userId: "owner", workspaceId: "workspace", role: "owner" });
  vi.mocked(getDocumentInbox).mockResolvedValue([]);
  vi.mocked(countDocumentInbox).mockResolvedValue(0);
  vi.mocked(getDocumentReview).mockResolvedValue(null);
  vi.mocked(getVaultDocuments).mockResolvedValue([]);
  vi.mocked(listFolders).mockResolvedValue([]);
  vi.mocked(listRecentRuns).mockResolvedValue([]);
  vi.mocked(eveBridgeUnavailableReason).mockReturnValue(null);
});
afterEach(() => vi.unstubAllEnvs());

async function knowledge(doc?: string) {
  return renderToStaticMarkup(await KnowledgeSurface({ searchParams: Promise.resolve({ doc }) }));
}

describe("live Alfred route functionality", () => {
  it("keeps one enabled upload affordance in both empty and populated vaults", async () => {
    const empty = await knowledge();
    expect(empty).toContain("Add your first document");
    expect(empty.match(/aria-label="New"/g)).toHaveLength(1);
    vi.mocked(getVaultDocuments).mockResolvedValue([
      {
        id: "doc-fixture",
        title: "Existing document",
        filename: "fixture.pdf",
        mimeType: "application/pdf",
        kind: "file" as const,
        reviewKey: "filed",
        undecidedProposals: 0,
        sourceUrl: null,
        updatedAt: new Date().toISOString(),
        sizeBytes: 1200,
        pageCount: 2,
        docType: null,
        href: "/polymath/knowledge?doc=doc-fixture",
      },
    ]);
    const populated = await knowledge();
    expect(populated).toContain("Existing document");
    expect(populated.match(/aria-label="New"/g)).toHaveLength(1);
    expect(populated).toContain('type="file"');
    expect(populated).toContain('aria-label="Grid view"');
  });

  it("says Needs review in the vault, not the review pipeline's field vocabulary", async () => {
    vi.mocked(getVaultDocuments).mockResolvedValue([
      {
        id: "doc-review",
        title: "Statement",
        filename: "statement.pdf",
        mimeType: "application/pdf",
        kind: "file" as const,
        reviewKey: "fields_not_proposed",
        undecidedProposals: 0,
        sourceUrl: null,
        updatedAt: new Date().toISOString(),
        sizeBytes: 1200,
        pageCount: 2,
        docType: "statement",
        href: "/polymath/knowledge?doc=doc-review",
      },
    ]);
    const html = await knowledge();
    expect(html).toContain("Needs review");
    expect(html).toContain("Bank statement");
    expect(html).not.toContain("Fields not proposed");
  });

  it("presents a captured URL as a web page, not a file row", async () => {
    vi.mocked(getVaultDocuments).mockResolvedValue([
      {
        id: "page-fixture",
        title: "Ashwin Rachha",
        filename: null,
        mimeType: "text/markdown",
        kind: "web_page" as const,
        reviewKey: "filed",
        undecidedProposals: 0,
        sourceUrl: "https://ashwinrachha.com/",
        updatedAt: new Date().toISOString(),
        sizeBytes: null,
        pageCount: null,
        docType: null,
        href: "/polymath/knowledge?doc=page-fixture",
      },
    ]);
    const html = await knowledge();
    expect(html).toContain("ashwinrachha.com");
    expect(html).not.toContain("fixture.pdf");
  });

  it("keeps upload available while reviewing an existing document", async () => {
    vi.mocked(getDocumentReview).mockResolvedValue({
      document: {
        id: document.id,
        title: document.title,
        docType: null,
        mimeType: document.mimeType,
        version: 1,
        sourceUrl: null,
      },
      extraction: {
        id: "extraction",
        status: "succeeded",
        contentHash: "fixture",
        error: null,
        proposalStatus: "succeeded",
        proposalError: null,
        proposer: "text-rules@1",
      },
      fieldProposals: [],
      parties: [],
      obligations: [],
    });
    const html = await knowledge(document.id);
    expect(html).toContain("Back to vault");
  });

  it("renders explicit configuration states, not crashes or fictitious empty data, without DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const documents = await knowledge();
    const agents = renderToStaticMarkup(await PolymathSurface());
    expect(documents).toContain("Knowledge storage is not configured");
    expect(documents).toContain("DATABASE_URL");
    expect(documents).toContain("BLOB_READ_WRITE_TOKEN");
    expect(documents).not.toContain("Upload a document");
    expect(agents).toContain("Agent storage is not configured");
    expect(agents).toContain("EVE_BASE_URL");
    expect(agents).not.toContain("Start a run");
    expect(getAuthContext).not.toHaveBeenCalled();
    expect(getDocumentInbox).not.toHaveBeenCalled();
    expect(listRecentRuns).not.toHaveBeenCalled();
  });

  it("opens on the greeting and composer, and says when the agent bridge is unavailable", async () => {
    vi.mocked(eveBridgeUnavailableReason).mockReturnValue("Eve does not support verified Clerk identity yet.");
    const html = renderToStaticMarkup(await PolymathSurface());
    expect(html).toContain("What would you like to work on?");
    expect(html).toContain("Ask anything or describe a task…");
    expect(html).toContain("verified Clerk identity");
    // Every phrase the retired run-launcher screen carried. One list, so a
    // string that creeps back onto the home fails here and in the browser.
    for (const gone of [
      "Hand off work and inspect what it did",
      "Start a run",
      "No threads yet",
      "Recent runs",
      "You:",
      "Assistant:",
    ]) {
      expect(html, gone).not.toContain(gone);
    }
    // A fresh workspace gets no "Recent" heading and no empty-state box.
    expect(html).not.toContain(">Recent<");
    expect(html).not.toContain("No runs yet");
    // One query feeds both the five under the composer and the history menu,
    // so the limit is the menu's, not the glance's. Onboarding runs are
    // machinery, not conversations, and the home list never shows them.
    expect(listRecentRuns).toHaveBeenCalledWith("workspace", 50, { excludeOnboarding: true });
    // Up next now lives on the Activity page; the home keeps its greeting as
    // the screen's one h1.
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("Up next with nothing to learn yet leads to Learn and mentions no streak", async () => {
    const auth = { userId: "owner", workspaceId: "workspace", role: "owner" as const };
    const html = renderToStaticMarkup(await UpNextContent({ auth }));
    expect(getUpNext).toHaveBeenCalledWith(auth);
    expect(html).toContain("No cards due");
    expect(html).toContain('href="/learn"');
    expect(html).not.toContain("streak");
    expect(html).not.toMatch(/<h[1-6]/);
  });

  it("Up next says it did not load when a learning read fails, instead of claiming nothing is due", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(getUpNext).mockRejectedValueOnce(new Error("time zone not recognized"));
    const html = renderToStaticMarkup(
      await UpNextContent({ auth: { userId: "owner", workspaceId: "workspace", role: "owner" } }),
    );
    expect(html).toContain("Your flashcards and quizzes did not load. Reload the page to try again.");
    expect(html).not.toContain("No cards due");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("Up next continues with the due deck first, then the waiting quiz, and shows the streak", () => {
    const quizWaiting = { quizId: "quiz-1", title: "Lease", href: "/projects/nb-2/notebook?quiz=quiz-1" };
    const due = renderToStaticMarkup(
      UpNextCard({
        upNext: {
          dueCards: 12,
          firstDue: { notebookId: "nb-1", deckId: "deck-1" },
          quizWaiting,
          streakDays: 4,
          disagreement: null,
        },
      }),
    );
    expect(due).toContain('href="/projects/nb-1/notebook/flashcards?deck=deck-1"');
    expect(due).toContain("12 cards due · 4-day streak");

    const looseDeck = renderToStaticMarkup(
      UpNextCard({
        upNext: {
          dueCards: 3,
          firstDue: { notebookId: null, deckId: "deck-2" },
          quizWaiting,
          streakDays: 0,
          disagreement: null,
        },
      }),
    );
    expect(looseDeck).toContain('href="/learn/decks/deck-2"');

    const quiz = renderToStaticMarkup(
      UpNextCard({ upNext: { dueCards: 0, firstDue: null, quizWaiting, streakDays: 1, disagreement: null } }),
    );
    expect(quiz).toContain('href="/projects/nb-2/notebook?quiz=quiz-1"');
    expect(quiz).toContain("Take the quiz on Lease.");
    expect(quiz).toContain("No cards due · 1-day streak");
  });

  it("Up next puts two disagreeing ideas after due cards and before the waiting quiz", () => {
    const quizWaiting = { quizId: "quiz-1", title: "Lease", href: "/projects/nb-2/notebook?quiz=quiz-1" };
    const disagreement = { findingId: "f-1", firstTitle: "Rent is weekly", secondTitle: "Rent is monthly", open: 2 };
    const settle = renderToStaticMarkup(
      UpNextCard({ upNext: { dueCards: 0, firstDue: null, quizWaiting, streakDays: 0, disagreement } }),
    );
    expect(settle).toContain('href="/polymath/ideas?tidy=f-1#tidy-f-1"');
    expect(settle).toContain(
      "Two ideas disagree: &quot;Rent is weekly&quot; and &quot;Rent is monthly&quot;. Decide which holds.",
    );
    expect(settle).toContain("No cards due · 2 disagreements to settle");

    const due = renderToStaticMarkup(
      UpNextCard({
        upNext: {
          dueCards: 3,
          firstDue: { notebookId: "nb-1", deckId: "deck-1" },
          quizWaiting,
          streakDays: 0,
          disagreement,
        },
      }),
    );
    expect(due).toContain('href="/projects/nb-1/notebook/flashcards?deck=deck-1"');
    expect(due).toContain("3 cards due · 2 disagreements to settle");
  });

  it("lists recent runs as plain rows: objective and time, no status vocabulary", async () => {
    vi.mocked(eveBridgeUnavailableReason).mockReturnValue(null);
    vi.mocked(listRecentRuns).mockResolvedValue([
      {
        id: "run-waiting",
        state: "waiting_approval",
        objective: "Draft the renewal letter",
        model: "m",
        summary: null,
        error: null,
        createdAt: new Date(),
      },
      {
        id: "run-done",
        state: "succeeded",
        objective: "Reconcile the invoices",
        model: "m",
        summary: "Done.",
        error: null,
        createdAt: new Date(),
      },
    ] as never);
    const html = renderToStaticMarkup(await PolymathSurface());
    expect(html).toContain('href="/polymath/run-waiting"');
    expect(html).toContain("Draft the renewal letter");
    expect(html).toContain("Reconcile the invoices");
    // The waiting-on-you vocabulary moved to Reviews; the home list is not a
    // second decision surface.
    expect(html).not.toContain("Needs your reply");
    // One status, in the owner's words: no enum label or second badge beside it.
    for (const other of ["Running", "In progress", "Queued", "Succeeded", "waiting_approval", "succeeded"]) {
      expect(html, other).not.toContain(other);
    }
    // No model names, summaries, or transcript prefixes on a recent row.
    expect(html).not.toContain("You:");
    expect(html).not.toContain("Assistant:");
    expect(html).not.toContain("Done.");
  });
});

async function projects() {
  return renderToStaticMarkup(await ProjectsSurface());
}

describe("live projects screen", () => {
  it("reads Neon: an empty workspace gets the invitation, not the preview", async () => {
    const html = await projects();
    expect(html).toContain("No projects yet");
    expect(html).toContain("New project");
    expect(html).not.toContain("PolymathScreen");
  });

  it("lists projects with titles in the sections", async () => {
    vi.mocked(listProjects).mockResolvedValue([
      {
        id: "d1",
        title: "Rental papers",
        emoji: null,
        description: null,
        pinnedAt: null,
        updatedAt: new Date(),
        documentCount: 2,
      },
    ] as never);
    const html = await projects();
    expect(html).toContain("Rental papers");
    expect(html).toContain("Your projects");
  });
});
