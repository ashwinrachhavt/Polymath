"use client";

import { Button } from "@/components/ui/button";

/*
 * The copy never claims an outcome: a render crash cannot know whether an
 * earlier external action was created or whether the preview data saved.
 */
export default function ErrorScreen({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <section className="panel m-6 grid gap-3 rounded-xl p-5" role="alert"><h1 className="text-[15px] font-medium">Polymath could not open this screen</h1><p className="text-[13px] text-muted-foreground">The screen or its browser-preview data could not load. Retry re-renders this screen. Any change you already submitted may still have gone through; check the current state before repeating an action.</p><div className="flex items-center gap-3"><Button variant="outline" onClick={reset}>Retry screen</Button>{error.digest ? <span className="font-mono text-xs text-muted-foreground">{error.digest}</span> : null}</div></section>;
}
