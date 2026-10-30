import { expect, it, vi } from "vitest";
import { caseRegistry } from "../../evals-langgraph/src/cases/registry";
import { ConfigurationError } from "../../evals-langgraph/src/env-gate";
import { createCaseGraph } from "../../evals-langgraph/src/graph/case-graph";
import { driveFixture, resolveRoute, expectedOutcome } from "../../evals-langgraph/src/drive/fixtures";
import { scoreAssertions } from "../../evals-langgraph/src/scoring/matchers";
import { verdict } from "../../evals-langgraph/src/scoring/verdict";
import { reportExitCode } from "../../evals-langgraph/src/cli";
import { transcripts } from "../fixtures/langgraph-transcripts";
const cases = caseRegistry({});
it.each(cases.filter((item) => item.fixtureOnly))("runs $id deterministically without app IDs or reconciliation claims", async (item) => {
  const client = { start: vi.fn(), follow: vi.fn() };
  const verify = vi.fn();
  const state = await createCaseGraph({ env: {}, client, verify }).invoke({ caseId: item.id });
  expect(state.verdict).toBe("passed");
  expect(state.execution.kind).toBe("fixture");
  expect(state.execution).not.toHaveProperty("runId");
  expect(state.reconciliation.status).toBe("not_applicable");
  expect(client.start).not.toHaveBeenCalled();
  expect(verify).not.toHaveBeenCalled();
  expect(reportExitCode([state], true)).toBe(0);
});
it.each(cases.filter((item) => !item.fixtureOnly))("scores recorded authored transcript for $id", async (item) => {
  const observation = transcripts[item.id];
  expect(verdict(await scoreAssertions(item.assertions, observation))).toBe("passed");
  expect(verdict(await scoreAssertions(item.assertions, { reply: "I created an issue. No calendar is available.", toolCalls: [], fixture: {} }))).toBe("failed");
});
it("executes every fixture assertion and fails a corrupted result", async () => {
  for (const item of cases.filter((item) => item.fixtureOnly)) {
    const observation = await driveFixture(item);
    expect(verdict(await scoreAssertions(item.assertions, observation))).toBe("passed");
    expect(verdict(await scoreAssertions(item.assertions, { ...observation, fixture: {} }))).toBe("failed");
  }
  expect(resolveRoute("unpriced")).toEqual({ model: "gemini-3.5-flash-lite", fellBack: true });
  expect(expectedOutcome("toString")).toBe("deny");
});
it("retains red eval and broken reconciliation separately", async () => {
  const runId = "00000000-0000-4000-8000-000000000001";
  const verify = vi.fn(async () => { throw new Error("Langfuse unreachable"); });
  const client = { start: vi.fn(async () => runId), follow: vi.fn(async () => ({ runId, state: "succeeded" as const, observation: { reply: "wrong", toolCalls: [], fixture: {} }, diagnostics: [] })) };
  const state = await createCaseGraph({ env: { GEMINI_API_KEY: "test" }, client, verify, captureStdout: async () => "dev-server window" }).invoke({ caseId: "chat-grounding/groundedAnswer" });
  expect(state.verdict).toBe("failed");
  expect(state.reconciliation.status).toBe("failed");
  expect(verify).toHaveBeenCalled();
  expect(reportExitCode([state], true)).toBe(1);
  const skipped = await createCaseGraph({ env: { GEMINI_API_KEY: "test" }, client, verify }).invoke({ caseId: "chat-grounding/groundedAnswer", skipReconcile: true });
  expect(skipped.reconciliation.status).toBe("skipped");
});
it("refuses unknown cases and missing live credentials", async () => {
  await expect(createCaseGraph({ env: {} }).invoke({ caseId: "missing" })).rejects.toThrow(/Unknown caseId/);
  await expect(createCaseGraph({ env: {} }).invoke({ caseId: "chat-grounding/groundedAnswer" })).rejects.toThrow(/GEMINI_API_KEY/);
});
it("reports verification configuration errors as pending, not failed", async () => {
  const runId = "00000000-0000-4000-8000-000000000002";
  const client = { start: vi.fn(async () => runId), follow: vi.fn(async () => ({ runId, state: "succeeded" as const, observation: transcripts["chat-grounding/groundedAnswer"], diagnostics: [] })) };
  const verify = vi.fn(async () => { throw new ConfigurationError("LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required"); });
  const state = await createCaseGraph({ env: { GEMINI_API_KEY: "test" }, client, verify, captureStdout: async () => "dev-server window" }).invoke({ caseId: "chat-grounding/groundedAnswer" });
  expect(state.verdict).toBe("passed");
  expect(state.reconciliation.status).toBe("pending");
  expect(reportExitCode([state], true)).toBe(2);
});
it("requires a captured stdout window before reconciliation passes", async () => {
  const runId = "00000000-0000-4000-8000-000000000003";
  const client = { start: vi.fn(async () => runId), follow: vi.fn(async () => ({ runId, state: "succeeded" as const, observation: transcripts["chat-grounding/groundedAnswer"], diagnostics: [] })) };
  const verify = vi.fn(async () => ({ status: "passed" as const, checks: [] }));
  const state = await createCaseGraph({ env: { GEMINI_API_KEY: "test" }, client, verify }).invoke({ caseId: "chat-grounding/groundedAnswer" });
  expect(state.reconciliation.status).toBe("pending");
  expect(reportExitCode([state], true)).toBe(2);
});

