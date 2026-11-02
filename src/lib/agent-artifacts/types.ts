/*
 * The normalized shape a local agent-artifact session parses into. Pure data:
 * no database, no network, no model. Both source parsers (Claude Code
 * transcripts, Codex rollouts) produce this one shape, and the
 * `imported_agent_sessions` row stores it redacted (see redact.ts — the scrub
 * runs before anything here is persisted, displayed, or exported).
 *
 * Field semantics are per source where the agents disagree:
 * - `usage.inputTokens` counts what the agent called input: for Claude Code
 *   cache reads ride beside input, for Codex the cached tokens are inside it.
 * - `tasks` and `declaredPlan` come from in-transcript evidence (task-tool
 *   inputs, ExitPlanMode), not from the undocumented sidecar file schemas.
 */

export type AgentSource = "claude-code" | "codex";

export type HumanPrompt = {
  text: string;
  /** ISO timestamp when the source record carried one. */
  at?: string;
};

export type FileTouch = {
  path: string;
  op: "edit" | "write" | "other";
};

export type CommandRun = {
  cmd: string;
  ok: boolean;
};

export type SessionFailure = {
  kind: string;
  detail: string;
};

export type SessionTask = {
  text: string;
  state: string;
};

export type SessionSummary = {
  source: AgentSource;
  externalSessionId: string;
  cwd: string;
  startedAt?: string;
  lastActivityAt?: string;
  aiTitle?: string;
  humanPrompts: HumanPrompt[];
  filesTouched: FileTouch[];
  commandsRun: CommandRun[];
  failures: SessionFailure[];
  declaredPlan?: string;
  tasks?: SessionTask[];
  usage?: { inputTokens?: number; outputTokens?: number };
};

/** Defensive-decode accounting: skipped lines are counted, never fatal. */
export type ParseStats = {
  /** JSONL lines that decoded and were folded into the summary. */
  records: number;
  /** Lines that failed to decode or referenced unreadable payloads; parsing continued. */
  skippedRecords: number;
  /** Replay copies collapsed by dedupe (Claude Code uuid, Codex cross-file key). */
  dedupedRecords: number;
};

export type ParsedSession = {
  summary: SessionSummary;
  stats: ParseStats;
};

/**
 * The closed error taxonomy for reading agent-artifact folders, mirroring the
 * skills importer's InspectError kinds. A source root that is missing or
 * unreadable is reported per source, never as a thrown error out of the scan:
 * one agent not being installed must not hide the other one's sessions.
 */
export type ScanErrorKind = "not_found" | "unreadable" | "unsafe_path" | "too_large";
