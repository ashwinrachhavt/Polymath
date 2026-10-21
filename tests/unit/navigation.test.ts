import { describe, expect, it } from "vitest";
import {
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
  it("keeps preview routes resolving to their canonical destination", () => {
    expect(destinationForPath("/apps/neuralflow/tasks")?.href).toBe("/neuralflow/work");
    expect(destinationForPath("/apps/alfred/not-a-screen")).toBeUndefined();
  });

  it("keeps every preview tool reachable and on a real route", () => {
    for (const slug of ["command-center", "neuralflow", "alfred"] as const) {
      const additional = additionalDestinationsIn(slug);
      expect(additional.length).toBeGreaterThan(0);
      for (const destination of additional) {
        expect(featureDestinations).toContain(destination);
        expect(destination.href).toMatch(/^\/(apps\/)?(command-center|neuralflow|alfred)\//);
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

  it("attributes every destination to a historic prefix or shared", () => {
    for (const destination of destinations) {
      expect(destination.group === "shared" || ["command-center", "neuralflow", "alfred"].includes(destination.group)).toBe(true);
    }
  });

  it("labels no destination with a former product name", () => {
    for (const destination of [...destinations, ...featureDestinations]) {
      expect(destination.label).not.toMatch(/Command Center|NeuralFlow|Alfred/);
    }
  });

  /*
   * The rail's first two entries are the product's opening move (agents/
   * product.md: a conversation is home). Order is behaviour, not styling, so it
   * gets an assertion rather than a review note.
   */
  it("opens the rail with Assistant, then Today", () => {
    expect(destinations[0].href).toBe("/alfred");
    expect(destinations[0].label).toBe("Assistant");
    expect(destinations[1].href).toBe("/command-center/briefing");
  });
});
