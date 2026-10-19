"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { isBrowserPreviewPath } from "@/lib/navigation";

export function PreviewBanner() {
  const pathname = usePathname();
  const view = useSearchParams().get("view");
  if (!isBrowserPreviewPath(pathname)) return null;
  // Saved tasks, board and calendar are read from and written to the workspace, not the browser preview.
  if (pathname === "/neuralflow/work" && (view === "saved" || view === "board" || view === "calendar")) return null;
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground">
    <FlaskConical aria-hidden className="size-3.5" />
    <span><strong className="font-medium text-foreground">Interactive preview</strong>. Fictional samples and browser-only changes. These tools do not execute AI or provider actions.</span>
    <Link href="/settings" className="ml-auto min-h-6 whitespace-nowrap text-foreground underline underline-offset-2">Setup and safety</Link>
  </div>;
}
