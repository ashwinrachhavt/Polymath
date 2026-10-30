import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { IdeaGrid } from "@/components/polymath/ideas/idea-grid";

const items = [
  { id: "a", title: "Snapshots, not locks", tags: [], excerpt: "MVCC buys concurrency.", createdAt: new Date("2026-10-14T00:00:00Z"), updatedAt: new Date("2026-10-14T00:00:00Z"), sourceDocumentId: null, sourceTitle: null, bloom: null, suggestedLinks: [] },
  { id: "b", title: "Libraries compound", tags: ["#product"], excerpt: "A saved source beats ten tabs.", createdAt: new Date("2026-10-09T00:00:00Z"), updatedAt: new Date("2026-10-09T00:00:00Z"), sourceDocumentId: null, sourceTitle: null, bloom: null, suggestedLinks: [] },
];

describe("IdeaGrid", () => {
  it("renders every idea once in cards view", () => {
    render(<IdeaGrid items={items} view="cards" baseHref="/polymath/ideas" />);
    expect(screen.getByText("Snapshots, not locks")).toBeDefined();
    expect(screen.getByText("Libraries compound")).toBeDefined();
  });

  it("orders dictionary view by title", () => {
    const { container } = render(<IdeaGrid items={items} view="dictionary" baseHref="/polymath/ideas" />);
    const titles = [...container.querySelectorAll("h3")].map((n) => n.textContent);
    expect(titles).toEqual(["Libraries compound", "Snapshots, not locks"]);
  });

  it("shows an invitation when there are no ideas", () => {
    render(<IdeaGrid items={[]} view="cards" baseHref="/polymath/ideas" />);
    expect(screen.getByText(/Capture something from Inbox/i)).toBeDefined();
  });
});
