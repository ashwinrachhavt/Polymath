import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageLike } from "../../eve/polymath/agent/lib/turn-tools";

/*
 * The guards inside the authored tools are the part the model cannot talk its
 * way past. These tests drive the real tool definitions with the same message
 * history Eve hands them, so a broken join (or a guard placed after the
 * provider call) fails here rather than in a live run.
 */

const { getRunBySessionRef, fetchPageForAgent, crawlSiteForAgent, searchWebForAgent } = vi.hoisted(() => ({
  getRunBySessionRef: vi.fn(),
  fetchPageForAgent: vi.fn(),
  crawlSiteForAgent: vi.fn(),
  searchWebForAgent: vi.fn(),
}));

vi.mock("@/domains/agents/queries", () => ({ getRunBySessionRef }));
vi.mock("@/domains/knowledge/web-fetch", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/domains/knowledge/web-fetch")>();
  return { ...original, fetchPageForAgent, crawlSiteForAgent };
});
vi.mock("@/domains/knowledge/web-search", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/domains/knowledge/web-search")>();
  return { ...original, searchWebForAgent };
});

import webFetch from "../../eve/polymath/agent/tools/web_fetch";
import webSearch from "../../eve/polymath/agent/tools/web_search";

type Call = { toolCallId: string; toolName: string; input: Record<string, unknown> };
type Result = { toolCallId: string; toolName: string; output: { type: "json"; value: unknown } };

function ctx(messages: MessageLike[]) {
  return {
    session: {
      id: "session-1",
      auth: { current: { principalId: "user-1", attributes: { workspaceId: "workspace-1" } } },
    },
    messages,
  } as never;
}

function call(input: Call): MessageLike {
  return { role: "assistant", content: [{ type: "tool-call", ...input }] };
}

function result(input: Result): MessageLike {
  return { role: "tool", content: [{ type: "tool-result", ...input }] };
}

beforeEach(() => {
  getRunBySessionRef.mockReset();
  fetchPageForAgent.mockReset();
  crawlSiteForAgent.mockReset();
  searchWebForAgent.mockReset();
  getRunBySessionRef.mockResolvedValue({
    state: "running",
    policySnapshot: { allowedTools: ["web.fetch", "web.search"] },
  });
  fetchPageForAgent.mockResolvedValue({
    ok: true,
    url: "https://example.com",
    title: "Example",
    markdown: "body",
    truncated: false,
  });
  searchWebForAgent.mockResolvedValue({ ok: true, provider: "test", query: "query", results: [] });
});

describe("web_fetch turn guards", () => {
  it("refuses a page it already fetched this turn without calling the provider again", async () => {
    const messages: MessageLike[] = [
      { role: "user", content: "summarize this video" },
      call({
        toolCallId: "1",
        toolName: "web_fetch",
        input: { url: "https://www.youtube.com/watch?v=cd1xrO2q9HU&si=x" },
      }),
      result({ toolCallId: "1", toolName: "web_fetch", output: { type: "json", value: { ok: true } } }),
    ];

    const out = await webFetch.execute({ url: "https://youtube.com/watch?v=cd1xrO2q9HU#t=10" }, ctx(messages));
    expect(out).toMatchObject({ ok: false });
    expect((out as { error: string }).error).toMatch(/already fetched this turn/);
    expect(fetchPageForAgent).not.toHaveBeenCalled();
  });

  it("treats a short link and a watch URL as the same video", async () => {
    const messages: MessageLike[] = [
      { role: "user", content: "summarize this video" },
      call({ toolCallId: "1", toolName: "web_fetch", input: { url: "https://youtu.be/cd1xrO2q9HU" } }),
      result({ toolCallId: "1", toolName: "web_fetch", output: { type: "json", value: { ok: true } } }),
    ];

    const out = await webFetch.execute({ url: "https://www.youtube.com/watch?v=cd1xrO2q9HU&si=x" }, ctx(messages));
    expect(out).toMatchObject({ ok: false });
    expect(fetchPageForAgent).not.toHaveBeenCalled();
  });

  it("stops after two failed fetches instead of trying a third mirror", async () => {
    const messages: MessageLike[] = [
      { role: "user", content: "read this page" },
      call({ toolCallId: "1", toolName: "web_fetch", input: { url: "https://example.com/a" } }),
      result({
        toolCallId: "1",
        toolName: "web_fetch",
        output: { type: "json", value: { ok: false, error: "blocked" } },
      }),
      call({ toolCallId: "2", toolName: "web_fetch", input: { url: "https://mirror.example/a" } }),
      result({
        toolCallId: "2",
        toolName: "web_fetch",
        output: { type: "json", value: { ok: false, error: "blocked" } },
      }),
    ];

    const out = await webFetch.execute({ url: "https://proxy.example/a" }, ctx(messages));
    expect(out).toMatchObject({ ok: false });
    expect((out as { error: string }).error).toMatch(/failed 2 times this turn/);
    expect(fetchPageForAgent).not.toHaveBeenCalled();
  });

  it("allows a fresh page when the turn has budget and no duplicate", async () => {
    const out = await webFetch.execute({ url: "https://example.com" }, ctx([{ role: "user", content: "read" }]));
    expect(out).toMatchObject({ ok: true });
    expect(fetchPageForAgent).toHaveBeenCalledOnce();
  });
});

describe("web_search turn guards", () => {
  it("refuses a query that already ran this turn", async () => {
    const messages: MessageLike[] = [
      { role: "user", content: "what happened" },
      call({ toolCallId: "1", toolName: "web_search", input: { query: "Anthropic   IPO" } }),
      result({ toolCallId: "1", toolName: "web_search", output: { type: "json", value: { ok: true, results: [] } } }),
    ];

    const out = await webSearch.execute({ query: "anthropic ipo" }, ctx(messages));
    expect(out).toMatchObject({ ok: false });
    expect((out as { error: string }).error).toMatch(/already ran this turn/);
    expect(searchWebForAgent).not.toHaveBeenCalled();
  });

  it("stops after two empty result sets", async () => {
    const messages: MessageLike[] = [
      { role: "user", content: "what happened" },
      call({ toolCallId: "1", toolName: "web_search", input: { query: "one" } }),
      result({ toolCallId: "1", toolName: "web_search", output: { type: "json", value: { ok: true, results: [] } } }),
      call({ toolCallId: "2", toolName: "web_search", input: { query: "two" } }),
      result({ toolCallId: "2", toolName: "web_search", output: { type: "json", value: { ok: true, results: [] } } }),
    ];

    const out = await webSearch.execute({ query: "three" }, ctx(messages));
    expect(out).toMatchObject({ ok: false });
    expect((out as { error: string }).error).toMatch(/Two searches came back empty/);
    expect(searchWebForAgent).not.toHaveBeenCalled();
  });
});
