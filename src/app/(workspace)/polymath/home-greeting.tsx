"use client";

import { useState } from "react";
import { useChatStarted } from "@/components/chat/chat-events";

/*
 * The home's greeting line. It disappears the moment a conversation starts in
 * place: the transcript is the page then, and a "What would you like to work
 * on?" above an active conversation is a question already being answered.
 */
export function HomeGreeting() {
  const [hidden, setHidden] = useState(false);
  useChatStarted(() => setHidden(true));

  if (hidden) return null;
  return <h1 className="screen-title text-center">What would you like to work on?</h1>;
}
