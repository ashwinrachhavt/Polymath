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
export type StreamResult = { observation: Observation; terminal?: TerminalState; diagnostics: string[] };
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
export async function readRunStream(response: Response, runId: string): Promise<StreamResult> {
  if (!response.body) throw new Error("Missing stream body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const accumulator = new ChatAccumulator();
  const calls = new Map<string, { name: string; input: unknown }>();
  const diagnostics: string[] = [];
  let terminal: TerminalState | undefined;
  let buffer = "";
  function apply(line: string): void {
    const frame = decodeStreamLine(line);
    if (!frame) return;
    if (frame.runId !== runId) throw new Error("Stream runId mismatch");
    if (frame.type === "tool") {
      // Settled frames carry results in input, not the original arguments.
      if (!calls.has(frame.callId) || frame.status === "running") calls.set(frame.callId, { name: frame.label, input: frame.status === "running" ? frame.input : undefined });
    } else if (frame.type === "end") terminal = frame.state;
    else if (frame.type === "error") diagnostics.push(`${frame.code}: ${frame.message}`);
    else accumulator.apply(frame);
  }
  try {
    while (!terminal) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > 2_000_000) throw new Error("Stream frame exceeds 2MB limit");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) apply(line);
      if (chunk.done) { if (buffer.trim()) apply(buffer); break; }
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return { observation: { reply: accumulator.assistantText(), toolCalls: [...calls.values()], fixture: {} }, terminal, diagnostics };
}
