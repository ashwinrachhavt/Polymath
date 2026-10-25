"use client";

import { useEffect, useState } from "react";

/*
 * The home's greeting line. It disappears the moment a conversation starts in
 * place: the transcript is the page then, and a "What would you like to work
 * on?" above an active conversation is a question already being answered.
 *
 * NewConversation dispatches "polymath:chat-started" on window when the run
 * opens; this listens. A reload resets to the greeting, which is correct —
 * a fresh home has no conversation.
 */
export function HomeGreeting() {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    function onStarted() {
      setHidden(true);
    }
    window.addEventListener("polymath:chat-started", onStarted);
    return () => window.removeEventListener("polymath:chat-started", onStarted);
  }, []);

  if (hidden) return null;
  return <h1 className="text-center text-2xl font-medium">What would you like to work on?</h1>;
}

/** Fired by NewConversation when its in-place conversation mounts. */
export function announceChatStarted() {
  window.dispatchEvent(new Event("polymath:chat-started"));
}
