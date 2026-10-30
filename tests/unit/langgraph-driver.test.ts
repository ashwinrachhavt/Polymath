import { expect, it, vi } from "vitest";
import { parseCase } from "../../evals-langgraph/src/cases/types";
import { createRunsClient } from "../../evals-langgraph/src/drive/runs-client";
import { readRunStream, decodeStreamLine } from "../../evals-langgraph/src/drive/stream";
import { readConfig } from "../../evals-langgraph/src/config";
const runId = "00000000-0000-4000-8000-000000000001";
const key1 = "00000000-0000-4000-8000-000000000002";
const key2 = "00000000-0000-4000-8000-000000000003";
const item = parseCase({ id: "test", suite: "chat-grounding", fixtureOnly: false, objective: "Hello", assertions: [{ kind: "includes", target: "reply", severity: "gate", label: "reply", expected: "Hello" }] });
const created = () => Response.json({ runId }, { status: 201 });
const terminal = () => Response.json({ run: { id: runId, state: "succeeded", summary: "poll reply" } });
const problem = (status: number, code: string) => Response.json({ code }, { status });
it("starts with route body and per-attempt UUID then follows NDJSON", async () => {
  const stream = new Response(JSON.stringify({ type: "block", runId, cursor: 0, blockId: "a", text: "Hello", finishReason: "stop" }) + "\n"
    + JSON.stringify({ type: "end", runId, cursor: 1, state: "succeeded" }) + "\n");
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(created()).mockResolvedValueOnce(stream);
  const client = createRunsClient(readConfig({}), { fetch: fetcher, uuid: () => key1 });
  expect(await client.start(item)).toBe(runId);
  expect((await client.follow(runId)).observation.reply).toBe("Hello");
  const init = fetcher.mock.calls[0][1];
  expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(key1);
  expect(JSON.parse(String(init?.body))).toEqual({ objective: "Hello", estimateUsd: "0.50", profileName: "polymath" });
  expect(new Headers(fetcher.mock.calls[1][1]?.headers).get("Accept")).toContain("application/x-ndjson");
});
it("does not retry a 422 idempotency conflict", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(problem(422, "idempotency_conflict"));
  await expect(createRunsClient(readConfig({}), { fetch: fetcher }).start(item)).rejects.toThrow(/422.*idempotency_conflict/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([409, 502])("honors receipt ownership on %i", async (status) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(problem(status, status === 409 ? "request_in_progress" : "agent_start_failed")).mockResolvedValueOnce(created());
  const uuid = vi.fn().mockReturnValueOnce(key1).mockReturnValueOnce(key2);
  const client = createRunsClient(readConfig({}), { fetch: fetcher, uuid, sleep: async () => undefined });
  expect(await client.start(item)).toBe(runId);
  expect(new Headers(fetcher.mock.calls[1][1]?.headers).get("Idempotency-Key")).toBe(status === 409 ? key1 : key2);
});
it("surfaces missing bridge secret as configuration, not a crash", async () => {
  await expect(createRunsClient(readConfig({}), { fetch: vi.fn<typeof fetch>().mockResolvedValue(problem(503, "agent_bridge_unavailable")) }).start(item)).rejects.toThrow(/configure EVE_BRIDGE_SECRET/);
});
it("polls when stream fails, authenticates companion and preserves diagnostic", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(problem(502, "stream_unavailable")).mockResolvedValueOnce(terminal());
  const client = createRunsClient(readConfig({ POLYMATH_COMPANION_TOKEN: "axm_local.test" }), { fetch: fetcher });
  const result = await client.follow(runId);
  expect(result.observation.reply).toBe("poll reply");
  expect(result.diagnostics[0]).toMatch(/using polling/);
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer axm_local.test");
});
it("reconstructs UTF8 chunk boundaries, replay deltas, tool input and SSE tail", async () => {
  const frames = [
    { type: "delta", runId, cursor: 0, blockId: "a", text: "café" },
    { type: "delta", runId, cursor: 0, blockId: "a", text: "café" },
    { type: "tool", runId, cursor: 1, callId: "t", label: "linear_issue_propose", status: "running", input: { text: "original" } },
    { type: "tool", runId, cursor: 2, callId: "t", label: "linear_issue_propose", status: "ok", input: { result: "draft" } },
    { type: "end", runId, cursor: 3, state: "succeeded" },
  ];
  const bytes = new TextEncoder().encode(frames.map((frame) => `data: ${JSON.stringify(frame)}`).join("\n\n"));
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  const result = await readRunStream(new Response(body), runId);
  expect(result.observation.reply).toBe("café");
  expect(result.observation.toolCalls[0].input).toEqual({ text: "original" });
  expect(result.terminal).toBe("succeeded");
});
it("rejects malformed or foreign frames", async () => {
  expect(() => decodeStreamLine('{"type":"block"}')).toThrow(/Malformed ChatFrame/);
  await expect(readRunStream(new Response(JSON.stringify({ type: "end", runId: key1, cursor: 0, state: "succeeded" })), runId)).rejects.toThrow(/runId mismatch/);
});
it("replays the stream from the applied cursor after a premature close", async () => {
  const line = (frame: Record<string, unknown>) => `data: ${JSON.stringify(frame)}\n`;
  // Connection 1: a partial reply and a running tool call, then a hard cut mid-frame —
  // no terminal frame ever arrives.
  const cut = new Response(line({ type: "delta", runId, cursor: 0, blockId: "a", text: "Partial " })
    + line({ type: "tool", runId, cursor: 1, callId: "t", label: "documents_search", status: "running", input: { q: "rent" } })
    + `data: {"type":"delta","runId":"${runId}","blockId":"a","cursor":2,"text":"trunca`);
  // Connection 2: the proxy's overlap replay (cursor 1 again), the reply tail, the settled
  // tool call, and the terminal frame.
  const resumed = new Response(line({ type: "tool", runId, cursor: 1, callId: "t", label: "documents_search", status: "running", input: { q: "rent" } })
    + line({ type: "delta", runId, cursor: 2, blockId: "a", text: "continued" })
    + line({ type: "tool", runId, cursor: 3, callId: "t", label: "documents_search", status: "ok", input: { result: "settled" } })
    + line({ type: "end", runId, cursor: 4, state: "succeeded" }));
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(created()).mockResolvedValueOnce(cut).mockResolvedValueOnce(resumed);
  const result = await createRunsClient(readConfig({}), { fetch: fetcher }).follow(runId);
  expect(result.state).toBe("succeeded");
  expect(result.observation.reply).toBe("Partial continued");
  expect(result.observation.toolCalls).toEqual([{ name: "documents_search", input: { q: "rent" } }]);
  expect(new Headers(fetcher.mock.calls[2][1]?.headers).get("x-chat-cursor")).toBe("1");
});
it("falls back to polling once the reconnect bound is exhausted", async () => {
  const truncated = () => new Response(`data: {"type":"delta","runId":"${runId}","blockId":"a","cursor":0,"text":"cut`);
  // follow() starts at the stream: three truncated connections, then the poll.
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(truncated()).mockResolvedValueOnce(truncated()).mockResolvedValueOnce(truncated()).mockResolvedValueOnce(terminal());
  const result = await createRunsClient(readConfig({}), { fetch: fetcher, sleep: async () => undefined }).follow(runId);
  expect(result.state).toBe("succeeded");
  expect(result.observation.reply).toBe("poll reply");
  expect(result.diagnostics.join(" ")).toMatch(/using polling/);
  expect(fetcher).toHaveBeenCalledTimes(4);
});
