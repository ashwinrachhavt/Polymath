/*
 * The session brief panel (Workbench D2): one imported agent session rendered
 * as evidence tiers instead of a transcript. Presentational only — the builder
 * (session-brief.ts) owns the sections and their tiers, and every section's
 * badge names the tier its claims stand on: the first human prompt reads as
 * recorded, the parsed activity and the failures section as observed, and the
 * decision as recorded or inferred. The verified tier is never awarded in v1:
 * a transcript is not a test run. Nothing here is model-written; the
 * disclosure line says so on every render.
 */
import { CircleAlert, CircleX } from "lucide-react";

import {
  RATIONALE_INFERRED,
  SESSION_BRIEF_DISCLOSURE,
  UNVERIFIED_CLAIMS_LINE,
  type SessionBriefData,
} from "@/domains/agents/session-brief";
import { timeAgo } from "@/lib/time";

import { EvidenceBadge, type EvidenceTier } from "./evidence-badge";

const SOURCE_LABEL: Record<SessionBriefData["source"], string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/** Paths shown before the list collapses to a count. */
const MAX_PATHS = 12;
/** Command rows shown before the list collapses to a count. */
const MAX_COMMANDS = 8;
/** Failure rows shown before the list collapses to a count. */
const MAX_FAILURES = 8;
/** Open-task rows shown before the list collapses to a count. */
const MAX_TASKS = 8;

export function SessionBriefPanel({ brief }: { brief: SessionBriefData }) {
  const { tierCounts } = brief;
  return (
    <section
      aria-label="Session brief"
      className="border-border/70 bg-muted/20 flex w-full flex-col gap-3 rounded-lg border px-4 py-3"
    >
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">Session brief</h2>
        <p
          className="text-muted-foreground/80 text-[11px]"
          aria-label={`Evidence: ${tierCounts.grounded} grounded, ${tierCounts.inferred} inferred, ${tierCounts.hypothesis} hypotheses`}
        >
          {tierCounts.grounded} grounded · {tierCounts.inferred} inferred · {tierCounts.hypothesis} hypotheses
        </p>
      </header>

      <p className="text-muted-foreground text-[11px]">
        {SOURCE_LABEL[brief.source]} session{" "}
        <code className="bg-muted rounded px-1 py-0.5">{brief.externalSessionId}</code>
        {brief.aiTitle ? ` · ${brief.aiTitle}` : ""} · last activity {timeAgo(brief.lastActivityAt)}
      </p>

      <OutcomeSection brief={brief} />
      <ActivitySection brief={brief} />
      <OpenSection brief={brief} />
      <DecisionSection brief={brief} />

      <footer className="border-border/70 text-muted-foreground/80 border-t pt-2 text-[11px] italic">
        {SESSION_BRIEF_DISCLOSURE}
      </footer>
    </section>
  );
}

function SectionLabel({ label, tier }: { label: string; tier?: EvidenceTier | null }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">{label}</h3>
      {tier ? <EvidenceBadge tier={tier} /> : null}
    </div>
  );
}

function OutcomeSection({ brief }: { brief: SessionBriefData }) {
  const { outcome } = brief;
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel label="Requested outcome" tier={outcome.tier} />
      {outcome.tier === "recorded" ? (
        <p className="text-[13px] leading-6">
          {outcome.text}
          {outcome.at ? (
            <span className="text-muted-foreground text-[11px]"> · asked {timeAgo(outcome.at)}</span>
          ) : null}
        </p>
      ) : (
        <p className="text-muted-foreground text-[12px]">No human prompt was parsed from this session.</p>
      )}
    </div>
  );
}

function ActivitySection({ brief }: { brief: SessionBriefData }) {
  const { activity } = brief;
  if (activity.tier === null) {
    return (
      <div className="flex flex-col gap-1">
        <SectionLabel label="What the agent did" />
        <p className="text-muted-foreground text-[12px]">No file or command activity was parsed from this session.</p>
      </div>
    );
  }
  const { files, commands } = activity;
  const failedCommands = commands.filter((command) => !command.ok).length;
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel label="What the agent did" tier="observed" />
      <p className="text-[12px] leading-5">
        {files.length} file{files.length === 1 ? "" : "s"} touched · {commands.length} command
        {commands.length === 1 ? "" : "s"} run
        {failedCommands > 0 ? ` · ${failedCommands} failed` : ""}
      </p>
      {files.length > 0 ? (
        <ul className="text-muted-foreground mt-0.5 font-mono text-[11px] leading-5">
          {files.slice(0, MAX_PATHS).map((file) => (
            <li key={file.path}>
              <span className="text-foreground/80">{file.op}</span> {file.path}
            </li>
          ))}
          {files.length > MAX_PATHS ? <li>… and {files.length - MAX_PATHS} more</li> : null}
        </ul>
      ) : null}
      {commands.length > 0 ? (
        <ul className="text-muted-foreground mt-0.5 font-mono text-[11px] leading-5">
          {commands.slice(0, MAX_COMMANDS).map((command, index) => (
            <li key={`${command.cmd}-${index}`} className={command.ok ? "" : "text-destructive"}>
              <span className="sr-only">{command.ok ? "passed" : "failed"}: </span>
              <span className="text-foreground/80">$ </span>
              {command.cmd}
            </li>
          ))}
          {commands.length > MAX_COMMANDS ? <li>… and {commands.length - MAX_COMMANDS} more</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

function OpenSection({ brief }: { brief: SessionBriefData }) {
  const { failures, openTasks } = brief.open;
  const empty = failures.length === 0 && openTasks.length === 0;
  return (
    <div className="flex flex-col gap-1">
      {/* Mandatory on every brief, even when empty: observed absence is a claim
          about the record, and it never disappears. */}
      <SectionLabel label="What failed or was left open" tier="observed" />
      {empty ? (
        <p className="text-muted-foreground text-[12px]">
          No failures and no open tasks were parsed from this session.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {failures.slice(0, MAX_FAILURES).map((failure, index) => (
            <li
              key={`${failure.kind}-${index}`}
              className="text-destructive flex items-start gap-1.5 text-[12px] leading-5"
            >
              <CircleX aria-hidden className="size-3.5 shrink-0" />
              <span>
                {failure.kind}: {failure.detail}
              </span>
            </li>
          ))}
          {failures.length > MAX_FAILURES ? (
            <li className="text-muted-foreground text-[11px]">… and {failures.length - MAX_FAILURES} more failures</li>
          ) : null}
          {openTasks.slice(0, MAX_TASKS).map((task, index) => (
            <li key={`${task.text}-${index}`} className="flex items-start gap-1.5 text-[12px] leading-5">
              <CircleAlert aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
              <span>
                {task.text} <span className="text-muted-foreground text-[11px]">({task.state})</span>
              </span>
            </li>
          ))}
          {openTasks.length > MAX_TASKS ? (
            <li className="text-muted-foreground text-[11px]">… and {openTasks.length - MAX_TASKS} more open tasks</li>
          ) : null}
        </ul>
      )}
      <p className="text-muted-foreground text-[11px] italic">{UNVERIFIED_CLAIMS_LINE}</p>
    </div>
  );
}

function DecisionSection({ brief }: { brief: SessionBriefData }) {
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel label="Why this approach" tier={brief.decision.tier} />
      <p className="text-[13px] leading-6">
        {brief.decision.line}
        {brief.decision.line === RATIONALE_INFERRED ? (
          <span className="text-muted-foreground text-[11px]">
            {" "}
            · record a note on the session to replace this line
          </span>
        ) : null}
      </p>
    </div>
  );
}
