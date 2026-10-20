import { describe, expect, it } from "vitest";
import {
  appForPath,
  additionalDestinationsIn,
  featureDestinations,
  isBrowserPreviewPath,
  destinations,
  destinationForPath,
} from "@/lib/navigation";

/*
 * The nav model is one flat destination list over historic URL prefixes. The
 * two real traps: `/alfred` is both a destination and a prefix of
 * `/alfred/knowledge`, so an exact match has to win; and the rail, the
 * breadcrumb, and the command layer all read this one list, so nothing may
 * reference an app name that no longer exists in the interface.
 */
describe("navigation", () => {
  it("resolves the historic prefix of a pathname", () => {
    expect(appForPath("/command-center/briefing")?.slug).toBe("command-center");
    expect(appForPath("/neuralflow/work")?.slug).toBe("neuralflow");
    expect(appForPath("/alfred")?.slug).toBe("alfred");
    expect(appForPath("/alfred/knowledge")?.slug).toBe("alfred");
    expect(appForPath("/reviews")).toBeUndefined();
  });

  it("keeps preview routes inside their prefix without matching similar ones", () => {
    expect(appForPath("/apps/neuralflow/tasks")?.slug).toBe("neuralflow");
    expect(appForPath("/apps/alfred/notebook")?.slug).toBe("alfred");
    expect(appForPath("/apps/command-center/contacts")?.slug).toBe("command-center");
    expect(appForPath("/apps/alfred-other/notebook")).toBeUndefined();
    expect(destinationForPath("/apps/neuralflow/tasks")?.href).toBe("/neuralflow/work");
    expect(destinationForPath("/apps/alfred/not-a-screen")).toBeUndefined();
  });

  it("keeps every preview tool reachable and attributed", () => {
    for (const slug of ["command-center", "neuralflow", "alfred"] as const) {
      const additional = additionalDestinationsIn(slug);
      expect(additional.length).toBeGreaterThan(0);
      for (const destination of additional) {
        expect(appForPath(destination.href)?.slug).toBe(slug);
        expect(featureDestinations).toContain(destination);
      }
    }
    expect(additionalDestinationsIn("neuralflow").some((destination) => destination.label === "Stone collection")).toBe(true);
  });

  it("does not label live routes as disconnected browser previews", () => {
    expect(isBrowserPreviewPath("/alfred")).toBe(false);
    expect(isBrowserPreviewPath("/alfred/knowledge")).toBe(false);
    expect(isBrowserPreviewPath("/alfred/knowledge/document-id")).toBe(false);
    expect(isBrowserPreviewPath("/neuralflow/work")).toBe(false);
    expect(isBrowserPreviewPath("/neuralflow/focus")).toBe(false);
    expect(isBrowserPreviewPath("/apps/neuralflow")).toBe(true);
    expect(isBrowserPreviewPath("/apps/alfred/notebook")).toBe(true);
    expect(isBrowserPreviewPath("/reviews")).toBe(false);
    expect(isBrowserPreviewPath("/alfred/dossiers")).toBe(false);
  });

  it("prefers the exact destination over a prefix match", () => {
    // `/alfred` is a destination and a prefix of `/alfred/knowledge`. The bare
    // root must name Assistant; the child must name Library.
    expect(destinationForPath("/alfred")?.label).toBe("Assistant");
    expect(destinationForPath("/alfred/knowledge")?.label).toBe("Library");
  });

  it("keeps every destination attributed to a real prefix or shared", () => {
    for (const destination of destinations) {
      const app = appForPath(destination.href);
      const expected = destination.group === "shared" ? undefined : destination.group;
      expect(app?.slug).toBe(expected);
    }
  });

  it("labels no destination with a former product name", () => {
    for (const destination of [...destinations, ...featureDestinations]) {
      expect(destination.label).not.toMatch(/Command Center|NeuralFlow|Alfred/);
    }
  });
});
