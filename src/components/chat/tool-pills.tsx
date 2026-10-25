"use client";

import { useState } from "react";
import { Check, ChevronRight, CircleDashed, Loader2, Wrench } from "lucide-react";
import { cn } from "cn";
import type { ChatState } from "./use-chat-stream";
import { INTERNAL_TOOLS, toolLabel } from "./tool-labels";

/*
 * Tool activity as the conversation shows it, in the style of a good agent
 * transcript (Linear-style embedded activity): the turn's tool calls render as
 * a quiet list of pills under the reasoning and above the answer — running
 * with a spinner, settled with their one-line outcome, and each expandable to
 * the real payload. No collapsed "N steps" line: the work is visible where it
 * happened.
 */

export type ToolEntry = ChatState["tools"][number];

export function ToolPills({ tools }: { tools: ToolEntry[] }) {
  const visible = tools.filter((tool) => !INTERNAL_TOOLS.test(tool.label));
  if (visible.length === 0) return null;
  return (
    <div className="my-2 flex flex-col gap-1" aria-label="Tool activity">
      {visible.map((tool) => (
        <ToolPill key={tool.callId} tool={tool} />
      ))}
    </div>
  );
}

function ToolPill({ tool }: { tool: ToolEntry }) {
  const [open, setOpen] = useState(false);
  const running = tool.status === "running";
  const failed = tool.status === "error";
  const hasPayload = tool.input !== undefined || tool.output !== undefined;

  return (
    <div className="w-fit max-w-full">
      <button
        type="button"
        aria-expanded={open}
        disabled={!hasPayload && !running}
        onClick={() => hasPayload && setOpen((v) => !v)}
        className={cn(
          "group flex w-fit max-w-full items-center gap-2 rounded-full border border-border bg-card px-2.5 py-1 text-[12.5px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
          hasPayload ? "cursor-pointer hover:bg-muted" : "cursor-default",
          failed ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {running ? (
          <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
        ) : failed ? (
          <CircleDashed aria-hidden className="size-3.5 shrink-0" />
        ) : (
          <Check aria-hidden className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{toolLabel(tool.label)}</span>
        {tool.detail && !running ? <span className="hidden truncate opacity-70 sm:inline">{tool.detail}</span> : null}
        {hasPayload ? (
          <ChevronRight
            aria-hidden
            className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
          />
        ) : null}
      </button>
      {open && hasPayload ? (
        <div className="mt-1 max-h-64 overflow-auto rounded-lg border border-border bg-muted/40 p-2.5">
          <PayloadSection title={tool.input !== undefined ? "Input" : null} value={tool.input} />
          <PayloadSection title={tool.output !== undefined ? "Result" : null} value={tool.output} />
        </div>
      ) : null}
    </div>
  );
}

function PayloadSection({ title, value }: { title: string | null; value: unknown }) {
  if (value === undefined || title === null) return null;
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium text-muted-foreground">{title}</p>
      <pre className="mt-0.5 overflow-x-auto text-[11.5px] leading-5 text-foreground/90">{text}</pre>
    </div>
  );
}

/** A reasoning-style quiet header for a tool cluster, matching the ThinkingPill language. */
export function ToolActivityHeader({ count, running }: { count: number; running: boolean }) {
  if (count === 0) return null;
  return (
    <p className="text-muted-foreground mt-1 flex items-center gap-1.5 text-[12px]">
      <Wrench aria-hidden className="size-3" />
      {running ? "Working…" : `${count} step${count === 1 ? "" : "s"}`}
    </p>
  );
}
