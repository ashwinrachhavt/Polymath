import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes, ReactNode } from "react";

/*
 * Value: protects=the Notes popover (the chat's history chip, shared) lists
 * notes by day, marks the open one, and narrows through its search without
 * navigating; fails_when=search keeps showing an earlier query's rows, the
 * open note is not marked, or the chip stops being the chat's component;
 * why_new=the permanent list column was replaced by this popover; seam=the
 * search function the menu is given and the row hrefs; no_claim=which notes
 * match a query, which belongs to pageNotes in the domain
 */

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string } & AnchorHTMLAttributes<HTMLAnchorElement>) =>
      createElement("a", { href, ...rest }, children as ReactNode),
  };
});
vi.mock("next/navigation", () => ({ usePathname: () => "/polymath/notes" }));

import { HistoryMenu, type HistoryGroup } from "@/app/(workspace)/polymath/history-menu";

const row = (id: string, title: string) => ({ id, title, href: `/polymath/notes?id=${id}`, time: "2h" });
const groups: HistoryGroup[] = [
  { key: "today", label: "Today", rows: [row("b", "Quarterly plan")] },
  { key: "yesterday", label: "Yesterday", rows: [row("a", "Hiring notes")] },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the Notes popover", () => {
  it("lists notes under their day and marks the one being written", () => {
    render(<HistoryMenu groups={groups} label="Notes" listLabel="Your notes" currentId="b" />);
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    const list = screen.getByRole("navigation", { name: "Your notes" });
    expect(list.textContent).toContain("Today");
    expect(list.textContent).toContain("Yesterday");
    expect(screen.getByRole("link", { name: /Quarterly plan/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: /Hiring notes/ }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("link", { name: /Hiring notes/ }).getAttribute("href")).toBe("/polymath/notes?id=a");
  });

  it("narrows by search and never shows an earlier query's answer under a newer one", async () => {
    const first = deferred<HistoryGroup[]>();
    const second = deferred<HistoryGroup[]>();
    const run = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<HistoryMenu groups={groups} label="Notes" search={{ label: "Search notes", run }} />);
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    const box = screen.getByRole("searchbox", { name: "Search notes" });

    fireEvent.change(box, { target: { value: "hir" } });
    await act(async () => vi.advanceTimersByTime(200));
    fireEvent.change(box, { target: { value: "hiring" } });
    await act(async () => vi.advanceTimersByTime(200));
    expect(run).toHaveBeenNthCalledWith(1, "hir");
    expect(run).toHaveBeenNthCalledWith(2, "hiring");

    // The stale answer arrives last: it must not replace the current query's rows.
    await act(async () => second.resolve([{ key: "today", label: "Today", rows: [row("a", "Hiring notes")] }]));
    await act(async () => first.resolve([{ key: "today", label: "Today", rows: [row("x", "Hire stale")] }]));
    expect(screen.getByRole("link", { name: /Hiring notes/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Hire stale/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Quarterly plan/ })).toBeNull();
  });

  it("says so when nothing matches, and returns to the full list when the query is cleared", async () => {
    const run = vi.fn().mockResolvedValue([]);
    render(<HistoryMenu groups={groups} label="Notes" search={{ label: "Search notes", run }} />);
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    const box = screen.getByRole("searchbox", { name: "Search notes" });
    fireEvent.change(box, { target: { value: "zebra" } });
    await act(async () => vi.advanceTimersByTime(200));
    expect(screen.getByText("Nothing matches “zebra”.")).toBeTruthy();
    fireEvent.change(box, { target: { value: "" } });
    expect(screen.getByRole("link", { name: /Quarterly plan/ })).toBeTruthy();
  });

  it("closes on Escape and gives focus back to the chip", () => {
    render(<HistoryMenu groups={groups} label="Notes" />);
    const chip = screen.getByRole("button", { name: "Notes" });
    fireEvent.click(chip);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(document.activeElement).toBe(chip);
  });
});
