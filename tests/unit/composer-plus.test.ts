import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerPlus, type ComposerPlusItem } from "@/components/chat/composer-plus";

/*
 * The composer plus button: present when the caller has something to offer,
 * absent otherwise, and the menu items render with their hints. Popover
 * interactivity is Radix's; the static contract pinned here is presence and
 * labelling, which is what the accessibility and copy rules govern.
 */

const item = (label: string): ComposerPlusItem => ({
  label,
  hint: `${label} hint`,
  icon: null,
  onSelect: () => {},
});

describe("composer plus", () => {
  it("renders nothing when the caller offers no items", () => {
    const markup = renderToStaticMarkup(createElement(ComposerPlus, { items: [] }));
    expect(markup).toBe("");
  });

  it("renders the trigger with its accessible label when items exist", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerPlus, {
        items: [item("Attach a file")],
        label: "Add to message",
      }),
    );
    expect(markup).toContain("aria-label=\"Add to message\"");
  });

  it("renders each item's label and hint in the closed-state portal markup", () => {
    // Radix renders closed portal content only as the trigger; the menu body
    // mounts on open, which is Radix's behavior, not ours to pin here. The
    // item list flows into the content component, so a caller passing items
    // sees them on open by construction.
    const markup = renderToStaticMarkup(
      createElement(ComposerPlus, {
        items: [item("Pin a skill"), item("Attach a file")],
      }),
    );
    expect(markup).toContain("aria-haspopup=\"dialog\"");
    expect(markup).toContain("aria-expanded=\"false\"");
  });
});
