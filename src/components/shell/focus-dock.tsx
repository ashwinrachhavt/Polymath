"use client";
import Link from "next/link";
import { Timer } from "lucide-react";
import { useWorkspace } from "@/components/workspace/workspace-provider";
export function FocusDock() { const {state} = useWorkspace(); if (!state.focus) return null; const task = state.tasks.find((t) => t.id === state.focus?.taskId); return <Link href="/apps/neuralflow/focus" className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs"><Timer aria-hidden className="size-4 text-primary"/><span className="min-w-0"><span className="block font-medium">Focus {state.focus.status}</span><span className="block max-w-40 truncate text-[11px] text-muted-foreground">{task?.title || "Untitled task"}</span></span></Link>; }
