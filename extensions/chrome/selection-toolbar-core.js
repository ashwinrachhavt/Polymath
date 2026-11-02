/**
 * Selection toolbar — the verb catalog and its truthfulness contract.
 *
 * Pure module (no chrome.*, no DOM), loaded both as a plain script
 * (content.js) and as a CommonJS module (vitest), same split as
 * outbox-core.js: the content script owns pixels, this module owns the
 * decisions so they can be unit-tested in Node.
 *
 * History: the toolbar once offered "Save to Notes" and "Save to Library"
 * as two buttons wired to the same function — two labels promising a
 * distinction the code never had. build() makes that shape impossible to
 * ship again: a toolbar whose labels lie does not render at all.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AxiomSelectionToolbar = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /**
   * The verbs, in render order. One save verb: a selection lands in
   * Polymath's inbox, and the inbox's suggestion card proposes what it
   * becomes (a note, a library document, a task). The destination is a
   * decision the owner makes there, never here — so the label may not
   * pretend the toolbar already made it.
   */
  const VERBS = [
    { id: "save", label: "Save to Polymath" },
    { id: "summarize", label: "Summarize" },
  ];

  /**
   * Build the button specs for the toolbar. `handlers` maps verb id → the
   * function the click runs. Throws rather than rendering a lying toolbar:
   *   - a verb with no handler would render a dead button;
   *   - two verbs sharing one handler is the old "Save to Notes" ≡ "Save
   *     to Library" lie — two labels, one behavior;
   *   - a duplicated label renders two buttons with the same name.
   *
   * Returns [{ id, label, run }] in VERBS order.
   */
  function build(handlers) {
    const specs = VERBS.map(function (verb) {
      const handler = handlers ? handlers[verb.id] : undefined;
      if (typeof handler !== "function") {
        throw new Error(`Selection toolbar verb "${verb.id}" has no handler.`);
      }
      return { id: verb.id, label: verb.label, run: handler };
    });
    const byLabel = new Map();
    for (const spec of specs) {
      if (byLabel.has(spec.label)) {
        throw new Error(`Selection toolbar has two buttons labeled "${spec.label}".`);
      }
      byLabel.set(spec.label, spec);
    }
    const behaviors = new Set();
    for (const spec of specs) {
      if (behaviors.has(spec.run)) {
        throw new Error(
          "Selection toolbar has two labels wired to the same behavior — the buttons lie. Give each label its own action or drop one.",
        );
      }
      behaviors.add(spec.run);
    }
    return specs;
  }

  return { VERBS, build };
});
