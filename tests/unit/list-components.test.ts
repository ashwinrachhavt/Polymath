import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ListToolbar } from "@/components/list/list-toolbar";
import { NoResults } from "@/components/list/no-results";
import { Pagination } from "@/components/list/pagination";

let search = "q=ada&status=open&page=2";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/command-center/relationships",
  useSearchParams: () => new URLSearchParams(search),
  redirect: vi.fn(),
}));

describe("Pagination", () => {
  it("renders nothing for a short single page", () => {
    expect(renderToStaticMarkup(h(Pagination, { basePath: "/x", raw: {}, page: 1, pageSize: 25, total: 4 }))).toBe("");
  });

  it("renders real links that keep the other params", () => {
    const html = renderToStaticMarkup(
      h(Pagination, { basePath: "/x", raw: { q: "ada", page: "2" }, page: 2, pageSize: 25, total: 80 }),
    );
    expect(html).toContain("26\u201350 of 80");
    expect(html).toContain('href="/x?q=ada"'); // previous page is page 1: the page param drops out
    expect(html).toContain('href="/x?q=ada&amp;page=3"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-label="Rows per page"');
  });

  it("disables previous on the first page and next on the last", () => {
    const first = renderToStaticMarkup(h(Pagination, { basePath: "/x", raw: {}, page: 1, pageSize: 10, total: 30 }));
    expect(first).not.toContain('aria-label="Previous page"');
    expect(first).toContain('aria-label="Next page"');
    const last = renderToStaticMarkup(h(Pagination, { basePath: "/x", raw: { page: "3" }, page: 3, pageSize: 10, total: 30 }));
    expect(last).toContain('aria-label="Previous page"');
    expect(last).not.toContain('aria-label="Next page"');
  });

  it("compact mode drops the size picker and number strip", () => {
    const html = renderToStaticMarkup(h(Pagination, { basePath: "/x", raw: {}, page: 2, pageSize: 10, total: 50, compact: true }));
    expect(html).not.toContain("Rows per page");
    expect(html).toContain("2 / 5");
  });
});

describe("ListToolbar", () => {
  const filters = [
    { key: "status", label: "Status", allLabel: "All statuses", options: [{ value: "open", label: "Open" }, { value: "done", label: "Done" }] },
  ];

  it("reflects URL state as a search value, a selected option, and removable chips", () => {
    search = "q=ada&status=open&page=2";
    const html = renderToStaticMarkup(h(ListToolbar, { searchPlaceholder: "Search people", filters: filters, total: 7, noun: "people" }));
    expect(html).toContain('value="ada"');
    expect(html).toContain('aria-label="Filter by status"');
    expect(html).toContain('<option value="open" selected="">Open</option>');
    expect(html).toContain("Search: ada");
    expect(html).toContain("Status: Open");
    expect(html).toContain("Clear all");
    expect(html).toContain("7 people");
  });

  it("shows no chips when nothing is filtered", () => {
    search = "";
    const html = renderToStaticMarkup(h(ListToolbar, { filters: filters }));
    expect(html).not.toContain("Clear all");
    expect(html).toContain('role="search"');
  });

  it("ignores an unknown filter value in the URL", () => {
    search = "status=bogus";
    expect(renderToStaticMarkup(h(ListToolbar, { filters: filters }))).not.toContain("Clear all");
  });
});

describe("NoResults", () => {
  it("offers a way out when filters hide everything, and an invitation when there is nothing", () => {
    const filtered = renderToStaticMarkup(h(NoResults, { filtered: true, clearHref: "/x", emptyTitle: "Nothing yet", emptyDescription: "Add one." }));
    expect(filtered).toContain("No matches");
    expect(filtered).toContain('href="/x"');
    const empty = renderToStaticMarkup(h(NoResults, { filtered: false, clearHref: "/x", emptyTitle: "Nothing yet", emptyDescription: "Add one." }));
    expect(empty).toContain("Nothing yet");
    expect(empty).not.toContain("No matches");
  });
});
