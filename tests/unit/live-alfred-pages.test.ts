import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthContext } from "@/lib/auth";
import { countDocumentInbox, getDocumentInbox, getDocumentReview } from "@/domains/knowledge/queries";
import { pageRuns } from "@/domains/agents/queries";
import { getDossierDetail, listAttachableDocuments, listDossiers } from "@/domains/knowledge/dossiers";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import { KnowledgeSurface } from "@/app/(workspace)/alfred/knowledge/page";
import { AlfredSurface } from "@/app/(workspace)/alfred/page";
import { DossiersSurface } from "@/app/(workspace)/alfred/dossiers/page";

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
vi.mock("@/domains/knowledge/dossiers", () => ({ listDossiers: vi.fn(async () => []), dossierDocumentIds: vi.fn(async () => []), getDossierDetail: vi.fn(async () => null), listAttachableDocuments: vi.fn(async () => []), listDossierRuns: vi.fn(async () => []) }));
vi.mock("@/domains/knowledge/studio", () => ({ draftsForRuns: vi.fn(async () => new Map()), getDraftDetail: vi.fn(async () => null) }));
vi.mock("@/domains/knowledge/parties", () => ({ resolvePartyCandidates: vi.fn(async () => []) }));
vi.mock("@/domains/knowledge/search", () => ({ searchDocuments: vi.fn(async () => []) }));
vi.mock("@/domains/agents/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domains/agents/queries")>()),
  pageRuns: vi.fn(),
  listDocumentSearchResults: vi.fn(async () => new Map()),
}));
vi.mock("@/domains/agents/thread", () => ({ listThreads: vi.fn(async () => new Map()), isFinished: (s: string) => ["succeeded", "failed", "cancelled"].includes(s) }));
vi.mock("@/domains/agents/eve-driver", () => ({ eveBridgeUnavailableReason: vi.fn() }));

const document = {
  id: "doc-fixture", title: "Existing document", filename: "fixture.pdf", mimeType: "application/pdf", createdAt: new Date(),
  extractionStatus: "succeeded", proposalStatus: "succeeded", undecidedProposals: 0, partyNames: [],
  sourceUrl: null, kind: "file" as const, fetchedAt: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgres://fixture-unused");
  vi.mocked(getAuthContext).mockResolvedValue({ userId: "owner", workspaceId: "workspace", role: "owner" });
  vi.mocked(getDocumentInbox).mockResolvedValue([]);
  vi.mocked(countDocumentInbox).mockResolvedValue(0);
  vi.mocked(getDocumentReview).mockResolvedValue(null);
  vi.mocked(pageRuns).mockResolvedValue({ items: [], total: 0 });
  vi.mocked(eveBridgeUnavailableReason).mockReturnValue(null);
});
afterEach(() => vi.unstubAllEnvs());

async function knowledge(doc?: string) {
  return renderToStaticMarkup(await KnowledgeSurface({ searchParams: Promise.resolve({ doc }) }));
}

describe("live Alfred route functionality", () => {
  it("keeps one enabled upload affordance in both empty and populated inboxes", async () => {
    const empty = await knowledge();
    expect(empty).toContain("No documents yet");
    expect(empty.match(/Upload a document/g)).toHaveLength(1);
    vi.mocked(getDocumentInbox).mockResolvedValue([document]);
    const populated = await knowledge();
    expect(populated).toContain("Existing document");
    expect(populated.match(/Upload a document/g)).toHaveLength(1);
    expect(populated).toContain('type="file"');
  });

  it("presents a captured URL as a web page, not a file row", async () => {
    vi.mocked(getDocumentInbox).mockResolvedValue([{
      ...document,
      id: "page-fixture", title: "Ashwin Rachha", filename: null, mimeType: "text/markdown",
      sourceUrl: "https://ashwinrachha.com/", kind: "web_page" as const, fetchedAt: new Date("2026-10-18T12:00:00Z"),
    }]);
    const html = await knowledge();
    expect(html).toContain("Web page · ashwinrachha.com");
    expect(html).toContain("Fetched");
    expect(html).not.toContain("No file");
  });

  it("keeps upload available while reviewing an existing document", async () => {
    vi.mocked(getDocumentInbox).mockResolvedValue([document]);
    vi.mocked(getDocumentReview).mockResolvedValue({
      document: { id: document.id, title: document.title, mimeType: document.mimeType, version: 1, sourceUrl: null },
      extraction: { id: "extraction", status: "succeeded", contentHash: "fixture", error: null, proposalStatus: "succeeded", proposalError: null, proposer: "text-rules@1" },
      fieldProposals: [], parties: [], obligations: [],
    });
    const html = await knowledge(document.id);
    expect(html).toContain("Back to inbox");
    expect(html.match(/Upload a document/g)).toHaveLength(1);
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
    expect(pageRuns).not.toHaveBeenCalled();
  });

  it("keeps recorded runs viewable but exposes no start control when verified Eve identity is unavailable", async () => {
    vi.mocked(eveBridgeUnavailableReason).mockReturnValue("Eve does not support verified Clerk identity yet.");
    const html = renderToStaticMarkup(await AlfredSurface());
    expect(html).toContain("verified Clerk identity");
    expect(html).not.toContain("Start a run");
    expect(pageRuns).toHaveBeenCalledWith("workspace", expect.objectContaining({ limit: 10, offset: 0 }));
  });
});

async function dossiers(dossier?: string) {
  return renderToStaticMarkup(await DossiersSurface({ searchParams: Promise.resolve({ dossier }) }));
}

describe("live dossiers screen", () => {
  it("reads Neon: an empty workspace gets the invitation, not the preview", async () => {
    const html = await dossiers();
    expect(html).toContain("No dossiers yet");
    expect(html).toContain("New dossier");
    expect(html).not.toContain("AlfredScreen");
  });

  it("lists dossiers with counts and renders the detail with its documents and Generate form", async () => {
    vi.mocked(listDossiers).mockResolvedValue([
      { id: "d1", title: "Rental papers", documentCount: 2 },
    ] as never);
    vi.mocked(getDossierDetail).mockResolvedValue({
      id: "d1",
      title: "Rental papers",
      documents: [
        { id: "doc1", title: "Lease", mimeType: "application/pdf" },
        { id: "doc2", title: "Renewal notes", mimeType: "text/markdown" },
      ],
    } as never);
    vi.mocked(listAttachableDocuments).mockResolvedValue([{ id: "doc1", title: "Lease" }] as never);
    const html = await dossiers("d1");
    expect(html).toContain("Rental papers");
    expect(html).toContain("2 documents");
    expect(html).toContain("Renewal notes");
    expect(html).toContain("What should the draft say?");
  });

  it("the attach picker offers the workspace's filed documents", async () => {
    vi.mocked(listAttachableDocuments).mockResolvedValue([
      { id: "doc1", title: "Lease" },
      { id: "doc2", title: "Inspection" },
    ] as never);
    const html = await dossiers();
    expect(html).toContain("Lease");
    expect(html).toContain("Inspection");
  });
});
