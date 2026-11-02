/*
 * Codex rollout parser (~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl).
 * The format is published as open-source code, not a specification, so every
 * field is narrowed through decode.ts and unparseable lines are counted and
 * skipped, never fatal (art_GNwwKckZ §5).
 *
 * Reader-critical rules implemented here:
 * - A resumed session spans several rollout files that replay earlier items
 *   under their original ids: callers group files by session BEFORE calling,
 *   and this parser dedupes across files (exact repeats inside one rollout
 *   are genuine repeats and are kept).
 * - Sessions are identified by `session_meta.cwd` / thread id — there is no
 *   per-project directory.
 * - Tool calls pair to outputs by `call_id`, never by arrival order.
 * - Injected context blocks (`<user_instructions>`, `<environment_context>`,
 *   siblings) and the `## My request for Codex:` prefix are stripped before
 *   text is treated as a human prompt.
 * - Usage comes from `token_usage_record` lines deduped by `response_id`;
 *   `cached_input_tokens` sits INSIDE `input_tokens`, so it is never added.
 *   Older rollouts with only `token_count` events fall back to the event's
 *   running total. Encrypted inter-agent payloads are skipped, not decoded.
 * - Fixtures live in tests/fixtures/agent-artifacts/codex/.
 */
import { asArray, asNumber, asRecord, asString } from "./decode";
import { redactExcerpt } from "./redact";
import type {
  CommandRun,
  FileTouch,
  HumanPrompt,
  ParseStats,
  ParsedSession,
  SessionFailure,
  SessionSummary,
} from "./types";

/** Official injection-tag list (codex-rs protocol constants) — stripped before prompt extraction. */
const INJECTION_TAGS = [
  "user_instructions",
  "environment_context",
  "environments_instructions",
  "apps_instructions",
  "skills_instructions",
  "collaboration_mode",
  "multi_agent_mode",
  "context_window",
  "context_window_guidance",
] as const;

const REQUEST_PREFIX = "## My request for Codex:";

/** Remove machine-injected blocks and the wrapper prefix; returns "" when nothing human remains. */
export function stripInjectedBlocks(text: string): string {
  let result = text;
  for (const tag of INJECTION_TAGS) {
    result = result.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), "");
    // An unclosed tag means the rest of the message is injected content.
    result = result.replace(new RegExp(`<${tag}>[\\s\\S]*$`, "g"), "");
  }
  return result.replace(new RegExp(`^\\s*${REQUEST_PREFIX}\\s*`, "i"), "").trim();
}

export type CodexRolloutFile = { fileName: string; text: string };

export type CodexSessionMeta = {
  threadId?: string;
  parentThreadId?: string;
  cwd?: string;
  startedAt?: string;
};

type Envelope = { timestamp?: string; type?: string; payload: Record<string, unknown> };

function decodeEnvelope(line: string): Envelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  if (!record) return undefined;
  const payload = asRecord(record.payload);
  if (!payload) return undefined;
  return { timestamp: asString(record.timestamp), type: asString(record.type), payload };
}

function stableKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`).join(",")}}`;
}

function lineKey(envelope: Envelope): string {
  const id = asString(envelope.payload.id);
  return `${envelope.type ?? ""}:${id ?? stableKey(envelope.payload)}`;
}

/** Read the head-of-file session_meta — how the scanner groups and filters rollouts. */
export function readCodexSessionMeta(text: string): CodexSessionMeta {
  const lines = text.split("\n");
  const head = lines.slice(0, 10);
  for (const line of head) {
    const envelope = decodeEnvelope(line);
    if (!envelope || envelope.type !== "session_meta") continue;
    return {
      threadId: asString(envelope.payload.id) ?? asString(envelope.payload.session_id),
      parentThreadId: asString(envelope.payload.parent_thread_id),
      cwd: asString(envelope.payload.cwd),
      startedAt: asString(envelope.payload.timestamp) ?? envelope.timestamp,
    };
  }
  return {};
}

/** Thread id from the filename, used when a rollout has no parseable meta line. */
export function threadIdFromFileName(fileName: string): string | undefined {
  const match = fileName.match(
    /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]+)?\.jsonl$/i,
  );
  return match?.[1];
}

type PendingCall = { name: string; cmd?: string; files: FileTouch[] };

function commandText(args: unknown): string | undefined {
  if (typeof args === "string") {
    // Real rollouts encode `arguments` as a JSON string; fixtures may carry
    // the object directly. Parse once so both shapes read the same.
    const parsed = safeJsonParse(args);
    if (parsed !== undefined) return commandText(parsed);
    return args;
  }
  const record = asRecord(args);
  if (!record) return undefined;
  const command = record.command;
  if (typeof command === "string") return command;
  const parts = asArray(command)
    .map((part) => asString(part))
    .filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** `*** Add File: src/x.ts` lines are the file-touch signal inside an apply_patch payload. */
function filesFromPatch(patch: string): FileTouch[] {
  const touches: FileTouch[] = [];
  for (const match of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
    const op = match[1] === "Add" ? "write" : match[1] === "Update" ? "edit" : "other";
    touches.push({ path: match[2].trim(), op });
  }
  return touches;
}

/** Register a call so its output can be paired by call_id. */
function registerCall(pending: Map<string, PendingCall>, callId: string, name: string, args: unknown): void {
  const patchSource = commandText(args) ?? "";
  const isPatch = name === "apply_patch" || patchSource.includes("*** Begin Patch");
  if (isPatch) {
    const files = filesFromPatch(patchSource);
    pending.set(callId, { name, cmd: `apply_patch ${files.map((f) => f.path).join(", ")}`.trim(), files });
    return;
  }
  pending.set(callId, { name, cmd: patchSource === "" ? undefined : redactExcerpt(patchSource, 500), files: [] });
}

/** Exit code lives in the output JSON's metadata; absence of evidence is success. */
function resolveOutput(raw: unknown): { ok: boolean; detail?: string } {
  const text = typeof raw === "string" ? raw : (JSON.stringify(raw) ?? "");
  const parsed = asRecord(safeJsonParse(text));
  if (parsed) {
    const metadata = asRecord(parsed.metadata);
    const exitCode = (metadata ? asNumber(metadata.exit_code) : undefined) ?? asNumber(parsed.exit_code);
    const outputText = asString(parsed.output) ?? text;
    if (exitCode !== undefined && exitCode !== 0) {
      return { ok: false, detail: redactExcerpt(outputText, 500) };
    }
    if (asString(parsed.error) !== undefined) {
      return { ok: false, detail: redactExcerpt(outputText, 500) };
    }
    return { ok: true };
  }
  // Non-JSON output: no exit signal, treat as success (matches unpaired calls).
  return { ok: true };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function parseCodexSession(files: CodexRolloutFile[]): ParsedSession {
  const stats: ParseStats = { records: 0, skippedRecords: 0, dedupedRecords: 0 };

  // Date-partitioned filenames sort chronologically; resume files sort after their originals.
  const ordered = [...files].sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));

  const head = ordered[0];
  const meta = head ? readCodexSessionMeta(head.text) : {};
  let externalSessionId = meta.threadId ?? "";
  let cwd = meta.cwd;
  let startedAt = meta.startedAt;
  let lastActivityAt: string | undefined;
  let fallbackTotal: { inputTokens: number; outputTokens: number } | undefined;

  const humanPrompts: HumanPrompt[] = [];
  const filesTouched: FileTouch[] = [];
  const commandsRun: CommandRun[] = [];
  const failures: SessionFailure[] = [];
  const pending = new Map<string, PendingCall>();
  const seenResponseIds = new Set<string>();
  const seenAcrossFiles = new Set<string>();
  let usageTotals = { input: 0, output: 0 };

  const finishCall = (callId: string, raw: unknown): void => {
    const wait = pending.get(callId);
    pending.delete(callId);
    if (!wait) return;
    const verdict = resolveOutput(raw);
    if (wait.cmd !== undefined) commandsRun.push({ cmd: wait.cmd, ok: verdict.ok });
    filesTouched.push(...wait.files);
    if (!verdict.ok && verdict.detail !== undefined) {
      failures.push({ kind: "command", detail: verdict.detail });
    }
  };

  for (const file of ordered) {
    // Keys observed in previous files only: exact repeats inside one rollout
    // are genuine repeats, while resume replays cross file boundaries.
    const fileKeys = new Set<string>();
    for (const line of file.text.split("\n")) {
      if (line.trim() === "") continue;
      const envelope = decodeEnvelope(line);
      if (!envelope) {
        stats.skippedRecords += 1;
        continue;
      }
      stats.records += 1;
      if (envelope.timestamp !== undefined) lastActivityAt = envelope.timestamp;

      const key = lineKey(envelope);
      if (seenAcrossFiles.has(key)) {
        stats.dedupedRecords += 1;
        continue;
      }
      fileKeys.add(key);

      const payload = envelope.payload;
      const payloadType = asString(payload.type);

      if (envelope.type === "session_meta") {
        if (externalSessionId === "") externalSessionId = asString(payload.id) ?? asString(payload.session_id) ?? "";
        if (cwd === undefined) cwd = asString(payload.cwd);
        if (startedAt === undefined) startedAt = asString(payload.timestamp) ?? envelope.timestamp;
        continue;
      }

      if (envelope.type === "token_usage_record") {
        const responseId = asString(payload.response_id);
        if (responseId !== undefined && !seenResponseIds.has(responseId)) {
          seenResponseIds.add(responseId);
          const usage = asRecord(payload.usage);
          if (usage) {
            const input = asNumber(usage.input_tokens) ?? 0;
            const output = asNumber(usage.output_tokens) ?? 0;
            // cached_input_tokens is inside input_tokens — never added separately.
            fallbackTotal = undefined;
            usageTotals = { input: usageTotals.input + input, output: usageTotals.output + output };
          }
        }
        continue;
      }

      if (envelope.type === "event_msg" && payloadType === "token_count") {
        const total = asRecord(payload.total_token_usage);
        if (total) {
          fallbackTotal = {
            inputTokens: asNumber(total.input_tokens) ?? 0,
            outputTokens: asNumber(total.output_tokens) ?? 0,
          };
        }
        continue;
      }

      if (envelope.type === "turn_context") {
        if (cwd === undefined) cwd = asString(payload.cwd);
        continue;
      }

      if (envelope.type !== "response_item") continue;

      if (payloadType === "message") {
        const role = asString(payload.role);
        if (role !== "user") continue;
        const parts: string[] = [];
        for (const item of asArray(payload.content)) {
          const itemRecord = asRecord(item);
          if (!itemRecord || asString(itemRecord.type) !== "input_text") continue;
          const text = asString(itemRecord.text);
          if (text === undefined) continue;
          const stripped = stripInjectedBlocks(text);
          if (stripped !== "") parts.push(stripped);
        }
        const promptText = parts.join("\n").trim();
        if (promptText !== "") {
          humanPrompts.push({ text: redactExcerpt(promptText), at: envelope.timestamp });
        }
        continue;
      }

      if (payloadType === "function_call" || payloadType === "custom_tool_call") {
        const callId = asString(payload.call_id);
        const name = asString(payload.name) ?? "";
        if (callId === undefined) continue;
        const args = payload.arguments ?? payload.input;
        registerCall(pending, callId, name, args);
        continue;
      }

      if (payloadType === "agent_message") {
        // Encrypted inter-agent payloads are skipped, not decoded.
        continue;
      }

      // Every output variant (function_call_output, custom_tool_call_output,
      // McpToolCallOutput, ToolSearchOutput) carries call_id + output.
      const callId = asString(payload.call_id);
      if (callId !== undefined && payload.output !== undefined) {
        finishCall(callId, payload.output);
      }
    }

    for (const key of fileKeys) seenAcrossFiles.add(key);
  }

  // Calls whose output never arrived (crash, spill) still happened.
  for (const wait of pending.values()) {
    if (wait.cmd !== undefined) commandsRun.push({ cmd: wait.cmd, ok: true });
    filesTouched.push(...wait.files);
  }

  const usage =
    seenResponseIds.size > 0 ? { inputTokens: usageTotals.input, outputTokens: usageTotals.output } : fallbackTotal;

  const summary: SessionSummary = {
    source: "codex",
    externalSessionId: externalSessionId || "unknown",
    cwd: cwd ?? "",
    humanPrompts,
    filesTouched,
    commandsRun,
    failures,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
  return { summary, stats };
}
