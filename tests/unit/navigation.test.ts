import { describe, expect, it } from "vitest";
import {
  appForPath,
  apps,
  crossAppLinks,
  crossAppLinksFrom,
  destinations,
  destinationForPath,
  destinationsIn,
} from "@/lib/navigation";

/*
 * The nav model is small but it has two real traps: `/alfred` is both an app
 * root and a destination, so every prefix comparison has to let an exact match
 * win; and each app's nav must be able to render from its own definition alone,
 * because the shell never flattens the three apps together. These checks fail
 * if either invariant is broken.
 */
describe("navigation", () => {
  it("resolves an app from its pathname, including its root", () => {
    expect(appForPath("/command-center/briefing")?.slug).toBe("command-center");
    expect(appForPath("/neuralflow/work")?.slug).toBe("neuralflow");
    expect(appForPath("/alfred")?.slug).toBe("alfred");
    expect(appForPath("/alfred/knowledge")?.slug).toBe("alfred");
    expect(appForPath("/reviews")).toBeUndefined();
  });

  it("prefers the exact destination over a prefix match", () => {
    // `/alfred` is a destination and a prefix of `/alfred/knowledge`. The bare
    // root must name Threads; the child must name Knowledge.
    expect(destinationForPath("/alfred")?.label).toBe("Threads");
    expect(destinationForPath("/alfred/knowledge")?.label).toBe("Knowledge");
  });

  it("keeps every destination inside an app that owns it or in shared", () => {
    for (const destination of destinations) {
      const app = appForPath(destination.href);
      const expected = destination.group === "shared" ? undefined : destination.group;
      expect(app?.slug).toBe(expected);
    }
  });

  it("gives each app at least one destination and a declared nav shape", () => {
    for (const { slug, nav } of apps) {
      expect(destinationsIn(slug).length).toBeGreaterThan(0);
      expect(["rail", "bar"]).toContain(nav);
    }
  });

  it("links every app to both of the others", () => {
    // Interoperability is a property of the model, not of any one screen: an app
    // that cannot reach the other two is an island, however it is presented.
    for (const { slug } of apps) {
      const reachable = new Set(crossAppLinksFrom(slug).map((link) => link.to));
      for (const other of apps) {
        if (other.slug === slug) continue;
        expect(reachable).toContain(other.slug);
      }
    }
  });

  it("points every cross-app link at the app it claims", () => {
    for (const { to, href } of crossAppLinks) {
      expect(appForPath(href)?.slug).toBe(to);
    }
  });
});
