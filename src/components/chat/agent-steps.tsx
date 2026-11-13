"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { AlertCircle, Brain, Check, ChevronRight, FileText, Globe, Loader2, Search } from "lucide-react";
import { cn } from "cn";
import { sourceHost, type StepKind, type StepSource } from "@/domains/agents/agent-steps";
import type { RecordReference } from "./record-links";
import { RecordCards } from "./record-card";

/*
 * What the agent did for one answer, as one card above that answer: the
 * searches it ran, the pages and documents it read, the tools it called, and
 * its visible reasoning, in the order they happened.
 *
 * While the turn runs the card is open and its header names the step in
 * progress ("Searching the web for “…”"); sources appear under their step as
 * they arrive. When the turn ends the card folds to one line that counts what
 * happened ("Searched 2 times · read 1 page · 7 sources") with the sources'
 * site icons beside it. A press reopens it; the person's choice then sticks.
 *
 * The rows are the run's own events (stream frames live, tool_calls after a
 * reload). The card never infers a pipeline or invents a step.
 */

export type StepRow = {
  id: string;
  kind: StepKind | "reasoning";
  /** The step in past tense, e.g. "Searched the web" (tool-labels.ts). */
  label: string;
  query: string | null;
  sources: StepSource[];
  status: "running" | "complete" | "error";
  /** One-line outcome, e.g. "3 results" or an error code. */
  detail?: string;
  /** Visible reasoning text, for a reasoning row. */
  text?: string;
  records?: RecordReference[];
};

/** "Searched the web" → "Searching the web": the live header speaks in the present. */
function presentTense(label: string): string {
  return label
    .replace(/^Searched\b/, "Searching")
    .replace(/^Read\b/, "Reading")
    .replace(/^Checked\b/, "Checking")
    .replace(/^Listed\b/, "Listing")
    .replace(/^Updated\b/, "Updating")
    .replace(/^Reasoned through\b/, "Reasoning through");
}

function liveLabel(step: StepRow | undefined): string {
  if (!step || step.kind === "reasoning") return "Thinking";
  const verb = presentTense(step.label);
  if (!step.query) return verb;
  const target = step.kind === "read" ? (sourceHost(step.query) ?? step.query) : step.query;
  return step.kind === "search" ? `${verb} for “${target}”` : `${verb}: ${target}`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Distinct sources across the card: one per page or document. */
function allSources(steps: StepRow[]): StepSource[] {
  const seen = new Set<string>();
  const out: StepSource[] = [];
  for (const step of steps) {
    for (const source of step.sources) {
      const key = source.documentId ?? source.url ?? source.title;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(source);
    }
  }
  return out;
}

/** The folded card's one line: what happened, counted. */
export function stepsSummary(steps: StepRow[]): string {
  // A failed step is counted once, as a failure, not also as a search or read.
  const count = (kind: StepRow["kind"]) => steps.filter((step) => step.kind === kind && step.status !== "error").length;
  const searches = count("search");
  const reads = count("read");
  const tools = count("tool");
  const failed = steps.filter((step) => step.status === "error").length;
  const sources = allSources(steps).length;
  const parts = [
    searches > 0 ? `Searched ${plural(searches, "time", "times").replace(/^1 time$/, "once")}` : null,
    reads > 0 ? `read ${plural(reads, "page", "pages")}` : null,
    tools > 0 ? `used ${plural(tools, "tool", "tools")}` : null,
    sources > 0 ? plural(sources, "source", "sources") : null,
    failed > 0 ? `${plural(failed, "step", "steps")} failed` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return "Thought it through";
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

export function AgentSteps({ steps, active }: { steps: StepRow[]; active: boolean }) {
  // null until the person presses the header: then their choice wins over
  // the turn's own open-while-working, closed-when-done default.
  const [chosenOpen, setChosenOpen] = useState<boolean | null>(null);
  if (steps.length === 0) return null;
  const working = active || steps.some((step) => step.status === "running");
  const open = chosenOpen ?? working;
  const current = [...steps].reverse().find((step) => step.status === "running");
  const sources = allSources(steps);
  const hosts = [...new Set(sources.flatMap((source) => (source.url ? [sourceHost(source.url)] : [])))]
    .filter((host): host is string => host !== null)
    .slice(0, 4);

  return (
    <div className="my-1" data-agent-steps={working ? "working" : "done"}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setChosenOpen(!open)}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex max-w-full items-center gap-1.5 rounded text-body-dense outline-none transition-colors focus-visible:ring-2"
      >
        {working ? (
          <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
        ) : (
          <Check aria-hidden className="size-3.5 shrink-0" />
        )}
        <span aria-live="polite" className={cn("truncate", working && "step-shimmer")}>
          {working ? liveLabel(current) : stepsSummary(steps)}
        </span>
        {hosts.length > 0 ? (
          <span aria-hidden className="flex shrink-0 -space-x-1">
            {hosts.map((host) => (
              <Favicon key={host} host={host} className="ring-background size-3.5 rounded-full ring-2" />
            ))}
          </span>
        ) : null}
        <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
      </button>

      {open ? (
        <ol className="border-border ml-1.5 mt-2 flex flex-col gap-3 border-l pl-4">
          {steps.map((step) => (
            <li key={step.id} className="flex min-w-0 flex-col gap-1">
              <span className="flex min-w-0 items-center gap-1.5 text-body-dense">
                <StepMark step={step} />
                <span className={cn("shrink-0", step.status === "error" && "text-destructive")}>{step.label}</span>
                {step.query ? (
                  <span className="bg-muted text-muted-foreground min-w-0 truncate rounded px-1.5 text-data leading-5">
                    {step.query}
                  </span>
                ) : null}
                {step.detail ? (
                  <span className="text-muted-foreground shrink-0 text-data opacity-80">{step.detail}</span>
                ) : null}
              </span>
              {step.sources.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5" aria-label={`Sources for ${step.label}`}>
                  {step.sources.map((source, index) => (
                    <motion.li
                      key={source.documentId ?? source.url ?? source.title}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.18, delay: Math.min(index, 8) * 0.045 }}
                    >
                      <SourceChip source={source} />
                    </motion.li>
                  ))}
                </ul>
              ) : null}
              {step.text ? (
                <p className="text-muted-foreground whitespace-pre-wrap text-body-dense leading-5">{step.text}</p>
              ) : null}
              {step.records && step.records.length > 0 ? <RecordCards records={step.records} /> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function SourceChip({ source }: { source: StepSource }) {
  const host = source.url ? sourceHost(source.url) : null;
  const href = source.url ?? (source.documentId ? `/polymath/knowledge?doc=${source.documentId}` : null);
  const body = (
    <>
      {host ? (
        <Favicon host={host} className="size-3.5 rounded-sm" />
      ) : (
        <FileText aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
      )}
      <span className="max-w-[16rem] truncate">{source.title}</span>
      {host ? <span className="text-muted-foreground shrink-0">{host}</span> : null}
    </>
  );
  const className =
    "border-border bg-card/60 text-foreground inline-flex max-w-full items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-data leading-5";
  if (!href) return <span className={className}>{body}</span>;
  return source.url ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(className, "hover:bg-muted/60 focus-visible:ring-ring outline-none focus-visible:ring-2")}
    >
      {body}
    </a>
  ) : (
    <a
      href={href}
      className={cn(className, "hover:bg-muted/60 focus-visible:ring-ring outline-none focus-visible:ring-2")}
    >
      {body}
    </a>
  );
}

/*
 * A site's icon from DuckDuckGo's icon service, sent with no referrer: the
 * browser asks for the host's icon and nothing about the conversation. An icon
 * that fails to load becomes the host's first letter, never a broken image.
 */
function Favicon({ host, className }: { host: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        aria-hidden
        className={cn(
          "bg-muted text-muted-foreground inline-flex shrink-0 items-center justify-center text-[9px] font-medium uppercase",
          className,
        )}
      >
        {host.charAt(0)}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a 14px third-party icon; next/image would proxy it through our server for no gain
    <img
      src={`https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`}
      alt=""
      aria-hidden
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn("bg-muted shrink-0 object-contain", className)}
    />
  );
}

function StepMark({ step }: { step: StepRow }) {
  const className = "size-3.5 shrink-0";
  if (step.status === "running") return <Loader2 aria-hidden className={cn(className, "animate-spin")} />;
  if (step.status === "error") return <AlertCircle aria-hidden className={cn(className, "text-destructive")} />;
  if (step.kind === "reasoning") return <Brain aria-hidden className={className} />;
  if (step.kind === "search") return <Search aria-hidden className={className} />;
  if (step.kind === "read" && step.query && sourceHost(step.query)) return <Globe aria-hidden className={className} />;
  if (step.kind === "read") return <FileText aria-hidden className={className} />;
  return <Check aria-hidden className={className} />;
}
