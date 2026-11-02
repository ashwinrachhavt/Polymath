/*
 * A ledger over the model messages Eve hands a tool, so a tool can see what it
 * already did this turn. The guard lives here rather than in a module-level
 * cache: the messages are the same history the model sees, so a duplicate is a
 * duplicate even when the dev worker restarts, and a new turn starts clean.
 *
 * Pure on purpose: no eve or database import, so the acceptance suite can
 * assert the guards without a running session.
 */
export type MessageLike = {
  role: string;
  content: unknown;
};

export type TurnToolCall = {
  /** The call's input, when it is an object; otherwise an empty object. */
  input: Record<string, unknown>;
  /** The matching result's payload, or undefined while the call is pending. */
  output: unknown;
  /** True when the result carries a tool-level failure (`ok: false`). */
  failed: boolean;
};

type Part = {
  type?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  input?: unknown;
  output?: unknown;
};

function partsOf(message: MessageLike): Part[] {
  if (typeof message.content === "string") return [];
  if (!Array.isArray(message.content)) return [];
  return message.content.filter((part): part is Part => typeof part === "object" && part !== null);
}

/**
 * Unwraps the AI SDK's tagged tool-result output. `json` and `text` carry the
 * tool's return value in `value`; an already-unwrapped payload is returned as
 * is so the helper also works against persisted traces.
 */
function outputValue(output: unknown): unknown {
  if (!output || typeof output !== "object") return output;
  const record = output as Record<string, unknown>;
  const value =
    record.type === "json" || record.type === "text" || record.type === "error-json" || record.type === "error-text"
      ? record.value
      : output;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        return JSON.parse(text);
      } catch {
        return value;
      }
    }
  }
  return value;
}

function isFailure(value: unknown): boolean {
  if (typeof value === "string") {
    const text = value.trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        return isFailure(JSON.parse(text));
      } catch {
        return false;
      }
    }
    return false;
  }
  return Boolean(value && typeof value === "object" && (value as { ok?: unknown }).ok === false);
}

/**
 * The calls to one tool made in the current turn, oldest first. A turn starts
 * after the most recent user message; Eve's request-context messages can sit
 * earlier in the history, so the boundary is the last user role rather than
 * the start of `messages`.
 */
export function toolCallsThisTurn(messages: readonly MessageLike[], toolName: string): TurnToolCall[] {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      start = i + 1;
      break;
    }
  }

  const calls = new Map<string, Record<string, unknown>>();
  const results = new Map<string, { output: unknown; failed: boolean }>();
  for (const message of messages.slice(start)) {
    for (const part of partsOf(message)) {
      if (part.type === "tool-call" && part.toolName === toolName) {
        const id = typeof part.toolCallId === "string" ? part.toolCallId : "";
        const input = part.input;
        calls.set(id, input && typeof input === "object" ? (input as Record<string, unknown>) : {});
      } else if (part.type === "tool-result" && part.toolName === toolName) {
        const id = typeof part.toolCallId === "string" ? part.toolCallId : "";
        const value = outputValue(part.output);
        results.set(id, { output: value, failed: isFailure(value) });
      }
    }
  }

  return [...calls.entries()].map(([id, input]) => {
    const result = results.get(id);
    return { input, output: result?.output, failed: result?.failed ?? false };
  });
}

/**
 * The identity of a fetched page, for duplicate detection. Tracking parameters
 * and fragments do not change the content; YouTube's video id is the page, so
 * its player parameters collapse to one form.
 */
export function normalizeFetchUrl(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.hostname === "youtube.com" && url.pathname === "/watch") {
      const id = url.searchParams.get("v");
      if (id) return `youtube.com/watch?v=${id}`;
    }
    return url.toString();
  } catch {
    return trimmed;
  }
}

/** The identity of a search, for duplicate detection. */
export function normalizeSearchQuery(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase().replace(/\s+/g, " ") : "";
}
