/*
 * The lane, enforced where the model is called.
 *
 * eve hands every model call the agent's full tool list and history. This
 * wrapper turns a routed lane (src/domains/agents/lane-policy.ts) into what the
 * model actually receives, so one seam owns every per-turn limit:
 *
 * - tools: only the lane's subset, in eve's order (stable for the prompt cache);
 * - caps: at the lane's step cap or input-token budget the model keeps its
 *   tool definitions (the cached prefix does not change) but may not call
 *   them, and is told to answer with what it has;
 * - tool results: trimmed to a budget, harder for earlier turns, so pages read
 *   three turns ago stop costing tokens on every later step;
 * - the lane's skill rides at the end of the person's latest message, after the
 *   cached prefix (system, tools, history), never in the system prompt.
 *
 * Pure: no eve or database import, so specs can drive it with plain prompts.
 */
import { DELEGATE_TOOL, policyFor, visibleTools } from "../../../../src/domains/agents/lane-policy";
import type { TurnRoute } from "../../../../src/domains/agents/turn-routing";

type Part = { type: string; text?: string; toolName?: string; output?: unknown; [key: string]: unknown };
type Message = { role: string; content: string | Part[]; [key: string]: unknown };
type Tool = { type: string; name: string; [key: string]: unknown };

export type CallOptions = {
  prompt: Message[];
  tools?: Tool[];
  toolChoice?: unknown;
  [key: string]: unknown;
};

/** A tool result from this turn keeps this many characters (about 2.5k tokens). */
export const CURRENT_TURN_RESULT_CHARS = 10_000;
/** A tool result from an earlier turn keeps this many: enough to recall what it was. */
export const EARLIER_TURN_RESULT_CHARS = 1_200;

const CHARS_PER_TOKEN = 4;

function lastUserIndex(prompt: readonly Message[]): number {
  for (let i = prompt.length - 1; i >= 0; i -= 1) if (prompt[i]?.role === "user") return i;
  return -1;
}

function sizeOf(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Model calls already made in this turn: the assistant messages since the person spoke. */
export function stepsThisTurn(prompt: readonly Message[]): number {
  const start = lastUserIndex(prompt);
  return prompt.slice(start + 1).filter((message) => message.role === "assistant").length;
}

/**
 * Input tokens this turn has already spent, estimated from the prompt: each
 * earlier call this turn saw the prompt up to its own assistant message, plus
 * the tool schemas.
 */
export function estimatedTurnInputTokens(prompt: readonly Message[], toolChars: number): number {
  const start = lastUserIndex(prompt);
  let chars = 0;
  let running = prompt.slice(0, start + 1).reduce((sum, message) => sum + sizeOf(message.content), 0);
  for (const message of prompt.slice(start + 1)) {
    if (message.role === "assistant") chars += running + toolChars;
    running += sizeOf(message.content);
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function trimText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[… trimmed ${text.length - limit} characters to fit the context budget]`;
}

/** A tool result cut to `limit` characters, as text the model can still read and cite from. */
function trimResult(part: Part, limit: number): Part {
  const output = part.output as { type?: string; value?: unknown } | undefined;
  if (!output || typeof output !== "object") return part;
  const text = typeof output.value === "string" ? output.value : JSON.stringify(output.value ?? null);
  if (text.length <= limit) return part;
  const type = output.type === "error-text" || output.type === "error-json" ? "error-text" : "text";
  return { ...part, output: { type, value: trimText(text, limit) } };
}

/** Tool results trimmed to the budget: the current turn's generously, earlier turns' hard. */
export function trimToolResults(prompt: readonly Message[]): Message[] {
  const start = lastUserIndex(prompt);
  return prompt.map((message, index) => {
    if (typeof message.content === "string") return message;
    const limit = index > start ? CURRENT_TURN_RESULT_CHARS : EARLIER_TURN_RESULT_CHARS;
    if (!message.content.some((part) => part.type === "tool-result")) return message;
    return {
      ...message,
      content: message.content.map((part) => (part.type === "tool-result" ? trimResult(part, limit) : part)),
    };
  });
}

/** The lane's skill appended to the person's latest message (the tail, after the cached prefix). */
function withNote(prompt: readonly Message[], note: string): Message[] {
  const index = lastUserIndex(prompt);
  if (index < 0) return [...prompt];
  return prompt.map((message, i) => {
    if (i !== index) return message;
    const parts: Part[] =
      typeof message.content === "string" ? [{ type: "text", text: message.content }] : [...message.content];
    return { ...message, content: [...parts, { type: "text", text: `\n\n[${note}]` }] };
  });
}

export type LaneDecision = {
  /** True inside a sub-agent (it has no delegation tool of its own). */
  inSubAgent: boolean;
  steps: number;
  estimatedInputTokens: number;
  /** True when a cap was reached and this call must answer without tools. */
  forcedAnswer: boolean;
};

/** Apply the lane to one model call. Returns the options to send and what was decided. */
export function applyLane(options: CallOptions, route: TurnRoute): { options: CallOptions; decision: LaneDecision } {
  const tools = options.tools ?? [];
  const inSubAgent = !tools.some((tool) => tool.name === DELEGATE_TOOL);
  const policy = policyFor(route, inSubAgent);
  const allowed = visibleTools(policy, route);
  const shown = tools.filter((tool) => allowed.has(tool.name));

  const steps = stepsThisTurn(options.prompt);
  const estimatedInputTokens = estimatedTurnInputTokens(options.prompt, sizeOf(shown));
  const forcedAnswer =
    shown.length > 0 && (steps >= policy.maxSteps - 1 || estimatedInputTokens >= policy.maxInputTokens);

  const note = forcedAnswer
    ? `${policy.skill} This is the last step for this turn: answer now from what you have, and say in one line what you could not check.`
    : policy.skill;

  const next: CallOptions = {
    ...options,
    prompt: withNote(trimToolResults(options.prompt), note),
    tools: shown.length > 0 ? shown : undefined,
    toolChoice: shown.length === 0 ? undefined : forcedAnswer ? { type: "none" } : options.toolChoice,
  };
  return { options: next, decision: { inSubAgent, steps, estimatedInputTokens, forcedAnswer } };
}

/**
 * Wrap a model so every call goes through `applyLane`. A Proxy rather than a
 * new model object: eve reads the model's identity fields (provider, modelId)
 * for its events and spend, and those stay the real model's.
 */
export function withLane<T extends object>(model: T, route: TurnRoute): T {
  return new Proxy(model, {
    get(target, property, receiver) {
      const method = Reflect.get(target, property, receiver);
      if ((property === "doGenerate" || property === "doStream") && typeof method === "function") {
        return (options: CallOptions) => Reflect.apply(method, target, [applyLane(options, route).options]);
      }
      return method;
    },
  });
}
