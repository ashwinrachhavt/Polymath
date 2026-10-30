import { z } from "zod";
import { ChatAccumulator } from "../../../src/domains/agents/stream-contract";
import type { Observation } from "../cases/types";
const base = { runId: z.string().uuid(), cursor: z.number().int().nonnegative() };
const frameSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("delta"), blockId: z.string(), text: z.string() }),
  z.object({ ...base, type: z.literal("block"), blockId: z.string(), text: z.string(), finishReason: z.string().nullable() }),
  z.object({ ...base, type: z.literal("snapshot"), blocks: z.array(z.object({ id: z.string(), kind: z.enum(["assistant", "reasoning", "user"]), text: z.string(), done: z.boolean() })) }),
  z.object({ ...base, type: z.literal("tool"), callId: z.string(), label: z.string(), status: z.enum(["running", "ok", "error"]), input: z.unknown().optional() }),
  z.object({ ...base, type: z.literal("end"), state: z.enum(["succeeded", "failed", "cancelled"]) }),
  z.object({ ...base, type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type TerminalState = "succeeded" | "failed" | "cancelled";
export type StreamResult = { observation: Observation; terminal?: TerminalState; cursor: number; diagnostics: string[] };
/** Frame state that outlives one connection, so a reconnect resumes instead of restarting. */
export type StreamState = { accumulator: ChatAccumulator; calls: Map<string, { name: string; input: unknown }>; cursor: number; terminal?: TerminalState };
export function createStreamState(): StreamState { return { accumulator: new ChatAccumulator(), calls: new Map(), cursor: 0 }; }
export function observationOf(state: StreamState): Observation { return { reply: state.accumulator.assistantText(), toolCalls: [...state.calls.values()], fixture: {} }; }
export function decodeStreamLine(line: string): z.infer<typeof frameSchema> | null {
  const payload = line.trim().replace(/^data:\s?/, "");
  if (!payload || payload.startsWith(":" ) || payload.startsWith("event:") || payload.startsWith("id:") || payload === "[DONE]") return null;
  const value: unknown = JSON.parse(payload);
  const result = frameSchema.safeParse(value);
  if (result.success) return result.data;
  const type = z.object({ type: z.string() }).parse(value).type;
  if (["message", "citations", "turn"].includes(type)) return null;
  throw new Error(`Malformed ChatFrame: ${result.error.message}`);
}
export async function readRunStream(response: Response, runId: string, state: StreamState = createStreamState()): Promise<StreamResult> {
  if (!response.body) throw new Error("Missing stream body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const diagnostics: string[] = [];
  let buffer = "";
  function apply(line: string): void {
    const frame = decodeStreamLine(line);
    if (!frame) return;
    if (frame.runId !== runId) throw new Error("Stream runId mismatch");
    state.cursor = Math.max(state.cursor, frame.cursor);
    if (frame.type === "tool") {
      // Settled frames carry results in input, not the original arguments.
      if (!state.calls.has(frame.callId) || frame.status === "running") state.calls.set(frame.callId, { name: frame.label, input: frame.status === "running" ? frame.input : undefined });
    } else if (frame.type === "end") state.terminal = frame.state;
    else if (frame.type === "error") diagnostics.push(`${frame.code}: ${frame.message}`);
    else state.accumulator.apply(frame);
  }
  try {
    while (!state.terminal) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > 2_000_000) throw new Error("Stream frame exceeds 2MB limit");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) apply(line);
      if (chunk.done) { if (buffer.trim()) apply(buffer); break; }
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return { observation: observationOf(state), terminal: state.terminal, cursor: state.cursor, diagnostics };
}
