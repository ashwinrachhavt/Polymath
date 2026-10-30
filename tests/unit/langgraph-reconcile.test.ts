import { expect, it } from "vitest";
import { checkDataset, costsClose, hasUnredactedKey, redactedText, reconcileDataset, type TraceDataset } from "../../evals-langgraph/src/verify/reconcile";
const scope = { runId: "run", workspaceId: "workspace", objective: "Hello" };
function dataset(): TraceDataset {
  return {
    headers: [{ id: "run", workspaceId: "workspace", objective: "Hello", state: "succeeded", model: "model", startedAt: "2026-10-29T00:00:00Z", endedAt: "2026-10-29T00:00:01Z", lastEventSeq: 3, sessionRef: "wrun_session", error: null }],
    events: [{ sequence: 1, type: "message", data: { role: "user", content: "Hello" } }, { sequence: 2, type: "usage", data: { costUsd: "0.1" } }, { sequence: 3, type: "run.succeeded", data: {} }],
    tools: [{ ok: true, durationMs: 1, errorCode: null, arguments: { secret: "[redacted]" }, result: {} }], settledUsd: "0.100000", critiqueRequested: true,
  };
}
it("checks five groups but requires explicit Langfuse evidence for all six", () => {
  expect(checkDataset(scope, dataset()).every((item) => item.passed)).toBe(true);
  expect(reconcileDataset(scope, dataset(), { group: "langfuse", passed: false, detail: "not observed" }).status).toBe("failed");
});
const breaks: { group: string; break: (data: TraceDataset) => void }[] = [
  { group: "header", break: (data) => { data.headers = []; } },
  { group: "header", break: (data) => { data.headers[0].workspaceId = "other"; } },
  { group: "header", break: (data) => { data.headers[0].endedAt = "invalid"; } },
  { group: "ordering", break: (data) => { data.events[1].sequence = 4; } },
  { group: "ordering", break: (data) => { data.events.pop(); } },
  { group: "tools", break: (data) => { data.tools[0].ok = null; } },
  { group: "tools", break: (data) => { data.tools[0].errorCode = "provider_failed"; } },
  { group: "redaction", break: (data) => { data.tools[0].result = { nested: [{ api_key: "leak" }] }; } },
  { group: "redaction", break: (data) => { data.headers[0].error = "Bearer raw-token"; } },
  { group: "redaction", break: (data) => { data.headers[0].error = 'password: "[redacted] hunter"'; } },
  { group: "cost", break: (data) => { data.settledUsd = "0.2"; } },
  { group: "cost", break: (data) => { data.critiqueRequested = false; } },
];
it.each(breaks)("fails broken $group loudly", (row) => {
  const data = dataset(); row.break(data);
  expect(checkDataset(scope, data).find((item) => item.group === row.group)?.passed).toBe(false);
});
it("handles exact decimals and redaction idempotence", () => {
  expect(costsClose(["0.1", "0.2"], "0.300000")).toBe(true);
  expect(costsClose(["0.0000006"], "0.000001")).toBe(true);
  expect(costsClose([], null)).toBe(false);
  expect(() => costsClose(["invalid"], "0")).toThrow(/Invalid/);
  expect(hasUnredactedKey({ cookie: "raw" })).toBe(true);
  const text = redactedText("Authorization: Bearer raw-token api_key=secret");
  expect(text).not.toContain("raw-token");
  expect(redactedText(text)).toBe(text);
});
it("masks a quoted secret in full and double-redaction is a no-op", () => {
  const masked = redactedText(`password: "hunter hunter", token='abc def' api_key=xyz`);
  expect(masked).toBe(`password: "[redacted]", token='[redacted]' api_key=[redacted]`);
  expect(redactedText(masked)).toBe(masked);
  expect(redactedText(`password: "oops trailing`)).toBe(`password: "[redacted]`);
});
