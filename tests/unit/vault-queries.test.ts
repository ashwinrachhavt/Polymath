import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserRow } from "@/domains/knowledge/file-browser";
import type { AuthContext } from "@/domains/identity/resolve";
import type { LibraryRow } from "@/domains/knowledge/library";

/*
 * The vault's one query rule: the root is a folder view, not "everything".
 * A document filed in a folder must not appear twice, or every folder tile
 * would look like a copy of the library. The review fields come straight from
 * the library row, so the vault cannot drift from status.ts.
 */

const { listDocuments, toBrowserRows } = vi.hoisted(() => ({
  listDocuments: vi.fn(),
  toBrowserRows: vi.fn(),
}));

vi.mock("@/domains/knowledge/library", () => ({ listDocuments }));
vi.mock("@/domains/knowledge/file-rows", () => ({ toBrowserRows }));

import { getVaultDocuments } from "@/domains/knowledge/vault-queries";

const auth: AuthContext = { userId: "user-1", workspaceId: "workspace-1", role: "owner" };

const libraryRow = {
  id: "doc-1",
  title: "Lease",
  filename: "lease.pdf",
  mimeType: "application/pdf",
  docType: "agreement",
  pageCount: 3,
  sizeBytes: 1200,
  folderId: null,
  tags: [],
  state: { key: "needs_check", label: "Needs your check", tone: "attention" },
  undecidedProposals: 2,
  snippet: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-02T00:00:00Z"),
  version: 1,
} satisfies LibraryRow;

const browserRow = {
  id: "doc-1",
  title: "Lease",
  filename: "lease.pdf",
  mimeType: "application/pdf",
  createdAt: "2026-10-01T00:00:00.000Z",
  sourceUrl: null,
  kind: "file",
  extractionStatus: "succeeded",
  undecidedProposals: 2,
  partyNames: [],
  folderId: null,
  version: 1,
  tags: [],
} satisfies BrowserRow;

beforeEach(() => {
  listDocuments.mockReset();
  toBrowserRows.mockReset();
  listDocuments.mockResolvedValue({ rows: [libraryRow], nextCursor: null, total: 1 });
  toBrowserRows.mockResolvedValue([browserRow]);
});

describe("getVaultDocuments", () => {
  it("reads the root as unfiled documents, not the whole library", async () => {
    await getVaultDocuments(auth, null);
    expect(listDocuments).toHaveBeenCalledWith(
      auth,
      expect.objectContaining({ filters: { folder: "root" }, sort: "recent", limit: 100 }),
    );
  });

  it("reads one folder by id", async () => {
    const folderId = "11111111-1111-4111-8111-111111111111";
    await getVaultDocuments(auth, folderId);
    expect(listDocuments).toHaveBeenCalledWith(
      auth,
      expect.objectContaining({ filters: { folder: folderId } }),
    );
  });

  it("carries the review key and count from the library row", async () => {
    const [doc] = await getVaultDocuments(auth, null);
    expect(doc).toMatchObject({
      title: "Lease",
      reviewKey: "needs_check",
      undecidedProposals: 2,
      docType: "agreement",
      href: "/alfred/knowledge?doc=doc-1",
    });
    expect(doc).not.toHaveProperty("status");
  });
});
