"use client";

import { Button } from "@/components/ui/button";

export default function AlfredError({ reset }: { reset: () => void }) {
  return <div role="alert" className="suite-screen"><h1 className="text-lg font-medium">Polymath could not open this screen</h1><p className="mt-2 max-w-xl text-[13px] leading-relaxed text-muted-foreground">Reload the screen to try again. Browser-only saved artifacts remain local; unconnected providers have not performed any work.</p><Button onClick={reset} variant="outline" className="mt-4">Retry screen</Button></div>;
}
