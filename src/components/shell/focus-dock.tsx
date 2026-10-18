"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Timer } from "lucide-react";
import { useWorkspace } from "@/components/workspace/workspace-provider";

export function FocusDock() {
  const { state } = useWorkspace();
  const pathname = usePathname();
  if (!state.focus || pathname === "/neuralflow/focus" || pathname === "/apps/neuralflow/focus") return null;
  const task = state.tasks.find((record) => record.id === state.focus?.taskId);
  return <aside aria-label="Preview focus session" className="sticky bottom-0 mt-auto border-t border-border bg-background/95 px-4 py-2 backdrop-blur">
    <Link href="/neuralflow/focus" className="flex min-h-8 items-center gap-3 rounded-md text-[13px] hover:text-app-accent">
      <Timer aria-hidden className="size-4 shrink-0 text-app-accent" />
      <span className="readout shrink-0 text-xs">Focus {state.focus.status}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{task?.title || "Untitled task"}</span>
      <span className="shrink-0 text-xs">Return to session</span>
    </Link>
  </aside>;
}
