import { describe, expect, it } from "vitest";
import { destinations, destinationForPath } from "@/lib/navigation";

/*
 * The phone bottom bar pins four destinations by href
 * (src/components/shell/mobile-nav.tsx). A rename that moves a pinned
 * destination's URL without updating barHrefs silently drops the tile from
 * every phone, which is how Notebook vanished when /alfred/dossiers became
 * /projects. This test reads the bar's pinned list and fails when any pinned
 * href stops naming a destination.
 */
describe("mobile nav", () => {
  it("resolves every pinned bottom-bar href to a real destination", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/components/shell/mobile-nav.tsx", "utf8");
    const start = source.indexOf("const barHrefs = [");
    expect(start, "barHrefs declaration found in mobile-nav.tsx").toBeGreaterThan(-1);
    const open = source.indexOf("[", start);
    const close = source.indexOf("]", open);
    const hrefs = source
      .slice(open + 1, close)
      .split(",")
      .map((entry) => entry.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    expect(hrefs.length).toBe(4);
    for (const href of hrefs) {
      const destination = destinations.find((d) => d.href === href);
      expect(destination, `pinned bar href ${href} names a destination`).toBeTruthy();
    }
  });

  it("keeps the Notebook destination on a route that exists", () => {
    expect(destinationForPath("/projects")?.label).toBe("Notebook");
    expect(destinationForPath("/artifacts")?.label).toBe("Artifacts");
  });
});
