import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthContext } from "@/lib/auth";
import { getDocumentInbox, getDocumentReview } from "@/domains/knowledge/queries";
import { listRecentRuns } from "@/domains/agents/queries";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import KnowledgePage from "@/app/(workspace)/alfred/knowledge/page";
import AlfredPage from "@/app/(workspace)/alfred/page";

vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/auth", () => ({ getAuthContext: vi.fn() }));
vi.mock("@/domains/knowledge/queries", () => ({ getDocumentInbox: vi.fn(), getDocumentReview: vi.fn() }));
vi.mock("@/domains/knowledge/parties", () => ({ resolvePartyCandidates: vi.fn(async () => []) }));
vi.mock("@/domains/knowledge/search", () => ({ searchDocuments: vi.fn(async () => []) }));
vi.mock("@/domains/agents/queries", () => ({ listRecentRuns: vi.fn() }));
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
  vi.mocked(getDocumentReview).mockResolvedValue(null);
  vi.mocked(listRecentRuns).mockResolvedValue([]);
  vi.mocked(eveBridgeUnavailableReason).mockReturnValue(null);
});
afterEach(() => vi.unstubAllEnvs());

async function knowledge(doc?: string) {
  return renderToStaticMarkup(await KnowledgePage({ searchParams: Promise.resolve({ doc }) }));
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
    const agents = renderToStaticMarkup(await AlfredPage());
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

  it("keeps recorded runs viewable but exposes no start control when verified Eve identity is unavailable", async () => {
    vi.mocked(eveBridgeUnavailableReason).mockReturnValue("Eve does not support verified Clerk identity yet.");
    const html = renderToStaticMarkup(await AlfredPage());
    expect(html).toContain("verified Clerk identity");
    expect(html).not.toContain("Start a run");
    expect(listRecentRuns).toHaveBeenCalledWith("workspace", 8);
  });
});
