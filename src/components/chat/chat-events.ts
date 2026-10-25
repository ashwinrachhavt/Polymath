"use client";

import { useEffect } from "react";

/*
 * The one in-page signal that a conversation has started: the composer island
 * announces it, and the chrome around the transcript (a greeting line, a
 * settings rail) folds away. Dispatchers and consumers sit under different
 * server components, so React context cannot carry it; a DOM event on window
 * is the seam. A reload resets it, which is correct for a fresh page.
 */

const CHAT_STARTED = "polymath:chat-started";

export function announceChatStarted() {
  window.dispatchEvent(new Event(CHAT_STARTED));
}

export function useChatStarted(handler: () => void) {
  useEffect(() => {
    window.addEventListener(CHAT_STARTED, handler);
    return () => window.removeEventListener(CHAT_STARTED, handler);
  }, [handler]);
}
