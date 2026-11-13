import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { IdeaCard } from "@/components/polymath/ideas/idea-card";

// Each card carries Delete, whose archive can navigate; the list itself never does.
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }) }));

const item = {
  id: "z1",
  title: "The cache is the bill",
  tags: ["#llms", "#inference"],
  excerpt: "Long context bills in memory before it bills in tokens.",
  createdAt: new Date("2026-10-24T12:00:00Z"),
  updatedAt: new Date("2026-10-24T12:00:00Z"),
  sourceDocumentId: "d1",
  sourceTitle: "How KV caches scale",
  bloom: null,
  suggestedLinks: [],
};

describe("IdeaCard", () => {
  it("renders title, claim, tags, source attribution and date", () => {
    render(<IdeaCard item={item} href="/polymath/ideas/z1" />);
    expect(screen.getByText("The cache is the bill")).toBeDefined();
    expect(screen.getByText(/Long context bills in memory/)).toBeDefined();
    expect(screen.getByText("#llms")).toBeDefined();
    expect(screen.getByText(/How KV caches scale/)).toBeDefined();
    expect(screen.getByText(/Oct 24/)).toBeDefined();
    expect(screen.getByRole("link").getAttribute("href")).toBe("/polymath/ideas/z1");
  });

  it("offers Delete beside the card link, not inside it", () => {
    render(<IdeaCard item={item} href="/polymath/ideas/z1" />);
    const remove = screen.getByRole("button", { name: "Delete idea" });
    expect(screen.getByRole("link").contains(remove)).toBe(false);
  });

  it("hides Delete with visibility, never opacity (an opacity-0 button never passes the e2e settle check)", () => {
    render(<IdeaCard item={item} href="/polymath/ideas/z1" />);
    const { className } = screen.getByRole("button", { name: "Delete idea" });
    expect(className).toContain("invisible");
    expect(className).not.toContain("opacity-0");
  });

  it("carries no mastery, recall, or progress chrome", () => {
    const { container } = render(<IdeaCard item={{ ...item, bloom: { level: 1, levelName: "Recall" } }} href="/x" />);
    expect(container.textContent).not.toMatch(/mastery|recall|practice|progress/i);
  });
});
