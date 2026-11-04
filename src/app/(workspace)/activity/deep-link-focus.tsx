"use client";

import { useEffect } from "react";

/*
 * Deep-link mechanics for /activity?event=<id>: scroll the target row into
 * view and mark it. The page renders the highlight in the markup (ring and
 * disclosure state), so this component only scrolls and re-marks on client
 * navigation - a router.replace that drops the event param would otherwise
 * un-highlight the row the viewer is reading. No timer: the flash settles in
 * CSS.
 */
export function DeepLinkFocus({ targetId }: { targetId: string }) {
  useEffect(() => {
    const el = document.getElementById(`event-${targetId}`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.dataset.deepLinked = "true";
    return () => {
      delete el.dataset.deepLinked;
    };
  }, [targetId]);
  return null;
}
