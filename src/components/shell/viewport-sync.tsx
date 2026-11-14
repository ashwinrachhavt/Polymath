"use client";

import { useEffect } from "react";

/*
 * Keeps the shell the size of what the person can actually see. On a phone the
 * on-screen keyboard covers the bottom of the page without resizing the layout
 * viewport, so a fixed-height conversation would slide its composer under the
 * keys and the browser would scroll the whole page to find it. The visual
 * viewport does shrink, so this publishes its height as --vvh (read by
 * .shell-conversation) and marks <html data-keyboard> while the keyboard is up
 * so the bottom bar can step aside.
 *
 * Only a scale of 1 counts: pinch-zooming also shrinks the visual viewport, and
 * the layout must not shrink with it. Renders nothing.
 */

/** The keyboard is "up" once at least this much of the screen is gone. */
const KEYBOARD_MIN_PX = 120;

export function ViewportSync() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;

    function sync() {
      if (!viewport || viewport.scale !== 1) return;
      const hidden = window.innerHeight - viewport.height;
      if (hidden >= KEYBOARD_MIN_PX) {
        root.style.setProperty("--vvh", `${Math.round(viewport.height)}px`);
        root.setAttribute("data-keyboard", "");
        // iOS pans the page to reveal a focused field. A conversation shell already fits
        // above the keys, so pan back; an ordinary page keeps the browser's own scroll.
        if (window.scrollY !== 0 && document.querySelector(".shell-conversation")) window.scrollTo(0, 0);
      } else {
        root.style.removeProperty("--vvh");
        root.removeAttribute("data-keyboard");
      }
    }

    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      root.style.removeProperty("--vvh");
      root.removeAttribute("data-keyboard");
    };
  }, []);

  return null;
}
