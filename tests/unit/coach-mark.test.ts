import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { CoachMark } from "@/components/shell/coach-mark";

/*
 * The coach mark is client-only by contract: it must render nothing on the
 * server (visibility depends on localStorage), so SSR never flashes a callout
 * and hydration stays clean.
 */
describe("CoachMark", () => {
  it("renders nothing during SSR", () => {
    const html = renderToStaticMarkup(
      createElement(CoachMark, { id: "test", title: "Products have a new home" }, "Body copy"),
    );
    expect(html).toBe("");
  });
});
