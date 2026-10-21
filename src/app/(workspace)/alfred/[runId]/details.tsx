import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Readout } from "@/components/readout";
import type { DocumentCitation } from "@/domains/knowledge/agent-search";
import { isFinished } from "@/domains/agents/thread";
import { RunControls } from "../run-controls";
import { DraftControls } from "../draft-controls";

/*
 * Everything the home screen deliberately stopped showing about a run lives
 * here: the frozen policy, what it read, the timeline, and the controls. It is
 * a native `<details>` so the transcript keeps the whole page and the
 * instrumentation is one deliberate click away, without a client component.
 */

type RunDetail = {
  id: string;
  state: string;
  model: string | null;
  summary: string | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
};

type TimelineEvent = {
  sequence: number;
  type: string;
  data: unknown;
  createdAt: Date;
};

/** The state in the owner's words, not the enum's. */
const STATE_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  waiting_input: "Waiting for your reply",
  waiting_approval: "Waiting for an approval in Reviews",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

/*
 * The stored model id is a provider routing string ("claude-hive-glm-5.3-flash").
 * Show the readable tail; the full id stays on the title attribute.
 */
function friendlyModelName(model: string) {
  const tail = model.replace(/^[a-z0-9-]*hive-/i, "").replaceAll("-", " ");
  return tail.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** A policy snapshot is jsonb from an older write; read it defensively. */
function policyTools(snapshot: unknown): string[] {
  const tools = (snapshot as { allowedTools?: unknown } | null)?.allowedTools;
  return Array.isArray(tools) ? tools.filter((tool): tool is string => typeof tool === "string") : [];
}

/** The per-run ceiling the profile froze at start, if it stated one. */
function policyCeiling(snapshot: unknown): string | null {
  const budget = (snapshot as { budgetUsd?: unknown } | null)?.budgetUsd;
  const ceiling = (budget as { perRunCeilingUsd?: unknown } | null)?.perRunCeilingUsd;
  return typeof ceiling === "string" && ceiling.trim() !== "" ? ceiling : null;
}

/*
 * The timeline is stored as raw bridge events, and only a few carry a line
 * worth reading. Anything else is shown by its type alone rather than by a
 * JSON dump: the detail is evidence, not a debug console.
 */
function eventLine(event: TimelineEvent): string | null {
  const data = (event.data ?? {}) as { content?: unknown; summary?: unknown; question?: unknown; message?: unknown };
  for (const value of [data.summary, data.content, data.question, data.message]) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-baseline gap-3 py-1.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="min-w-0 text-[13px]">{children}</dd>
    </div>
  );
}

export function RunDetails({
  run,
  policy,
  citations,
  events,
  draft,
  unavailable,
}: {
  run: RunDetail;
  policy: unknown;
  citations: DocumentCitation[];
  events: TimelineEvent[];
  draft: { artifactId: string; status: string } | null;
  unavailable: string | null;
}) {
  const tools = policyTools(policy);
  const ceiling = policyCeiling(policy);
  const finished = isFinished(run.state);
  const canSaveDraft = run.state === "succeeded" || run.state === "waiting_input";

  return (
    <details className="border-t pt-3">
      <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-[13px]">
        Details
      </summary>

      <dl className="mt-2 flex flex-col divide-y divide-border">
        <Row label="Model">
          {run.model ? (
            <Readout title={run.model} className="text-xs">{friendlyModelName(run.model)}</Readout>
          ) : (
            <span className="text-muted-foreground">not recorded</span>
          )}
        </Row>
        <Row label="Tools">
          {tools.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {tools.map((tool) => (
                <Badge key={tool} variant="outline" className="font-normal">
                  {tool}
                </Badge>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">none recorded</span>
          )}
        </Row>
        <Row label="Budget">
          {ceiling ? (
            <span className="flex flex-wrap items-baseline gap-1.5">
              <Readout className="text-xs">${ceiling}</Readout>
              <span className="text-muted-foreground text-xs">per-run ceiling</span>
            </span>
          ) : (
            <span className="text-muted-foreground">no ceiling stated</span>
          )}
          <p className="text-muted-foreground mt-1 text-xs">
            Actual spend is not read per run here yet; the ledger is in Spending.
          </p>
        </Row>
        <Row label="Sources">
          {citations.length > 0 ? (
            <ol className="flex flex-col gap-2">
              {citations.map((citation) => (
                <li key={`${citation.documentId}:${citation.span.start}`}>
                  <span className="text-[13px]">{citation.title}</span>
                  {citation.span.page ? (
                    <span className="text-muted-foreground"> · page {citation.span.page}</span>
                  ) : null}
                  <p className="text-muted-foreground line-clamp-2 text-xs">{citation.text}</p>
                </li>
              ))}
            </ol>
          ) : (
            <span className="text-muted-foreground">Nothing was read from the library.</span>
          )}
        </Row>
        <Row label="Run timeline">
          {events.length > 0 ? (
            <ol className="flex flex-col gap-1">
              {events.map((event) => {
                const line = eventLine(event);
                return (
                  <li key={event.sequence} className="flex items-baseline gap-2 text-xs">
                    <Readout className="text-muted-foreground w-8 shrink-0 text-right">
                      {event.sequence}
                    </Readout>
                    <span className="text-muted-foreground shrink-0">{event.type}</span>
                    {line ? <span className="min-w-0 truncate">{line}</span> : null}
                  </li>
                );
              })}
            </ol>
          ) : (
            <span className="text-muted-foreground">No events recorded.</span>
          )}
        </Row>
        <Row label="Outcome">
          <span className="text-muted-foreground">
            {run.summary ?? STATE_LABEL[run.state] ?? run.state}
          </span>
        </Row>
      </dl>

      <div className="mt-3 flex flex-col gap-3">
        {run.error ? (
          <p role="alert" className="text-destructive text-[13px]">{run.error}</p>
        ) : null}
        {unavailable && !finished ? null : (
          <RunControls runId={run.id} finished={finished} />
        )}
        <DraftControls runId={run.id} draft={draft} canSave={canSaveDraft} />
      </div>
    </details>
  );
}
