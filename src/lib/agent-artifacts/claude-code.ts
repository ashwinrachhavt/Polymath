/*
 * Claude Code transcript parser (~/.claude/projects/<slug>/<sessionId>.jsonl).
 * The line format is officially internal and version-changing, so every field
 * is narrowed through decode.ts and a record that does not match is counted
 * and skipped, never fatal (art_GNwwKckZ §5).
 *
 * Reader-critical rules implemented here:
 * - The slug directory name is never decoded; the project path is the `cwd`
 *   field on records.
 * - Resume and rewind replay records: dedupe by `uuid`, merging later copies
 *   over earlier ones (later copies fill fields the first left empty), while
 *   keeping the FIRST `promptId` — later copies carry the resuming prompt's
 *   id, which would collapse many prompts into few.
 * - `user` records are human prompts only after excluding `tool_result`
 *   content, `isMeta` records, and sidechain (subagent) copies.
 * - Token counts accumulate once per `message.id`, not per record: one reply
 *   can be written under several uuids with the usage repeated.
 * - Fixtures for this parser live in tests/fixtures/agent-artifacts/claude-code/.
 */
import { asArray, asBoolean, asNumber, asRecord, asString, firstString, isRecord } from "./decode";
import { redactExcerpt } from "./redact";
import type {
  CommandRun,
  FileTouch,
  HumanPrompt,
  ParseStats,
  ParsedSession,
  SessionFailure,
  SessionSummary,
  SessionTask,
} from "./types";

/*
 * Task state is read from in-transcript task-tool inputs, not from the
 * undocumented `~/.claude/tasks/` file schema (art_GNwwKckZ §6 marks it [U]).
 */
const TASK_TOOL_NAMES = new Set(["TodoWrite"]);
const EDIT_TOOL_NAMES = new Set(["Edit", "MultiEdit", "NotebookEdit"]);
const WRITE_TOOL_NAMES = new Set(["Write"]);
const PLAN_TOOL_NAMES = new Set(["ExitPlanMode", "exit_plan_mode"]);

type ClaudeBlock = Record<string, unknown>;

type ClaudeRecord = {
  uuid: string;
  sessionId?: string;
  promptId?: string;
  cwd?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: Record<string, unknown>;
  toolUseResult?: unknown;
  aiTitle?: string;
};

/** Merge a replayed copy into the first-seen record: later copies fill gaps, never overwrite. */
function mergeRecord(first: ClaudeRecord, replay: ClaudeRecord): ClaudeRecord {
  return {
    uuid: first.uuid,
    sessionId: first.sessionId ?? replay.sessionId,
    promptId: first.promptId ?? replay.promptId,
    cwd: first.cwd ?? replay.cwd,
    timestamp: first.timestamp ?? replay.timestamp,
    isMeta: first.isMeta || replay.isMeta || undefined,
    isSidechain: first.isSidechain || replay.isSidechain || undefined,
    // Richer content wins: a replayed assistant copy usually carries the same
    // payload; a partial first copy is the gap-filling case the corpus shows.
    message: richerMessage(first.message, replay.message),
    toolUseResult: first.toolUseResult ?? replay.toolUseResult,
    aiTitle: first.aiTitle ?? replay.aiTitle,
  };
}

function richerMessage(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!a) return b;
  if (!b) return a;
  const aBlocks = asArray(a.content).length;
  const bBlocks = asArray(b.content).length;
  return bBlocks > aBlocks ? b : a;
}

function decodeRecord(line: string): ClaudeRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  if (!record) return undefined;
  const uuid = asString(record.uuid) ?? "";
  if (uuid === "") return undefined;
  return {
    uuid,
    sessionId: asString(record.sessionId),
    promptId: asString(record.promptId),
    cwd: asString(record.cwd),
    timestamp: asString(record.timestamp),
    isMeta: asBoolean(record.isMeta) || undefined,
    isSidechain: asBoolean(record.isSidechain) || undefined,
    message: asRecord(record.message),
    toolUseResult: record.toolUseResult,
    // ai-title records have carried both field names across versions.
    aiTitle: asString(record.title) ?? asString(record.aiTitle),
  };
}

/** `message.content` is a bare string or a list of content blocks; both shapes occur. */
function contentOf(message: Record<string, unknown> | undefined): string | ClaudeBlock[] {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  return asArray(content).filter(isRecord);
}

function blockListOf(content: string | ClaudeBlock[]): ClaudeBlock[] {
  return typeof content === "string" ? [] : content;
}

function textOfBlocks(blocks: unknown): string {
  if (typeof blocks === "string") return blocks;
  const parts: string[] = [];
  for (const block of asArray(blocks)) {
    const record = asRecord(block);
    const text = record ? asString(record.text) : undefined;
    if (text !== undefined) parts.push(text);
  }
  return parts.join("\n");
}

function blockText(result: unknown): string {
  if (typeof result === "string") return result;
  return textOfBlocks(result);
}

/** `toolUseResult` arrives as an object or a bare string; the object can carry the error flag. */
function recordError(record: ClaudeRecord): boolean {
  const result = asRecord(record.toolUseResult);
  return result ? asBoolean(result.isError) === true : false;
}

type Pending = { kind: "bash"; cmd: string } | { kind: "file"; touch: FileTouch } | { kind: "other" };

export function parseClaudeCodeTranscript(text: string, fallbackSessionId = ""): ParsedSession {
  const stats: ParseStats = { records: 0, skippedRecords: 0, dedupedRecords: 0 };

  // Dedupe pass: one record per uuid, in first-appearance order, replays merged in place.
  const merged: ClaudeRecord[] = [];
  const indexByUuid = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const record = decodeRecord(line);
    if (!record) {
      stats.skippedRecords += 1;
      continue;
    }
    stats.records += 1;
    const existingIndex = indexByUuid.get(record.uuid);
    if (existingIndex !== undefined) {
      stats.dedupedRecords += 1;
      merged[existingIndex] = mergeRecord(merged[existingIndex] ?? record, record);
      continue;
    }
    indexByUuid.set(record.uuid, merged.length);
    merged.push(record);
  }

  let cwd: string | undefined;
  let startedAt: string | undefined;
  let lastActivityAt: string | undefined;
  let aiTitle: string | undefined;
  let declaredPlan: string | undefined;
  const humanPrompts: HumanPrompt[] = [];
  const filesTouched: FileTouch[] = [];
  const commandsRun: CommandRun[] = [];
  const failures: SessionFailure[] = [];
  const tasks: SessionTask[] = [];
  const pending = new Map<string, Pending>();
  const usageById = new Map<string, { input: number; output: number }>();
  let externalSessionId = fallbackSessionId;

  for (const record of merged) {
    cwd = cwd ?? record.cwd;
    if (startedAt === undefined && record.timestamp !== undefined) startedAt = record.timestamp;
    if (record.timestamp !== undefined) lastActivityAt = record.timestamp;
    if (externalSessionId === "" && record.sessionId !== undefined) externalSessionId = record.sessionId;
    if (aiTitle === undefined && record.aiTitle !== undefined) aiTitle = record.aiTitle;

    const message = record.message;
    const role = message ? asString(message.role) : undefined;

    // Assistant records carry tool_use blocks and per-message usage.
    if (role === "assistant") {
      const messageId = asString(message?.id);
      if (messageId && !usageById.has(messageId)) {
        const usageBlock = asRecord(message?.usage);
        usageById.set(messageId, {
          input: (usageBlock ? asNumber(usageBlock.input_tokens) : undefined) ?? 0,
          output: (usageBlock ? asNumber(usageBlock.output_tokens) : undefined) ?? 0,
        });
      }
      for (const block of blockListOf(contentOf(message))) {
        if (asString(block.type) !== "tool_use") continue;
        const name = asString(block.name) ?? "";
        const input = asRecord(block.input) ?? {};
        const id = asString(block.id);
        if (id === undefined) continue;
        if (name === "Bash") {
          pending.set(id, { kind: "bash", cmd: redactExcerpt(asString(input.command) ?? "", 500) });
        } else if (EDIT_TOOL_NAMES.has(name) || WRITE_TOOL_NAMES.has(name) || name === "Read") {
          const filePath = firstString(input, "file_path", "notebook_path") ?? "";
          const op = name === "Read" ? "other" : WRITE_TOOL_NAMES.has(name) ? "write" : "edit";
          pending.set(id, { kind: "file", touch: { path: filePath, op } });
        } else if (PLAN_TOOL_NAMES.has(name)) {
          if (declaredPlan === undefined) {
            const plan = asString(input.plan);
            if (plan !== undefined) declaredPlan = redactExcerpt(plan);
          }
          pending.set(id, { kind: "other" });
        } else if (TASK_TOOL_NAMES.has(name)) {
          const next: SessionTask[] = [];
          for (const todo of asArray(input.todos)) {
            const todoRecord = asRecord(todo);
            if (!todoRecord) continue;
            const taskText = firstString(todoRecord, "content", "activeForm", "text");
            const state = firstString(todoRecord, "status", "state") ?? "pending";
            if (taskText !== undefined) next.push({ text: redactExcerpt(taskText, 500), state });
          }
          if (next.length > 0) {
            // TodoWrite writes the whole list each call, so the last call is the current state.
            tasks.length = 0;
            tasks.push(...next);
          }
          pending.set(id, { kind: "other" });
        } else {
          pending.set(id, { kind: "other" });
        }
      }
      continue;
    }

    // User records: tool results and human prompts.
    const content = contentOf(message);
    const blocks = asArray(content).filter(isRecord);
    const toolResults = blocks.filter((block) => asString(block.type) === "tool_result");
    for (const resultBlock of toolResults) {
      const callId = asString(resultBlock.tool_use_id);
      if (callId === undefined) continue;
      const wait = pending.get(callId);
      pending.delete(callId);
      const resultText = blockText(resultBlock.content ?? record.toolUseResult);
      const isError = asBoolean(resultBlock.is_error) === true || recordError(record);
      if (wait?.kind === "bash") {
        commandsRun.push({ cmd: wait.cmd, ok: !isError });
        if (isError) failures.push({ kind: "tool_result", detail: redactExcerpt(resultText, 500) });
      } else if (wait?.kind === "file") {
        filesTouched.push(wait.touch);
        if (isError) failures.push({ kind: "tool_result", detail: redactExcerpt(resultText, 500) });
      }
    }
    if (toolResults.length > 0) continue;

    const isHuman =
      !record.isMeta &&
      !record.isSidechain &&
      role === "user" &&
      blocks.every((block) => asString(block.type) !== "tool_result");
    if (isHuman) {
      const promptText = textOfBlocks(content).trim();
      if (promptText !== "") {
        humanPrompts.push({ text: redactExcerpt(promptText), at: record.timestamp });
      }
    }
  }

  // A call whose result never arrived (spilled to tool-results/ files) has no
  // evidence of failure; the command still happened, so it is recorded ok.
  for (const wait of pending.values()) {
    if (wait.kind === "bash") commandsRun.push({ cmd: wait.cmd, ok: true });
    else if (wait.kind === "file") filesTouched.push(wait.touch);
  }

  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  if (usageById.size > 0) {
    inputTokens = 0;
    outputTokens = 0;
    for (const perMessage of usageById.values()) {
      inputTokens += perMessage.input;
      outputTokens += perMessage.output;
    }
  }

  const summary: SessionSummary = {
    source: "claude-code",
    externalSessionId: externalSessionId || "unknown",
    cwd: cwd ?? "",
    humanPrompts,
    filesTouched,
    commandsRun,
    failures,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
    ...(aiTitle !== undefined ? { aiTitle } : {}),
    ...(declaredPlan !== undefined ? { declaredPlan } : {}),
    ...(tasks.length > 0 ? { tasks } : {}),
    ...(usageById.size > 0 ? { usage: { inputTokens, outputTokens } } : {}),
  };
  return { summary, stats };
}
