import type { StepFacts } from "@/domains/agents/agent-steps";
import { toolLabel } from "@/domains/agents/tool-labels";
import type { StepRow } from "./agent-steps";
import { collectRecords } from "./record-links";

/*
 * Step-card rows from the two things a turn leaves behind: tool calls and
 * visible reasoning. Shared by the live transcript (chat-transcript.tsx) and
 * the stored transcript of a finished run (polymath/[runId]/page.tsx), so a
 * call reads the same before and after a reload. Plain functions, not a client
 * module, so the server page can call them.
 */

export function toolStepRow(tool: {
  callId: string;
  label: string;
  status: "running" | "ok" | "error";
  detail?: string;
  facts?: StepFacts;
  output?: unknown;
}): StepRow {
  // A tool that answered { ok: false } finished as a call but failed as a step.
  const failure = tool.status === "ok" ? (tool.facts?.failure ?? null) : null;
  const detail = failure ?? tool.detail;
  return {
    id: `tool:${tool.callId}`,
    kind: tool.facts?.kind ?? "tool",
    label: toolLabel(tool.label),
    query: tool.facts?.query ?? null,
    sources: tool.facts?.sources ?? [],
    ...(detail ? { detail } : {}),
    status: tool.status === "running" ? "running" : tool.status === "ok" && !failure ? "complete" : "error",
    ...(tool.status !== "running" && tool.output !== undefined ? { records: collectRecords(tool.output) } : {}),
  };
}

export function reasoningStepRow(id: string, text: string, done: boolean): StepRow {
  return {
    id,
    kind: "reasoning",
    label: done ? "Reasoned through the question" : "Reasoning",
    query: null,
    sources: [],
    text,
    status: done ? "complete" : "running",
  };
}
