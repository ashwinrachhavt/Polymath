import { describe, expect, it } from "vitest";
import { artifactHref } from "@/components/products/polymath/artifact-controls";
import type { ArtifactKind } from "@/components/workspace/types";
import { previewRedirectTarget } from "@/lib/preview-redirects";

/*
 * The /apps preview tools are retired; every old address must land on a real
 * screen. value: protects=a bookmark or a link saved in a note never 404s or
 * loops back into /apps, and the few deep-link parameters a real screen reads
 * survive; fails_when=a mapping points back under /apps, drops the notes ?id=
 * or Work's ?task=/?date=, or forwards a preview id to a screen that reads it
 * as something else; no_claim=the redirect itself runs in the page (Next
 * redirect), which e2e owns.
 */

const target = (url: string) => {
  const parsed = new URL(url, "https://axiom.example.test");
  const [, , ...path] = parsed.pathname.split("/");
  return previewRedirectTarget(path.filter(Boolean), Object.fromEntries(parsed.searchParams));
};

describe("preview redirects", () => {
  it.each([
    ["/apps", "/polymath"],
    ["/apps/command-center", "/neuralflow/work?view=today"],
    ["/apps/command-center/inbox", "/command-center/inbox"],
    ["/apps/command-center/contacts?id=contact-1", "/command-center/relationships/people"],
    ["/apps/command-center/documents", "/polymath/knowledge"],
    ["/apps/neuralflow", "/neuralflow/overview"],
    ["/apps/neuralflow/boards", "/neuralflow/work?view=board"],
    ["/apps/neuralflow/focus", "/neuralflow/focus"],
    ["/apps/neuralflow/reports", "/neuralflow/reports"],
    ["/apps/neuralflow/rewards", "/learn/stones"],
    ["/apps/polymath", "/polymath"],
    ["/apps/polymath/library?id=doc-1", "/polymath/knowledge"],
    ["/apps/polymath/zettels", "/polymath/ideas"],
    ["/apps/polymath/dictionary", "/polymath/ideas"],
    ["/apps/polymath/canvas", "/artifacts"],
  ])("sends %s to %s", (from, to) => {
    expect(target(from)).toBe(to);
  });

  it("carries the deep-link parameters the destination reads", () => {
    expect(target("/apps/polymath/notebook?id=note%201")).toBe("/polymath/notes?id=note%201");
    expect(target("/apps/neuralflow/tasks?task=t-1")).toBe("/neuralflow/work?task=t-1");
    expect(target("/apps/neuralflow/calendar?date=2026-10-12")).toBe("/neuralflow/work?view=calendar&date=2026-10-12");
    expect(target("/apps/polymath/canvas?canvasId=c%2F1")).toBe("/polymath/canvas/c%2F1");
  });

  it("sends an unknown, too-deep or prototype-named address to /polymath", () => {
    expect(target("/apps/polymath/not-a-screen")).toBe("/polymath");
    expect(target("/apps/nope/inbox")).toBe("/polymath");
    expect(target("/apps/polymath/notebook/extra")).toBe("/polymath");
    expect(target("/apps/polymath/constructor")).toBe("/polymath");
    expect(target("/apps/__proto__/toString")).toBe("/polymath");
  });

  it("drops a repeated parameter instead of picking one", () => {
    expect(previewRedirectTarget(["polymath", "notebook"], { id: ["a", "b"] })).toBe("/polymath/notes");
  });

  it("resolves every link the editor's preview fallback writes to a real screen", () => {
    const kinds: ArtifactKind[] = ["source", "document", "note", "zettel", "dossier", "canvas"];
    for (const kind of kinds) {
      const resolved = target(artifactHref({ id: "x", kind, tags: [] }));
      expect(resolved, kind).not.toMatch(/^\/apps(\/|$)/);
      expect(resolved, kind).not.toBe("/polymath");
    }
    expect(target(artifactHref({ id: "n1", kind: "note", tags: [] }))).toBe("/polymath/notes?id=n1");
    expect(target(artifactHref({ id: "b1", kind: "note", tags: ["Blog draft"] }))).toBe("/polymath/notes");
  });
});
