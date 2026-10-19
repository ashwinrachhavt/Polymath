import { describe, expect, it } from "vitest";
import {
  appForPath,
  apps,
  crossAppLinks,
  crossAppLinksFrom,
  additionalDestinationsIn,
  featureDestinations,
  isBrowserPreviewPath,
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

  it("keeps preview routes inside their app without matching similar prefixes", () => {
    expect(appForPath("/apps/neuralflow/tasks")?.slug).toBe("neuralflow");
    expect(appForPath("/apps/alfred/notebook")?.slug).toBe("alfred");
    expect(appForPath("/apps/command-center/contacts")?.slug).toBe("command-center");
    expect(appForPath("/apps/alfred-other/notebook")).toBeUndefined();
    expect(destinationForPath("/apps/neuralflow/tasks")?.href).toBe("/neuralflow/work");
    expect(destinationForPath("/apps/alfred/notebook")?.label).toBe("Notebook");
    expect(destinationForPath("/apps/alfred/not-a-screen")).toBeUndefined();
  });

  it("keeps every noncanonical feature reachable from its own app", () => {
    for (const app of apps) {
      const additional = additionalDestinationsIn(app.slug);
      expect(additional.length).toBeGreaterThan(0);
      for (const destination of additional) {
        expect(appForPath(destination.href)?.slug).toBe(app.slug);
        expect(featureDestinations).toContain(destination);
      }
    }
    expect(additionalDestinationsIn("neuralflow").some((destination) => destination.label === "Stone collection")).toBe(true);
  });

  it("does not label live Alfred routes as disconnected browser previews", () => {
    expect(isBrowserPreviewPath("/alfred")).toBe(false);
    expect(isBrowserPreviewPath("/alfred/knowledge")).toBe(false);
    expect(isBrowserPreviewPath("/alfred/knowledge/document-id")).toBe(false);
    // Every /neuralflow view reads canonical Neon tasks; its browser-only
    // preview survives only on the standalone /apps/neuralflow route (ASH-165).
    expect(isBrowserPreviewPath("/neuralflow/work")).toBe(false);
    expect(isBrowserPreviewPath("/neuralflow/focus")).toBe(false);
    expect(isBrowserPreviewPath("/apps/neuralflow")).toBe(true);
    expect(isBrowserPreviewPath("/apps/alfred/notebook")).toBe(true);
    // /reviews is the canonical proposal queue (Postgres-backed); the
    // browser-only rehearsal survives under /apps/command-center (Reviews v2).
    expect(isBrowserPreviewPath("/reviews")).toBe(false);
    // The dossiers screen is backed by Neon, not browser samples, so no preview banner.
    expect(isBrowserPreviewPath("/alfred/dossiers")).toBe(false);
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
