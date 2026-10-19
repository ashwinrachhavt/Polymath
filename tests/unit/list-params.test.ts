import { describe, expect, it } from "vitest";
import {
  clampPage,
  listHref,
  matchesQuery,
  offsetFor,
  pageCount,
  pageWindow,
  paginate,
  parseListParams,
  rangeLabel,
} from "@/lib/list-params";

const spec = { filters: { status: ["open", "done"] as const } };

describe("parseListParams", () => {
  it("defaults when the URL is empty", () => {
    expect(parseListParams({}, spec)).toEqual({ q: "", page: 1, pageSize: 25, filters: {} });
  });
  it("accepts known values and trims the query", () => {
    const s = parseListParams({ q: "  ada ", page: "3", size: "50", status: "done" }, spec);
    expect(s).toEqual({ q: "ada", page: 3, pageSize: 50, filters: { status: "done" } });
  });
  it("ignores junk instead of throwing", () => {
    const s = parseListParams({ page: "-4", size: "7", status: "bogus" }, spec);
    expect(s).toMatchObject({ page: 1, pageSize: 25, filters: {} });
    expect(parseListParams({ page: "1e9" }).page).toBe(1);
  });
  it("takes the first of repeated params", () => {
    expect(parseListParams({ q: ["a", "b"] }).q).toBe("a");
  });
});

describe("paging math", () => {
  it("counts pages with a floor of one", () => {
    expect(pageCount(0, 25)).toBe(1);
    expect(pageCount(51, 25)).toBe(3);
  });
  it("clamps past-the-end pages", () => {
    expect(clampPage(9, 30, 25)).toBe(2);
    expect(clampPage(0, 30, 25)).toBe(1);
  });
  it("labels ranges", () => {
    expect(rangeLabel(1, 25, 0)).toBe("0 results");
    expect(rangeLabel(2, 25, 30)).toBe("26\u201330 of 30");
    expect(offsetFor(3, 10)).toBe(20);
  });
  it("builds a window with gaps", () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(5, 10)).toEqual([1, null, 4, 5, 6, null, 10]);
    expect(pageWindow(2, 10)).toEqual([1, 2, 3, null, 10]);
  });
  it("paginates in memory", () => {
    const r = paginate([1, 2, 3, 4, 5], 9, 2);
    expect(r).toEqual({ items: [5], page: 3, total: 5 });
  });
});

describe("listHref", () => {
  it("keeps unrelated params, drops empties and page 1", () => {
    expect(listHref("/x", { id: "7", q: "a", page: "2" }, { page: 1, q: "" })).toBe("/x?id=7");
    expect(listHref("/x", {}, { status: "open", page: 3 })).toBe("/x?status=open&page=3");
    expect(listHref("/x", {}, {})).toBe("/x");
  });
});

describe("matchesQuery", () => {
  it("matches any field, case-insensitively", () => {
    expect(matchesQuery("ADA", null, "ada lovelace")).toBe(true);
    expect(matchesQuery("zed", "ada", undefined)).toBe(false);
    expect(matchesQuery("", "x")).toBe(true);
  });
});
