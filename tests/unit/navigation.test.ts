import { describe, expect, it } from "vitest";
import {
  additionalDestinationsIn,
  featureDestinations,
  isBrowserPreviewPath,
  isConversationSurface,
  isFocusSurface,
  destinations,
  destinationForPath,
} from "@/lib/navigation";

/*
 * The nav model is one flat destination list over historic URL prefixes. The
 * two real traps: `/polymath` is both a destination and a prefix of
 * `/polymath/knowledge`, so an exact match has to win; and the rail, the
 * breadcrumb, and the command layer all read this one list, so nothing may
 * reference an app name that no longer exists in the interface.
 */
describe("navigation", () => {
  it("keeps preview routes resolving to their canonical destination", () => {
    expect(destinationForPath("/apps/neuralflow/tasks")?.href).toBe("/today");
    expect(destinationForPath("/apps/polymath/not-a-screen")).toBeUndefined();
  });

  it("keeps every preview tool reachable and on a real route", () => {
    for (const slug of ["command-center", "neuralflow", "polymath"] as const) {
      const additional = additionalDestinationsIn(slug);
      expect(additional.length).toBeGreaterThan(0);
      for (const destination of additional) {
        expect(featureDestinations).toContain(destination);
        expect(destination.href).toMatch(/^\/(apps\/)?(command-center|neuralflow|polymath)\//);
      }
    }
    expect(additionalDestinationsIn("neuralflow").some((destination) => destination.label === "Stone collection")).toBe(
      true,
    );
  });

  it("does not label live routes as disconnected browser previews", () => {
    expect(isBrowserPreviewPath("/polymath")).toBe(false);
    expect(isBrowserPreviewPath("/polymath/knowledge")).toBe(false);
    expect(isBrowserPreviewPath("/polymath/knowledge/document-id")).toBe(false);
    expect(isBrowserPreviewPath("/polymath/notes")).toBe(false);
    expect(isBrowserPreviewPath("/polymath/artifacts")).toBe(false);
    expect(isBrowserPreviewPath("/neuralflow/work")).toBe(false);
    expect(isBrowserPreviewPath("/apps/neuralflow")).toBe(true);
    expect(isBrowserPreviewPath("/apps/polymath/notebook")).toBe(true);
    expect(isBrowserPreviewPath("/reviews")).toBe(false);
    // /activity reads the real workspace audit feed; only /settings among the
    // shared screens still renders from the preview store.
    expect(isBrowserPreviewPath("/activity")).toBe(false);
    expect(isBrowserPreviewPath("/settings")).toBe(true);
    expect(isBrowserPreviewPath("/polymath/dossiers")).toBe(false);
  });

  it("prefers the exact destination over a prefix match", () => {
    // `/polymath` is a destination and a prefix of `/polymath/notes`. The bare
    // root must name Polymath; the child must name Notes.
    expect(destinationForPath("/polymath")?.label).toBe("Polymath");
    expect(destinationForPath("/polymath/knowledge")?.label).toBe("Document Vault");
    // /polymath/notebook now redirects to /polymath/notes, and the breadcrumb
    // for the old address still names Notes via featureRoutes.
    expect(destinationForPath("/polymath/notebook")?.label).toBe("Notes");
    expect(destinationForPath("/polymath/dossiers")?.label).toBe("Notebook");
  });

  it("attributes every destination to a historic prefix or shared", () => {
    for (const destination of destinations) {
      expect(
        destination.group === "shared" || ["command-center", "neuralflow", "polymath"].includes(destination.group),
      ).toBe(true);
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
    expect(destinations[0].href).toBe("/polymath");
    expect(destinations[0].label).toBe("Polymath");
    expect(destinations[1].href).toBe("/command-center/inbox");
    expect(destinations.some((destination) => destination.label === "Decisions")).toBe(false);
  });

  /*
   * The IA simplification removed seven destinations from the rail (Sources,
   * Wiki, Learning, Spending, Opportunities, Focus, and the old Notebook at
   * /polymath/notebook). The exact-order test above already fails if any of them
   * returns, so no separate negative assertion is kept; /apps preview tools
   * keep their donor labels, only the rail governs.
   */

  /*
   * The shell folds headerless only on real conversation surfaces; every
   * static workspace page (Notes, Vault, Skills, …) keeps the top bar and the
   * open rail. The static-segment set lives in navigation.ts, so a new
   * subroute added there without registering it fails the run-id case below —
   * enumerate the set here to catch that drift at review time.
   */
  it("keeps the shell on every static /polymath subroute", () => {
    const staticSegments = [
      "notes",
      "notebook",
      "ideas",
      "knowledge",
      "skills",
      "library",
      "artifacts",
      "files",
      "graph",
      "wiki",
      "sources",
      "specialists",
      "dossiers",
    ];
    for (const segment of staticSegments) {
      expect(isConversationSurface(`/polymath/${segment}`)).toBe(false);
    }
    // Deep paths keep their static head segment: depth never folds the shell.
    expect(isConversationSurface("/polymath/notes/anything")).toBe(false);
    expect(isConversationSurface("/polymath/skills/some-id/sub")).toBe(false);
  });

  it("folds the shell only on the chat home and a conversation run", () => {
    expect(isConversationSurface("/polymath")).toBe(true);
    // A single segment that is not a registered static subroute is a run id.
    expect(isConversationSurface("/polymath/abc123")).toBe(true);
    expect(isConversationSurface("/polymath/a1b2c3d4e5f6")).toBe(true);
  });

  /*
   * Regression guard: the predicate must verify the /polymath prefix before
   * slicing it off. A bare slice of an unrelated route yields garbage that
   * reads as an unregistered run id and folds the shell on the entire
   * workspace outside /polymath — the CI-wide failure this case pins shut.
   */
  it("keeps the shell on every route outside /polymath", () => {
    expect(isConversationSurface("/")).toBe(false);
    expect(isConversationSurface("/onboarding")).toBe(false);
    expect(isConversationSurface("/command-center/inbox")).toBe(false);
    expect(isConversationSurface("/command-center/day")).toBe(false);
    expect(isConversationSurface("/neuralflow/work")).toBe(false);
    expect(isConversationSurface("/more")).toBe(false);
  });

  /*
   * Focus pages hide the rail so the page owns the width (spec 5): the note,
   * a learning session, a conversation, a source being read. List and
   * overview pages keep the docked rail.
   */
  it("focus surfaces", () => {
    expect(isFocusSurface("/polymath/notes")).toBe(true);
    expect(isFocusSurface("/learn/abc")).toBe(true);
    expect(isFocusSurface("/projects/p/notebook/flashcards")).toBe(true);
    expect(isFocusSurface("/projects/p/notebook/explain")).toBe(true);
    expect(isFocusSurface("/projects/p/notebook/graph")).toBe(true);
    expect(isFocusSurface("/command-center/conversations/c")).toBe(true);
    expect(isFocusSurface("/polymath/abc123")).toBe(true);
    expect(isFocusSurface("/polymath/library/doc-1")).toBe(true);

    expect(isFocusSurface("/projects")).toBe(false);
    expect(isFocusSurface("/command-center/inbox")).toBe(false);
    expect(isFocusSurface("/polymath")).toBe(false);
    expect(isFocusSurface("/projects/p/notebook")).toBe(false);
    expect(isFocusSurface("/learn")).toBe(false);
    expect(isFocusSurface("/polymath/library")).toBe(false);
    expect(isFocusSurface("/command-center/conversations")).toBe(false);
  });

  it("rail lists Today and People once each", () => {
    const labels = destinations.map((destination) => destination.label);
    expect(labels.filter((label) => label === "Today")).toHaveLength(1);
    expect(labels.filter((label) => label === "People")).toHaveLength(1);
    for (const gone of ["Overview", "Focus", "Work", "Day", "Shut down", "Companies"]) {
      expect(labels, gone).not.toContain(gone);
    }
  });

  /*
   * The planning screens and Companies left the rail but kept their URLs. Each
   * old address still names the entry that absorbed it, so the rail and the
   * breadcrumb stay lit on a deep link, including a dated Day record.
   */
  it("lights Today and People on the routes they absorbed", () => {
    for (const path of [
      "/today",
      "/neuralflow/work",
      "/neuralflow/overview",
      "/neuralflow/focus",
      "/command-center/day",
      "/command-center/day/2026-11-10",
      "/command-center/shutdown",
    ]) {
      expect(destinationForPath(path)?.label, path).toBe("Today");
    }
    expect(destinationForPath("/command-center/relationships/companies")?.label).toBe("People");
    expect(destinationForPath("/command-center/relationships/contacts")?.label).toBe("People");
  });

  it("rails exactly the seventeen destinations in order", () => {
    // Conversations left the rail when its threads moved into the Assistant;
    // the route still resolves (old links keep working) but it is no longer a
    // destination. Decisions left when its queue moved into the header's
    // notifications panel. Ideas arrived as its own top-level surface, taking
    // the zettel, card and area routes that used to hide under the vault
    // prefix. Learning is made in Notebook; Learn, beside it, lists what is due
    // across every Notebook. Today holds the plan, the tasks and the focus
    // timer, with Shut down as its last step; it replaced Work, Overview,
    // Focus, Day and Shut down. People absorbed Companies as a filter. Today
    // and People sit together after the reading surfaces (spec §2: the order
    // follows the loop), then the shared items.
    expect(destinations.map((destination) => destination.label)).toEqual([
      "Polymath",
      "Inbox",
      "Notes",
      "Ideas",
      "Document Vault",
      "Notebook",
      "Learn",
      "Artifacts",
      "Skills",
      "Today",
      "People",
      "Connectors",
      "Supervision",
      "Reviews",
      "Activity",
      "Spending",
      "Settings",
    ]);
  });
});
