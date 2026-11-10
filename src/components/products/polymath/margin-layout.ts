export type MarginAnchor = { key: string; top: number; height: number };
export type MarginPlacement = { key: string; top: number; hidden: boolean };

/**
 * Place each margin note at or below the line that cites it, pushing later
 * notes down so none overlap. Anchors are taken in the order given (document
 * order); entries past `maxVisible` are hidden.
 */
export function layoutMarginNotes(anchors: MarginAnchor[], gap = 12, maxVisible = 12): MarginPlacement[] {
  let floor = Number.NEGATIVE_INFINITY;
  return anchors.map((anchor, index) => {
    const top = Math.max(anchor.top, floor);
    floor = top + anchor.height + gap;
    return { key: anchor.key, top, hidden: index >= maxVisible };
  });
}
