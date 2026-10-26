"use client";

import { useState } from "react";
import { Brain, Check, ChevronRight, Loader2, Search, Globe, FileText } from "lucide-react";
import { cn } from "cn";
import type { RecordReference } from "./record-links";
import { RecordCards } from "./record-card";

/*
 * Chain of thought, as AI Elements draws it: one collapsible block that holds
 * the model's visible reasoning and the tool steps in the order they ran,
 * collapsed by default so the answer stays the thing being read.
 *
 * Polymath's transport has no separate "step" frames — reasoning arrives as a
 * block and tool calls as their own entries — so this component takes both and
 * interleaves them by arrival. It deliberately does not infer a pipeline: what
 * it shows is what the run actually did.
 */

export type ThoughtStep = {
  id: string;
  kind: "reasoning" | "tool";
  label: string;
  detail?: string;
  text?: string;
  status: "running" | "complete" | "error";
  /** The tool's own name, used to pick a mark. */
  tool?: string;
  /**
   * Records the step read or wrote. Rendered as cards inside the step, so
   * "show me my open tasks" can answer in place — the record is the answer,
   * not a footnote to it.
   */
  records?: RecordReference[];
};

export function ChainOfThought({
  steps,
  streaming,
  defaultOpen = false,
}: {
  steps: ThoughtStep[];
  streaming: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (steps.length === 0) return null;
  const failed = steps.some((step) => step.status === "error");
  const label = streaming ? "Thinking" : failed ? "Thought, then hit a problem" : "Thought for a moment";

  return (
    <div className="my-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1.5 rounded text-[13px] outline-none transition-colors focus-visible:ring-2"
      >
        {streaming ? (
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
        ) : (
          <Brain aria-hidden className="size-3.5" />
        )}
        <span>{label}</span>
        <ChevronRight
          aria-hidden
          className={cn("size-3 transition-transform", open && "rotate-90")}
        />
      </button>

      {open ? (
        <ol className="border-border ml-1.5 mt-2 flex flex-col gap-2.5 border-l pl-4">
          {steps.map((step) => (
            <li key={step.id} className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-[13px]">
                <StepMark step={step} />
                <span className={cn("truncate", step.status === "error" && "text-destructive")}>
                  {step.label}
                </span>
                {step.detail ? (
                  <span className="text-muted-foreground shrink-0 text-[11px] opacity-80">
                    {step.detail}
                  </span>
                ) : null}
              </span>
              {step.text ? (
                <p className="text-muted-foreground whitespace-pre-wrap text-[13px] leading-5">
                  {step.text}
                </p>
              ) : null}
              {step.records && step.records.length > 0 ? <RecordCards records={step.records} /> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function StepMark({ step }: { step: ThoughtStep }) {
  const className = "size-3.5 shrink-0";
  if (step.status === "running") return <Loader2 aria-hidden className={cn(className, "animate-spin")} />;
  if (step.kind === "reasoning") return <Brain aria-hidden className={className} />;
  // A tool's name is the only signal available for which mark fits; anything
  // unrecognised gets the neutral check rather than a wrong claim about it.
  if (/search/i.test(step.tool ?? "")) return <Search aria-hidden className={className} />;
  if (/fetch|web|url/i.test(step.tool ?? "")) return <Globe aria-hidden className={className} />;
  if (/document|wiki|note/i.test(step.tool ?? "")) return <FileText aria-hidden className={className} />;
  return <Check aria-hidden className={className} />;
}
