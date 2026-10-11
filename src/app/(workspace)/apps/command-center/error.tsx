"use client";

import { Button } from "@/components/ui/button";

export default function ErrorScreen({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <section className="panel m-6 grid gap-3 rounded-xl p-5" role="alert"><h1 className="text-[15px] font-medium">Command Center could not open this screen</h1><p className="text-[13px] text-muted-foreground">The screen or its browser-preview data could not load. Retry without creating a new external action.</p><Button variant="outline" onClick={reset}>Retry screen</Button></section>;
}
