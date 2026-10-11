"use client";
import Link from "next/link";
import { FlaskConical } from "lucide-react";
export function PreviewBanner() { return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground"><FlaskConical aria-hidden className="size-3.5"/><span><strong className="font-medium text-foreground">Interactive preview</strong> — fictional sample data. Changes stay in this browser; Neon, AI and providers are not connected.</span><Link href="/apps/command-center/settings" className="ml-auto whitespace-nowrap text-foreground underline underline-offset-2">Setup & safety</Link></div>; }
