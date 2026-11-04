"use client";

import { useState } from "react";
import { Bot, ChevronDown } from "lucide-react";
import { cn } from "cn";

/*
 * The agent panel, folded into the conversation header the way AI Elements
 * shows it: who is working, the procedure it was given, and the capability
 * ceiling its policy allowed — collapsed, because a reader checking an answer
 * rarely needs the whole policy in front of them.
 *
 * It reports the run's frozen snapshot, not the profile's current row: the
 * profile can be edited while a run is going, and showing the newer
 * instructions beside an answer they did not produce would be a lie.
 *
 * The capability list is a ceiling, never a log: what the run actually called
 * is the chain of thought, which is written from tool_calls. Labelling this
 * list "Tools" made a granted-but-unused catalog read as a wall of calls.
 */

export type AgentPanelData = {
  name: string;
  model: string | null;
  instructions: string | null;
  /** `id` is the raw capability name and is the list's identity; `name` may repeat. */
  tools: { id: string; name: string; description: string | null }[];
  /** Every capability the run's frozen policy allows, offered or not. */
  ceiling: number;
  /** Granted capabilities the gateway never advertises to the model. */
  unadvertised: number;
};

export function AgentPanel({ agent, defaultOpen = false }: { agent: AgentPanelData; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [openTool, setOpenTool] = useState<string | null>(null);

  return (
    <div className="my-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1.5 rounded text-[13px] outline-none transition-colors focus-visible:ring-2"
      >
        <Bot aria-hidden className="size-3.5" />
        <span className="truncate">{agent.name}</span>
        {agent.model ? <span className="readout shrink-0 text-[11px] opacity-80">{agent.model}</span> : null}
        <ChevronDown aria-hidden className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open ? (
        <div className="border-border mt-2 flex flex-col gap-3 rounded-lg border px-3.5 py-3">
          {agent.instructions ? (
            <div className="flex flex-col gap-1">
              <p className="text-muted-foreground text-[11px] font-medium">Instructions</p>
              <p className="text-[13px] leading-5 whitespace-pre-wrap">{agent.instructions}</p>
            </div>
          ) : null}

          {agent.ceiling > 0 ? (
            <div className="flex flex-col gap-1">
              {/*
                The list is the run's policy ceiling, not a record of calls.
                "Tools" read as "tools this answer used", which is how a
                granted-but-never-invoked catalog looked like a wall of calls.
              */}
              <p className="text-muted-foreground text-[11px] font-medium">
                Policy ceiling · {agent.ceiling} {agent.ceiling === 1 ? "capability" : "capabilities"}
              </p>
              <p className="text-muted-foreground text-[11px] leading-4">
                What the run was allowed to call. The chain of thought above shows what it actually called.
              </p>
              <ul className="flex flex-col">
                {agent.tools.map((tool) => {
                  const expanded = openTool === tool.id;
                  const descId = `tool-desc-${tool.id.replace(/[^a-z0-9]+/gi, "-")}`;
                  return (
                    <li key={tool.id} className="border-border not-last:border-b">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={descId}
                        disabled={!tool.description}
                        onClick={() => setOpenTool(expanded ? null : tool.id)}
                        className="hover:bg-muted/60 focus-visible:ring-ring flex h-8 w-full items-center gap-2 rounded px-1 text-left text-[13px] outline-none transition-colors focus-visible:ring-2 disabled:cursor-default"
                      >
                        <span className="min-w-0 flex-1 truncate">{tool.name}</span>
                        {tool.description ? (
                          <ChevronDown
                            aria-hidden
                            className={cn(
                              "text-muted-foreground size-3 shrink-0 transition-transform",
                              expanded && "rotate-180",
                            )}
                          />
                        ) : null}
                      </button>
                      {expanded && tool.description ? (
                        <p id={descId} className="text-muted-foreground px-1 pb-2 text-[12px] leading-5">
                          {tool.description}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {agent.unadvertised > 0 ? (
                <p className="text-muted-foreground border-border border-t pt-2 text-[11px] leading-4">
                  {agent.unadvertised} more granted {agent.unadvertised === 1 ? "capability is" : "capabilities are"}{" "}
                  not offered to the model on this deployment yet. They stay in the policy ceiling so the record is
                  honest.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
