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
    expect(isBrowserPreviewPath("/alfred/notes")).toBe(false);
    expect(isBrowserPreviewPath("/alfred/artifacts")).toBe(false);
    expect(isBrowserPreviewPath("/neuralflow/work")).toBe(false);
    expect(isBrowserPreviewPath("/apps/neuralflow")).toBe(true);
    expect(isBrowserPreviewPath("/apps/alfred/notebook")).toBe(true);
    expect(isBrowserPreviewPath("/reviews")).toBe(false);
    // /activity reads the real workspace audit feed; only /settings among the
    // shared screens still renders from the preview store.
    expect(isBrowserPreviewPath("/activity")).toBe(false);
    expect(isBrowserPreviewPath("/settings")).toBe(true);
    expect(isBrowserPreviewPath("/alfred/dossiers")).toBe(false);
  });

  it("prefers the exact destination over a prefix match", () => {
    // `/alfred` is a destination and a prefix of `/alfred/notes`. The bare
    // root must name Polymath; the child must name Notes.
    expect(destinationForPath("/alfred")?.label).toBe("Polymath");
    expect(destinationForPath("/alfred/knowledge")?.label).toBe("Document Vault");
    // /alfred/notebook now redirects to /alfred/notes, and the breadcrumb
    // for the old address still names Notes via featureRoutes.
    expect(destinationForPath("/alfred/notebook")?.label).toBe("Notes");
    expect(destinationForPath("/alfred/dossiers")?.label).toBe("Notebook");
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
   * The rail's first entry is the product's stance (agents/product.md: "a
   * conversation is home"). Decisions left the rail when its queue moved into
   * the header's notifications panel, beside runs and the audit trail; "/"
   * now redirects to the conversation. Order is behaviour, not styling, so it
   * gets an assertion rather than a review note.
   */
  it("opens the rail with the conversation, then Inbox", () => {
    expect(destinations[0].href).toBe("/alfred");
    expect(destinations[0].label).toBe("Polymath");
    expect(destinations[1].href).toBe("/command-center/inbox");
    expect(destinations.some((destination) => destination.label === "Decisions")).toBe(false);
  });

  /*
   * The IA simplification removed seven destinations from the rail (Sources,
   * Wiki, Learning, Spending, Opportunities, Focus, and the old Notebook at
   * /alfred/notebook). The exact-order test above already fails if any of them
   * returns, so no separate negative assertion is kept; /apps preview tools
   * keep their donor labels, only the rail governs.
   */

  it("rails exactly the fourteen destinations in order", () => {
    // Conversations left the rail when its threads moved into the Assistant;
    // the route still resolves (old links keep working) but it is no longer a
    // destination. Today left when Briefing was removed: its outcomes and day
    // context moved to Work's Today view. Decisions left when its queue moved
    // into the header's notifications panel.
    expect(destinations.map((destination) => destination.label)).toEqual([
      "Polymath", "Inbox", "Work", "Notes", "Document Vault", "Notebook",
      "Artifacts", "Skills", "People", "Companies", "Connectors",
      "Reviews", "Activity", "Settings",
    ]);
  });
});
