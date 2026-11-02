import { describe, expect, it } from "vitest";
// The extension ships plain scripts; the toolbar contract is exported for Node.
import Toolbar from "../../extensions/chrome/selection-toolbar-core.js";

/*
 * Honesty pins (capture honesty pass). The selection toolbar once offered
 * "Save to Notes" and "Save to Library" as two buttons wired to the same
 * function — two labels promising a distinction the code never had. These
 * tests pin the contract that shape cannot return: one truthful save verb,
 * no label naming a destination the toolbar does not choose, and a build
 * that refuses two labels wired to one behavior.
 */
describe("selection toolbar truthfulness", () => {
  it("ships one save verb", () => {
    const saves = Toolbar.VERBS.filter((verb) => verb.id === "save");
    expect(saves).toHaveLength(1);
  });

  it("labels no verb with a destination the toolbar does not choose", () => {
    // The inbox decides note vs library vs task; the capture surface never
    // pretends otherwise. A future verb that genuinely targets a destination
    // needs its own id and its own behavior — not a label that lies.
    const destinationLabels = Toolbar.VERBS.map((verb) => verb.label).filter((label) => /notes|library/i.test(label));
    expect(destinationLabels).toEqual([]);
  });

  it("gives every verb a unique id and a unique label", () => {
    const ids = Toolbar.VERBS.map((verb) => verb.id);
    const labels = Toolbar.VERBS.map((verb) => verb.label);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("wires Summarize to its own behavior, not a second save label", () => {
    const specs = Toolbar.build({
      save: () => undefined,
      summarize: () => undefined,
    });
    expect(specs.map((spec) => spec.id)).toEqual(["save", "summarize"]);
    expect(specs.map((spec) => spec.label)).toEqual(["Save to Polymath", "Summarize"]);
    expect(specs[0].run).not.toBe(specs[1].run);
  });

  it("refuses to build a toolbar whose labels lie — two labels, one behavior", () => {
    // The exact shape that shipped: distinct labels sharing one function.
    const sameBehavior = () => undefined;
    expect(() =>
      Toolbar.build({
        save: sameBehavior,
        summarize: sameBehavior,
      }),
    ).toThrow(/same behavior/);
  });

  it("refuses a dead button — a verb with no handler", () => {
    expect(() => Toolbar.build({})).toThrow(/no handler/);
  });
});
