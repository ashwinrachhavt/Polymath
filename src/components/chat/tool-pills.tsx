"use client";

import { memo, useState } from "react";
import { Check, ChevronRight, CircleDashed, ExternalLink, Loader2 } from "lucide-react";
import { cn } from "cn";
import type { ChatState } from "./use-chat-stream";
import { INTERNAL_TOOLS, toolLabel } from "./tool-labels";
import { collectRecords } from "./record-links";
import { RecordCards } from "./record-card";

/*
 * Tool activity as the conversation shows it, in the style of a good agent
 * transcript (Linear-style embedded activity): the turn's tool calls render as
 * a quiet list of pills under the reasoning and above the answer — running
 * with a spinner, settled with their one-line outcome, and each expandable to
 * a structured preview. No collapsed "N steps" line: the work is visible where
 * it happened.
 *
 * The expansion is the AI Elements Tool pattern: a payload becomes the
 * component that names what came back — a source list for search results, an
 * item list for any array, raw JSON only for shapes with no better form. Raw
 * provider JSON is the fallback, never the default face.
 */

export type ToolEntry = ChatState["tools"][number];

// memo, not preference: ChatSurface re-renders on every text delta while the
// tools array only changes on tool frames, so delta frames skip this subtree.
export const ToolPills = memo(function ToolPills({ tools }: { tools: ToolEntry[] }) {
  const visible = tools.filter((tool) => !INTERNAL_TOOLS.test(tool.label));
  if (visible.length === 0) return null;
  return (
    <div className="my-2 flex flex-col gap-1" aria-label="Tool activity">
      {visible.map((tool) => (
        <ToolPill key={tool.callId} tool={tool} />
      ))}
    </div>
  );
});

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
      {/* Records a read returned render as cards under the pill, without an
          expand: "show me my open tasks" should show the tasks, not a chip
          that hides them behind a click. */}
      <ToolRecords output={tool.output} />
      {open && hasPayload ? (
        <div className="mt-1 max-h-72 overflow-auto rounded-lg border border-border bg-card p-3">
          <ToolInput input={tool.input} />
          <ToolResult output={tool.output} />
        </div>
      ) : null}
    </div>
  );
}

/** The records a read returned, as cards. Null when the output carries none. */
function ToolRecords({ output }: { output: unknown }) {
  const records = collectRecords(output);
  if (records.length === 0) return null;
  return <RecordCards records={records} />;
}

/*
 * The call's arguments. Query-shaped inputs read as the question asked;
 * anything else falls back to compact JSON.
 */
function ToolInput({ input }: { input: unknown }) {
  if (input === undefined) return null;
  const query = (input as { query?: unknown } | null)?.query;
  if (typeof query === "string" && query.length > 0) {
    return (
      <p className="text-muted-foreground text-[12.5px]">
        <span className="text-[11px] font-medium uppercase tracking-wide">Query</span>
        <span className="text-foreground ml-2">{query}</span>
      </p>
    );
  }
  return <JsonBlock value={input} label="Input" />;
}

/*
 * The result. Search-shaped outputs (a results array of {title, url} or
 * {title, snippet}) render as a source list with links, the way AI Elements'
 * web-preview and sources render citations. Arrays render as countable item
 * lists. Everything else is compact JSON.
 */
function ToolResult({ output }: { output: unknown }) {
  if (output === undefined) return null;
  const sources = extractSources(output);
  if (sources.length > 0) {
    return (
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Sources</p>
        <ul className="mt-1.5 flex flex-col gap-1">
          {sources.map((source, index) => (
            <li key={`${source.url ?? index}`} className="min-w-0">
              {source.url ? (
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-[13px] text-foreground/90 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ExternalLink aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{source.title}</span>
                </a>
              ) : (
                <span className="flex min-w-0 items-center gap-1.5 px-1 py-0.5 text-[13px] text-foreground/90">
                  <span aria-hidden className="size-1 shrink-0 rounded-full bg-muted-foreground" />
                  <span className="truncate">{source.title}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const items = extractItemList(output);
  if (items.length > 0) {
    return (
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {items.length} item{items.length === 1 ? "" : "s"}
        </p>
        <ul className="mt-1.5 flex flex-col gap-0.5">
          {items.slice(0, 8).map((item, index) => (
            <li key={index} className="truncate px-1 py-0.5 text-[13px] text-foreground/90">
              {item}
            </li>
          ))}
          {items.length > 8 ? (
            <li className="text-muted-foreground px-1 text-[12px]">+{items.length - 8} more</li>
          ) : null}
        </ul>
      </div>
    );
  }
  return <JsonBlock value={output} label="Result" />;
}

/** A {title, url?} row from a results array; null when the entry has no readable title. */
function asSource(entry: unknown): { title: string; url?: string } | null {
  if (typeof entry === "string") return { title: entry };
  if (entry === null || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const title = record.title ?? record.name;
  if (typeof title !== "string" || title.length === 0) return null;
  const url = typeof record.url === "string" ? record.url : undefined;
  return { title, url };
}

/** Search-shaped outputs: any results/messages array whose entries read as sources. */
function extractSources(output: unknown): Array<{ title: string; url?: string }> {
  if (output === null || typeof output !== "object") return [];
  const record = output as Record<string, unknown>;
  const list = record.results ?? record.messages ?? record.items;
  if (!Array.isArray(list)) return [];
  const sources = list.map(asSource).filter((s): s is { title: string; url?: string } => s !== null);
  // A list where most entries lack titles is data, not sources; only render
  // as a source list when the shape mostly holds.
  return sources.length >= Math.ceil(list.length * 0.6) ? sources : [];
}

/** A list of readable strings from an array of titles/names/lines. */
function extractItemList(output: unknown): string[] {
  if (Array.isArray(output)) {
    return output.map((entry) => (typeof entry === "string" ? entry : null)).filter((s): s is string => s !== null && s.length > 0);
  }
  if (output === null || typeof output !== "object") return [];
  const record = output as Record<string, unknown>;
  const list = record.results ?? record.items ?? record.lines;
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      if (typeof entry === "string" && entry.length > 0) return entry;
      const title = (entry as Record<string, unknown> | null)?.title;
      return typeof title === "string" && title.length > 0 ? title : null;
    })
    .filter((s): s is string => s !== null);
}

/** The fallback: labeled, compact, scrollable JSON. */
function JsonBlock({ value, label }: { value: unknown; label: string }) {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <pre className="mt-1 max-h-48 overflow-auto text-[11.5px] leading-5 text-foreground/90">{text}</pre>
    </div>
  );
}
