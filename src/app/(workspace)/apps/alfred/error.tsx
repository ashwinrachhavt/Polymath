"use client";

import { Button } from "@/components/ui/button";

/*
 * The copy never claims an outcome: a render crash cannot know whether an
 * earlier write committed or whether a provider call ran.
 */
export default function AlfredError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div role="alert" className="suite-screen"><h1 className="text-lg font-medium">Polymath could not open this screen</h1><p className="mt-2 max-w-xl text-[13px] leading-relaxed text-muted-foreground">Reload the screen to try again. Any change you already submitted may still have gone through; check the current state before resubmitting it.</p><div className="mt-4 flex items-center gap-3"><Button onClick={reset} variant="outline">Retry screen</Button>{error.digest ? <span className="font-mono text-xs text-muted-foreground">{error.digest}</span> : null}</div></div>;
}
