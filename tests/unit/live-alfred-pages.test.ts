import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthContext } from "@/lib/auth";
import { countDocumentInbox, getDocumentInbox, getDocumentReview } from "@/domains/knowledge/queries";
import { listRecentRuns } from "@/domains/agents/queries";
import { listAttachableDocuments, listDossiers } from "@/domains/knowledge/dossiers";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { KnowledgeSurface } from "@/app/(workspace)/alfred/knowledge/page";
import { AlfredSurface } from "@/app/(workspace)/alfred/page";
import { DossiersSurface } from "@/app/(workspace)/alfred/dossiers/page";
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
  usePathname: () => "/alfred",
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
}));
vi.mock("@/domains/knowledge/zettels", () => ({ listZettelProposals: vi.fn(async () => []) }));
vi.mock("@/domains/conversations/queries", () => ({ listConversations: vi.fn(async () => []) }));
vi.mock("@/domains/knowledge/dossiers", () => ({ listDossiers: vi.fn(async () => []), dossierDocumentIds: vi.fn(async () => []), getDossierDetail: vi.fn(async () => null), listAttachableDocuments: vi.fn(async () => []), listDossierRuns: vi.fn(async () => []) }));
vi.mock("@/domains/knowledge/studio", () => ({ draftsForRuns: vi.fn(async () => new Map()), getDraftDetail: vi.fn(async () => null) }));
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
vi.mock("@/domains/agents/thread", () => ({ listThreads: vi.fn(async () => new Map()), isFinished: (s: string) => ["succeeded", "failed", "cancelled"].includes(s) }));
vi.mock("@/domains/agents/eve-driver", () => ({ eveBridgeUnavailableReason: vi.fn() }));
// The onboarding gate is a real database read on the page; these tests render
// the page without a database, so it is stubbed like its neighbours.
vi.mock("@/domains/agents/onboarding", () => ({ isWorkspaceOnboarded: vi.fn(async () => true) }));
// The composer's skill picker reads the workspace's enabled skills; static
// markup has no database, so the read is stubbed like every other one here.
vi.mock("@/domains/skills/queries", () => ({ listSkills: vi.fn(async () => []) }));

const document = {
  id: "doc-fixture", title: "Existing document", filename: "fixture.pdf", mimeType: "application/pdf", createdAt: new Date(),
  extractionStatus: "succeeded",
        extractionCreatedAt: null, proposalStatus: "succeeded", undecidedProposals: 0, partyNames: [],
  sourceUrl: null, kind: "file" as const, fetchedAt: null,
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
    expect(empty).toContain("The vault is empty");
    expect(empty.match(/aria-label="New"/g)).toHaveLength(1);
    vi.mocked(getVaultDocuments).mockResolvedValue([
      {
        id: "doc-fixture", title: "Existing document", filename: "fixture.pdf",
        mimeType: "application/pdf", kind: "file" as const,
        status: { label: "Filed", tone: "done" as const }, sourceUrl: null,
        updatedAt: new Date().toISOString(), sizeBytes: 1200, pageCount: 2, docType: null,
        href: "/alfred/knowledge?doc=doc-fixture",
      },
    ]);
    const populated = await knowledge();
    expect(populated).toContain("Existing document");
    expect(populated.match(/aria-label="New"/g)).toHaveLength(1);
    expect(populated).toContain('type="file"');
  });

  it("presents a captured URL as a web page, not a file row", async () => {
    vi.mocked(getVaultDocuments).mockResolvedValue([
      {
        id: "page-fixture", title: "Ashwin Rachha", filename: null,
        mimeType: "text/markdown", kind: "web_page" as const,
        status: { label: "Filed", tone: "done" as const },
        sourceUrl: "https://ashwinrachha.com/",
        updatedAt: new Date().toISOString(), sizeBytes: null, pageCount: null, docType: null,
        href: "/alfred/knowledge?doc=page-fixture",
      },
    ]);
    const html = await knowledge();
    expect(html).toContain("ashwinrachha.com");
    expect(html).not.toContain("fixture.pdf");
  });

  it("keeps upload available while reviewing an existing document", async () => {
    vi.mocked(getDocumentReview).mockResolvedValue({
      document: { id: document.id, title: document.title, docType: null, mimeType: document.mimeType, version: 1, sourceUrl: null },
      extraction: { id: "extraction", status: "succeeded", contentHash: "fixture", error: null, proposalStatus: "succeeded", proposalError: null, proposer: "text-rules@1" },
      fieldProposals: [], parties: [], obligations: [],
    });
    const html = await knowledge(document.id);
    expect(html).toContain("Back to vault");
  });

  it("renders explicit configuration states, not crashes or fictitious empty data, without DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const documents = await knowledge();
    const agents = renderToStaticMarkup(await AlfredSurface());
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
    const html = renderToStaticMarkup(await AlfredSurface());
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
    // so the limit is the menu's, not the glance's.
    expect(listRecentRuns).toHaveBeenCalledWith("workspace", 50);
  });

  it("lists recent runs as plain rows: objective and time, no status vocabulary", async () => {
    vi.mocked(eveBridgeUnavailableReason).mockReturnValue(null);
    vi.mocked(listRecentRuns).mockResolvedValue([
      { id: "run-waiting", state: "waiting_approval", objective: "Draft the renewal letter", model: "m", summary: null, error: null, createdAt: new Date() },
      { id: "run-done", state: "succeeded", objective: "Reconcile the invoices", model: "m", summary: "Done.", error: null, createdAt: new Date() },
    ] as never);
    const html = renderToStaticMarkup(await AlfredSurface());
    expect(html).toContain('href="/alfred/run-waiting"');
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

async function dossiers() {
  return renderToStaticMarkup(await DossiersSurface({ searchParams: Promise.resolve({}) }));
}

describe("live dossiers screen", () => {
  it("reads Neon: an empty workspace gets the invitation, not the preview", async () => {
    const html = await dossiers();
    expect(html).toContain("No notebooks yet");
    expect(html).toContain("New notebook");
    expect(html).not.toContain("AlfredScreen");
  });

  it("lists dossiers as links to their notebooks", async () => {
    vi.mocked(listDossiers).mockResolvedValue([
      { id: "d1", title: "Rental papers", documentCount: 2 },
    ] as never);
    const html = await dossiers();
    expect(html).toContain("Rental papers");
    expect(html).toContain("2 documents");
    expect(html).toContain("/alfred/dossiers/d1/notebook");
  });

  it("creating a notebook is naming it: no document picker", async () => {
    vi.mocked(listAttachableDocuments).mockResolvedValue([
      { id: "doc1", title: "Lease" },
      { id: "doc2", title: "Inspection" },
    ] as never);
    const html = await dossiers();
    expect(html).toContain("Name the notebook");
    expect(html).not.toContain("Lease");
    expect(html).not.toContain("Inspection");
    expect(listAttachableDocuments).not.toHaveBeenCalled();
  });
});
