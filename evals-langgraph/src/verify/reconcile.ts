export type VerificationGroup = "header" | "ordering" | "tools" | "redaction" | "cost" | "langfuse";
export type VerificationCheck = { group: VerificationGroup; passed: boolean; detail: string };
export type Reconciliation =
  | { status: "not_applicable" | "skipped" | "pending"; reason: string }
  | { status: "passed" | "failed"; checks: VerificationCheck[] };
export type TraceDataset = {
  headers: { id: string; workspaceId: string; objective: string; state: string; model: string | null; startedAt: string | null; endedAt: string | null; lastEventSeq: number; error: string | null }[];
  events: { sequence: number; type: string; data: Record<string, unknown> }[];
  tools: { ok: boolean | null; durationMs: number | null; errorCode: string | null; arguments: unknown; result: unknown }[];
  settledUsd: string | null;
  critiqueRequested: boolean;
};
export type VerificationScope = { runId: string; workspaceId: string; objective: string };
export type VerifyRun = (scope: { runId: string; objective: string; startedAt: string; endedAt: string }) => Promise<Reconciliation>;
const SECRET_KEY = /secret|token|password|passwd|authorization|api[_-]?key|credential|cookie/i;
export function hasUnredactedKey(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasUnredactedKey);
  return Object.entries(value).some(([key, entry]) => SECRET_KEY.test(key) ? entry !== "[redacted]" : hasUnredactedKey(entry));
}
export function redactedText(text: string): string {
  return text.replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/((?:token|secret|password|authorization|api[-_]?key|credential)[a-z0-9_-]*["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi, "$1[redacted]");
}
function decimalParts(value: string): { units: bigint; scale: number } {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`Invalid nonnegative cost: ${value}`);
  const [whole, fraction = ""] = value.split(".");
  return { units: BigInt(whole + fraction), scale: fraction.length };
}
export function costsClose(values: string[], settled: string | null): boolean {
  if (settled === null) return false;
  const parts = [...values, settled].map(decimalParts);
  const scale = Math.max(6, ...parts.map((part) => part.scale));
  const units = parts.map((part) => part.units * BigInt(10) ** BigInt(scale - part.scale));
  const actual = units.pop() ?? BigInt(0);
  const sum = units.reduce((total, item) => total + item, BigInt(0));
  // spending_reservations.settled_usd is numeric(12,6), rounded by Postgres.
  const factor = BigInt(10) ** BigInt(scale - 6);
  return (sum + factor / BigInt(2)) / factor === actual / factor;
}
export function checkDataset(scope: VerificationScope, data: TraceDataset): VerificationCheck[] {
  const header = data.headers[0];
  const check = (group: VerificationGroup, passed: boolean, detail: string): VerificationCheck => ({ group, passed, detail });
  const headersOk = data.headers.length === 1 && header.id === scope.runId && header.workspaceId === scope.workspaceId
    && header.objective === scope.objective && ["succeeded", "failed", "cancelled"].includes(header.state)
    && Boolean(header.model) && header.startedAt !== null && header.endedAt !== null
    && Number.isFinite(Date.parse(header.startedAt)) && Date.parse(header.startedAt) <= Date.parse(header.endedAt);
  const events = data.events;
  const first = events[0];
  const terminal = `run.${header?.state}`;
  const orderingOk = events.length > 0 && events.every((event, index) => event.sequence === index + 1)
    && header?.lastEventSeq === events.length && first.type === "message" && first.data.role === "user" && first.data.content === scope.objective
    && events.at(-1)?.type === terminal && events.filter((event) => /^run\.(succeeded|failed|cancelled)$/.test(event.type)).length === 1;
  let costOk = false;
  let costError = "Usage matches settled spend and succeeded run has critique outbox event";
  try {
    const values = events.filter((event) => event.type === "usage" && event.data.costUsd !== undefined).map((event) => String(event.data.costUsd));
    costOk = costsClose(values, data.settledUsd) && (header?.state !== "succeeded" || data.critiqueRequested);
  } catch (error) { costError = String(error); }
  return [
    check("header", headersOk, "One scoped terminal run, valid timestamps, objective and model"),
    check("ordering", orderingOk, "Sequence 1..N, objective first, terminal last, high-water N"),
    check("tools", data.tools.every((tool) => tool.ok !== null && tool.durationMs !== null && tool.durationMs >= 0 && (tool.errorCode === null || tool.ok === false)), "All reserved tool calls settled"),
    check("redaction", data.tools.every((tool) => !hasUnredactedKey(tool.arguments) && !hasUnredactedKey(tool.result)) && (!header?.error || redactedText(header.error) === header.error), "Structured secrets masked and error redaction idempotent"),
    check("cost", costOk, costError),
  ];
}
export function reconcileDataset(scope: VerificationScope, data: TraceDataset, langfuse: VerificationCheck): Reconciliation {
  const checks = [...checkDataset(scope, data), langfuse];
  return { status: checks.every((check) => check.passed) ? "passed" : "failed", checks };
}
