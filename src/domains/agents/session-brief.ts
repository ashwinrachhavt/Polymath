/*
 * The session brief's data shape (Workbench D2): a deterministic, evidence-tiered
 * read of one imported agent session. No model anywhere in this module — every
 * claim derives from the parsed session summary (the first human prompt, files
 * touched, commands run, failures, open tasks) or from the operator's decision
 * note, and each section carries the tier that matches its evidence. The panel
 * component renders this shape; the tier vocabulary lives here so the builder's
 * tier decisions are unit-testable without React.
 *
 * This module is the render boundary for extracted transcript content. The
 * stored summary was already redacted at parse time (redact.ts), but a brief
 * must not trust that — an older row or a parser gap would otherwise leak into
 * the page — so every string extracted from a transcript passes through
 * redactString again here. The decision note is the one deliberate exception:
 * the operator typed it, the scan stored it as typed, and silently mangling a
 * person's own recorded words is its own dishonesty.
 *
 * Two standing honesty rules are pinned in this file:
 * - The verified tier is never awarded in v1: a transcript alone does not
 *   confirm a test result, and mislabeling is the failure the tier system
 *   exists to prevent.
 * - "What failed or was left open" renders on every brief, even when empty:
 *   observed absence is still a claim about the record, and it never
 *   disappears.
 */

import { redactString } from "@/lib/agent-artifacts/redact";
import type {
  AgentSource,
  CommandRun,
  FileTouch,
  SessionFailure,
  SessionSummary,
  SessionTask,
} from "@/lib/agent-artifacts/types";

/** The evidence tiers a brief section can claim. The badge renders the marks. */
export type EvidenceTier = "observed" | "source-backed" | "verified" | "recorded" | "inferred" | "hypothesis";

/** The standing disclosure every session brief carries: parsing was local and model-free. */
export const SESSION_BRIEF_DISCLOSURE =
  "Parsed locally from your Claude Code / Codex files. Nothing was sent to a model.";

/** The literal fallback when no decision note was recorded with the session. */
export const RATIONALE_INFERRED = "rationale inferred after implementation";

/** The standing honesty line in the failures section: a transcript is not a test run. */
export const UNVERIFIED_CLAIMS_LINE = "Agent claims are unverified: a transcript shows what ran, not what worked.";

/**
 * A task left open: the agent's own last task write did not mark it completed.
 * States come from the agent's task tool verbatim (claude-code.ts), so the
 * comparison is normalized, not enumerated — an unknown state is open, because
 * "done" is the one thing an agent spells the same way.
 */
export function isOpenTask(task: SessionTask): boolean {
  return task.state.trim().toLowerCase() !== "completed";
}

/**
 * Unique touched paths in first-appearance order; the op shown is the first
 * one seen. Agents edit the same file many times per session and the reader
 * wants the file list, not the edit count.
 */
export function uniqueFiles(files: readonly FileTouch[]): FileTouch[] {
  const seen = new Map<string, FileTouch>();
  for (const touch of files) if (!seen.has(touch.path)) seen.set(touch.path, touch);
  return [...seen.values()];
}

export type SessionBriefData = {
  source: AgentSource;
  externalSessionId: string;
  aiTitle: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  /**
   * Requested outcome: the session's first human prompt. A null tier means no
   * human prompt was parsed — the panel reports the absence and awards
   * nothing, because absence is never dressed as a tier.
   */
  outcome: { tier: "recorded"; text: string; at: string | null } | { tier: null; text: null; at: null };
  /** What the agent did: files touched (unique paths) and commands run. */
  activity:
    { tier: "observed"; files: FileTouch[]; commands: CommandRun[] } | { tier: null; files: null; commands: null };
  /** What failed or was left open: mandatory on every brief, observed even when empty. */
  open: { tier: "observed"; failures: SessionFailure[]; openTasks: SessionTask[] };
  /** Why this approach: the recorded note, else the inferred fallback literal. */
  decision: { tier: "recorded" | "inferred"; line: string };
  /** Header counts over the sections that render a claim, in the PR2 panel vocabulary. */
  tierCounts: { grounded: number; inferred: number; hypothesis: number };
  disclosure: string;
};

export type SessionBriefInput = {
  summary: SessionSummary;
  /** What the operator said the session was for, when they said it at all. */
  decisionNote: string | null | undefined;
};

/**
 * Build the brief for one imported session. Pure and deterministic: the same
 * summary and note always produce the same brief, which is what makes the
 * disclosure testable and the render safe to re-run.
 *
 * The decision tier reads the note itself, not the row's decisionStatus
 * column: a note IS a recorded decision (the person typed it at scan time),
 * and a recorded badge over the inferred fallback line — the one state the
 * status column could produce on a drifted row — is precisely the mismatch
 * this resolution makes unrepresentable.
 */
export function buildSessionBrief(input: SessionBriefInput): SessionBriefData {
  const { summary } = input;

  const firstPrompt = summary.humanPrompts[0];
  const outcome = firstPrompt
    ? { tier: "recorded" as const, text: redactString(firstPrompt.text), at: firstPrompt.at ?? null }
    : { tier: null, text: null, at: null };

  const files = uniqueFiles(summary.filesTouched).map((file) => ({ ...file, path: redactString(file.path) }));
  const commands = summary.commandsRun.map((command) => ({ ...command, cmd: redactString(command.cmd) }));
  const activity =
    files.length > 0 || commands.length > 0
      ? { tier: "observed" as const, files, commands }
      : { tier: null, files: null, commands: null };

  const open = {
    tier: "observed" as const,
    failures: summary.failures.map((failure) => ({
      kind: redactString(failure.kind),
      detail: redactString(failure.detail),
    })),
    openTasks: (summary.tasks ?? []).filter(isOpenTask).map((task) => ({ ...task, text: redactString(task.text) })),
  };

  const note = input.decisionNote?.trim();
  const decision = note
    ? { tier: "recorded" as const, line: note }
    : { tier: "inferred" as const, line: RATIONALE_INFERRED };

  // Grounded = the sections whose claim the parsed record backs, counted
  // exactly as the panel renders them: the outcome only when a prompt was
  // parsed, the activity only when there is any, the open section always
  // (it renders on every brief), and the decision when a human recorded it.
  const grounded =
    (outcome.tier !== null ? 1 : 0) + (activity.tier !== null ? 1 : 0) + 1 + (decision.tier === "recorded" ? 1 : 0);

  return {
    source: summary.source,
    externalSessionId: summary.externalSessionId,
    aiTitle: summary.aiTitle ? redactString(summary.aiTitle) : null,
    startedAt: summary.startedAt ?? null,
    lastActivityAt: summary.lastActivityAt ?? null,
    outcome,
    activity,
    open,
    decision,
    tierCounts: { grounded, inferred: decision.tier === "inferred" ? 1 : 0, hypothesis: 0 },
    disclosure: SESSION_BRIEF_DISCLOSURE,
  };
}
