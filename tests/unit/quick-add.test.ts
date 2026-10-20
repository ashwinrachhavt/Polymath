import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "@/domains/work/quick-add";

const now = new Date(2026, 9, 19, 12, 0, 0); // Monday

describe("parseQuickAdd", () => {
  it("passes plain text through", () => {
    expect(parseQuickAdd("Buy milk", now)).toEqual({ title: "Buy milk", tags: [] });
  });
  it("extracts priority, estimate and tags", () => {
    const r = parseQuickAdd("Draft spec !high ~1h30m #work #Work #ui", now);
    expect(r).toMatchObject({ title: "Draft spec", priority: "high", estimateMinutes: 90, tags: ["work", "ui"] });
  });
  it("reads numeric priority and minute estimates", () => {
    expect(parseQuickAdd("Call !4 ~30m", now)).toMatchObject({ priority: "urgent", estimateMinutes: 30 });
  });
  it("sets due to 5pm local for today, tomorrow and a weekday", () => {
    expect(parseQuickAdd("A due tomorrow", now).dueAt).toEqual(new Date(2026, 9, 20, 17));
    expect(parseQuickAdd("A due today", now).dueAt).toEqual(new Date(2026, 9, 19, 17));
    expect(parseQuickAdd("A due friday", now).dueAt).toEqual(new Date(2026, 9, 23, 17));
    expect(parseQuickAdd("A due monday", now).dueAt).toEqual(new Date(2026, 9, 26, 17));
  });
  it("leaves unknown tokens alone", () => {
    expect(parseQuickAdd("Ship !soon it", now).title).toBe("Ship !soon it");
  });
});
