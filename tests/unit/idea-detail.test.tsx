import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/*
 * The detail route reads one artifact and renders it, or a friendly miss. The
 * domain read, auth and the related-cards query are stubbed so this proves the
 * page's own contract: what it shows for a found idea, and that a miss is a
 * message with a way back rather than a thrown error or a stack.
 */

/*
 * Testing Library's automatic cleanup hooks `afterEach` on the GLOBAL scope and
 * this repo runs vitest without globals, so the `ui` project carries
 * tests/unit/setup.ui.ts, which registers cleanup for every component test.
 */

const IDEA = {
  id: "6f1c2b7a-5b3e-4c8d-9a10-2b3c4d5e6f70",
  title: "The cache is the bill",
  kind: "zettel",
  status: "reviewed",
  version: 3,
  currentVersionId: "v1",
  tags: ["#llms", "#inference"],
  createdAt: new Date("2026-10-24T12:00:00Z"),
  updatedAt: new Date("2026-10-26T12:00:00Z"),
  content: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Long context bills in memory before it bills in tokens." }] },
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "KV caches grow with the sequence." }] }] },
    ],
  },
  draft: null,
  embedError: null,
  indexed: true,
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/polymath/ideas",
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ getAuthContext: vi.fn(async () => ({ workspaceId: "w1", userId: "u1", role: "member" })) }));
vi.mock("@/lib/auth/guards", () => ({ requireRole: vi.fn() }));
// The strip pulls the link server actions in, which import this module's
// error classes and helpers; spread the real exports and stub only the read.
vi.mock("@/domains/knowledge/notes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domains/knowledge/notes")>()),
  getNote: vi.fn(async () => IDEA),
}));
vi.mock("@/domains/knowledge/relations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domains/knowledge/relations")>()),
  relatedNotes: vi.fn(async () => []),
  linkedNotes: vi.fn(async () => []),
}));
// The editor is a client component with a rich-text surface; this test is
// about the page's read, so it stands in as a marker.
vi.mock("@/components/polymath/zettels/idea-editor", () => ({
  IdeaEditor: () => <div data-testid="idea-editor" />,
}));

const { getNote } = await import("@/domains/knowledge/notes");
const { IdeaDetailSurface } = await import("@/app/(workspace)/polymath/ideas/[id]/page");

const params = (id: string) => Promise.resolve({ id });

describe("IdeaDetailSurface", () => {
  it("renders the title, the claim and the evidence for a valid idea", async () => {
    const ui = await IdeaDetailSurface({ params: params(IDEA.id) });
    const { container } = render(ui);
    expect(screen.getByText("The cache is the bill")).toBeDefined();
    expect(screen.getByText(/Long context bills in memory/)).toBeDefined();
    expect(screen.getByText(/KV caches grow with the sequence/)).toBeDefined();
    expect(screen.getByText("#llms")).toBeDefined();
    expect(screen.getAllByText(/Oct 24/).length).toBeGreaterThan(0);
    expect(container.querySelector('[data-testid="idea-editor"]')).not.toBeNull();
    expect(screen.getByText("Back to Ideas").getAttribute("href")).toBe("/polymath/ideas");
  });

  it("shows the not-found message with a way back for an unknown id", async () => {
    vi.mocked(getNote).mockResolvedValueOnce(null);
    const ui = await IdeaDetailSurface({ params: params("11111111-1111-4111-8111-111111111111") });
    const { container } = render(ui);
    expect(screen.getByText(/This idea could not be found/)).toBeDefined();
    expect(screen.getByText("Back to Ideas").getAttribute("href")).toBe("/polymath/ideas");
    expect(container.querySelector('[data-testid="idea-editor"]')).toBeNull();
  });
});
