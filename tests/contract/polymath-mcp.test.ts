import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { run as runHook } from "../../plugins/polymath/hooks/understanding-hook.mjs";
import { normalizeRepo } from "../../plugins/polymath/lib/git.mjs";
import { createServer } from "../../plugins/polymath/mcp/server.mjs";

const SAMPLE_DIFF = readFileSync(new URL("../fixtures/polymath-plugin/sample.diff", import.meta.url), "utf8");
const HOOK_PATH = fileURLToPath(new URL("../../plugins/polymath/hooks/understanding-hook.mjs", import.meta.url));
const SHA = "0123456789abcdef0123456789abcdef01234567";
const ENV = { POLYMATH_URL: "http://polymath.test/", POLYMATH_API_KEY: "axm_test_key" };
const EXPLAINERS = "/api/v1/understanding/explainers";

type Reply = { status?: number; body?: unknown };

function problem(status: number, code: string, title: string): Reply {
  return { status, body: { code, title, status } };
}

function view(overrides: Record<string, unknown> = {}) {
  return {
    id: "ex_1",
    status: "ready",
    error: null,
    repo: "acme/app",
    commit: SHA,
    range: "HEAD~1..HEAD",
    notePath: "/notes/n_1",
    quizPath: "/learn/quiz/q_1",
    passed: false,
    createdAt: "2026-11-12T10:00:00.000Z",
    ...overrides,
  };
}

function fakeFetch(routes: Record<string, Reply | Reply[]>) {
  const queues = new Map(
    Object.entries(routes).map(([key, reply]) => [key, Array.isArray(reply) ? [...reply] : [reply]]),
  );
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}${url.search}`;
    const queue = queues.get(key);
    if (!queue) throw new Error(`unexpected request ${key}`);
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    return Response.json(reply.body ?? {}, { status: reply.status ?? 200 });
  });
}

function fakeExec(
  overrides: {
    remote?: string | null;
    status?: string;
    diff?: string;
    shortstat?: string;
    revs?: Record<string, string>;
  } = {},
) {
  const {
    remote = "https://github.com/acme/app.git",
    status = "",
    diff = SAMPLE_DIFF,
    shortstat = "",
    revs = {},
  } = overrides;
  return vi.fn(async (_file: string, args: string[]) => {
    const [command, ...rest] = args;
    if (command === "remote") {
      if (remote === null) throw new Error("no remote");
      return `${remote}\n`;
    }
    if (command === "status") return status;
    if (command === "diff" && rest[0] === "--shortstat") return shortstat;
    if (command === "diff") return diff;
    if (command === "rev-parse" && rest[0] === "--show-toplevel") return "/work/my-repo\n";
    if (command === "rev-parse") return `${revs[rest[1].replace("^{commit}", "")] ?? SHA}\n`;
    throw new Error(`unexpected git ${args.join(" ")}`);
  });
}

const sleep = async () => {};

function server(routes: Record<string, Reply | Reply[]> = {}, execOverrides: Parameters<typeof fakeExec>[0] = {}) {
  const fetch = fakeFetch(routes);
  const exec = fakeExec(execOverrides);
  return { fetch, exec, ...createServer({ env: ENV, fetch, exec, sleep: vi.fn(sleep) }) };
}

async function callTool(target: { handle: (message: unknown) => Promise<unknown> }, name: string, args: unknown = {}) {
  const response = (await target.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as {
    result: { content: { type: string; text: string }[]; isError?: boolean };
  };
  return response.result;
}

const textOf = (result: { content: { text: string }[] }) => result.content.map((part) => part.text).join("\n");

function postBody(fetch: ReturnType<typeof fakeFetch>, index = 0) {
  const call = fetch.mock.calls.filter(([, init]) => init?.method === "POST")[index];
  return JSON.parse(String(call[1]!.body));
}

describe("JSON-RPC framing", () => {
  it("lists the four tools with hand-written input schemas", async () => {
    const response = (await server().handle({ jsonrpc: "2.0", id: 7, method: "tools/list" })) as {
      id: number;
      result: { tools: { name: string; description: string; inputSchema: { type: string; required?: string[] } }[] };
    };
    expect(response.id).toBe(7);
    expect(response.result.tools.map((tool) => tool.name)).toEqual([
      "explain_change",
      "check_understanding",
      "what_do_i_know",
      "capture",
    ]);
    const required = Object.fromEntries(response.result.tools.map((tool) => [tool.name, tool.inputSchema.required]));
    expect(required).toEqual({
      explain_change: ["summary"],
      check_understanding: ["explainer_id"],
      what_do_i_know: undefined,
      capture: undefined,
    });
    for (const tool of response.result.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(80);
    }
  });

  it("answers initialize with the requested protocol version and tool capability", async () => {
    const response = await server().handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    expect(response).toMatchObject({
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "polymath", version: "0.1.0" },
      },
    });
  });

  it("answers ping, ignores notifications, and rejects unknown methods with -32601", async () => {
    const target = server();
    expect(await target.handle({ jsonrpc: "2.0", id: 2, method: "ping" })).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {},
    });
    expect(await target.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await target.handle({ jsonrpc: "2.0", id: 3, method: "resources/list" })).toMatchObject({
      id: 3,
      error: { code: -32601 },
    });
  });

  it("rejects an unknown tool with -32602", async () => {
    const response = await server().handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } });
    expect(response).toMatchObject({ id: 4, error: { code: -32602 } });
  });

  it("frames newline-delimited messages on a stream and reports parse errors", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const served = server().serve(input, output);
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\nnot json\n');
    input.end();
    await served;
    output.end();
    const lines = output
      .read()
      .toString()
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line));
    expect(lines).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
    ]);
  });
});

describe("missing configuration and server failures", () => {
  it("tells the user how to set the API key and makes no request", async () => {
    const fetch = fakeFetch({});
    const target = createServer({ env: {}, fetch, exec: fakeExec(), sleep });
    const result = await callTool(target, "what_do_i_know");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("POLYMATH_API_KEY is not set");
    expect(textOf(result)).toContain("Settings > API keys");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns the problem title, not a stack trace", async () => {
    const target = server({
      "GET /api/v1/understanding/known": problem(403, "forbidden", "This key cannot read understanding."),
    });
    const result = await callTool(target, "what_do_i_know");
    expect(result).toMatchObject({ isError: true, content: [{ text: "This key cannot read understanding." }] });
  });

  it("reports an unreachable server in one sentence", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const target = createServer({ env: ENV, fetch, exec: fakeExec(), sleep });
    const result = await callTool(target, "what_do_i_know");
    expect(result).toMatchObject({
      isError: true,
      content: [{ text: "Could not reach Polymath at http://polymath.test." }],
    });
  });

  it("sends the bearer key to the configured URL with the trailing slash stripped", async () => {
    const target = server({ "GET /api/v1/understanding/known": { body: { topic: null, concepts: [] } } });
    await callTool(target, "what_do_i_know");
    const [url, init] = target.fetch.mock.calls[0];
    expect(String(url)).toBe("http://polymath.test/api/v1/understanding/known");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer axm_test_key");
  });

  it("defaults to localhost:3000", async () => {
    const fetch = fakeFetch({ "GET /api/v1/understanding/known": { body: { topic: null, concepts: [] } } });
    await callTool(
      createServer({ env: { POLYMATH_API_KEY: "axm_k" }, fetch, exec: fakeExec(), sleep }),
      "what_do_i_know",
    );
    expect(String(fetch.mock.calls[0][0])).toBe("http://localhost:3000/api/v1/understanding/known");
  });
});

describe("explain_change", () => {
  const key = `POST ${EXPLAINERS}`;

  it("posts the last commit's diff with a stable request key and returns the note URL", async () => {
    const target = server({ [key]: { status: 202, body: { explainer: view({ status: "ready" }) } } });
    const result = await callTool(target, "explain_change", {
      summary: "Added retries to the mailer.",
      cwd: "/work/my-repo",
    });
    const digest = createHash("sha256").update("HEAD~1..HEAD").update(SAMPLE_DIFF).digest("hex").slice(0, 16);
    expect(postBody(target.fetch)).toEqual({
      repo: "acme/app",
      commit: SHA,
      range: "HEAD~1..HEAD",
      summary: "Added retries to the mailer.",
      diff: SAMPLE_DIFF,
      requestKey: `acme/app@${SHA}:${digest}`,
    });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("http://polymath.test/notes/n_1");
    expect(textOf(result)).toContain("ex_1");
    expect(textOf(result)).toContain("check_understanding");

    await callTool(target, "explain_change", { summary: "Added retries to the mailer." });
    expect(postBody(target.fetch, 1).requestKey).toBe(postBody(target.fetch, 0).requestKey);
  });

  it("uses git diff HEAD with a null range when the working tree is dirty", async () => {
    const target = server({ [key]: { body: { explainer: view({ range: null }) } } }, { status: " M src/a.ts\n" });
    await callTool(target, "explain_change", { summary: "WIP" });
    expect(postBody(target.fetch)).toMatchObject({ range: null, commit: SHA });
    expect(target.exec).toHaveBeenCalledWith("git", ["diff", "HEAD"], expect.anything());
  });

  it("resolves the end of an explicit range as the commit", async () => {
    const target = server(
      { [key]: { body: { explainer: view() } } },
      { status: " M src/a.ts\n", revs: { HEAD: "f".repeat(40) } },
    );
    await callTool(target, "explain_change", { summary: "Branch work", range: "main..HEAD" });
    expect(postBody(target.fetch)).toMatchObject({ range: "main..HEAD", commit: "f".repeat(40) });
    expect(target.exec).toHaveBeenCalledWith("git", ["diff", "main..HEAD", "--"], expect.anything());
  });

  it("refuses a range that looks like a git option", async () => {
    const target = server();
    const result = await callTool(target, "explain_change", { summary: "x", range: "--output=/tmp/x" });
    expect(result.isError).toBe(true);
    expect(target.fetch).not.toHaveBeenCalled();
  });

  it("truncates a huge diff with a marker line but keys on the whole diff", async () => {
    const huge = `${SAMPLE_DIFF}${"+x\n".repeat(200_000)}`;
    const target = server({ [key]: { body: { explainer: view() } } }, { diff: huge });
    await callTool(target, "explain_change", { summary: "Big" });
    const body = postBody(target.fetch);
    expect(body.diff.startsWith(huge.slice(0, 400_000))).toBe(true);
    expect(body.diff.endsWith("[diff truncated at 400000 characters]\n")).toBe(true);
    expect(body.diff.length).toBeLessThan(400_100);
    const digest = createHash("sha256").update("HEAD~1..HEAD").update(huge).digest("hex").slice(0, 16);
    expect(body.requestKey).toBe(`acme/app@${SHA}:${digest}`);
  });

  it("normalises https and ssh remotes and falls back to the directory name", async () => {
    expect(normalizeRepo("https://github.com/acme/app.git")).toBe("acme/app");
    expect(normalizeRepo("https://user:token@github.com/acme/app")).toBe("acme/app");
    expect(normalizeRepo("git@github.com:acme/app.git")).toBe("acme/app");
    expect(normalizeRepo("ssh://git@github.com:22/acme/app.git")).toBe("acme/app");
    expect(normalizeRepo("not-a-remote")).toBeNull();

    const target = server({ [key]: { body: { explainer: view() } } }, { remote: null });
    await callTool(target, "explain_change", { summary: "No remote" });
    expect(postBody(target.fetch).repo).toBe("my-repo");
  });

  it("polls a pending explainer until it is ready", async () => {
    const target = server({
      [key]: { status: 202, body: { explainer: view({ status: "pending", notePath: null }) } },
      [`GET ${EXPLAINERS}/ex_1`]: [
        { body: { explainer: view({ status: "pending", notePath: null }) } },
        { body: { explainer: view({ status: "ready" }) } },
      ],
    });
    const result = await callTool(target, "explain_change", { summary: "Slow one" });
    expect(textOf(result)).toContain("http://polymath.test/notes/n_1");
    const getCalls = target.fetch.mock.calls.filter(([, init]) => (init?.method ?? "GET") === "GET");
    expect(getCalls).toHaveLength(2);
  });

  it("returns pending with the id when polling gives up", async () => {
    const sleeper = vi.fn(sleep);
    const fetch = fakeFetch({
      [key]: { status: 202, body: { explainer: view({ status: "pending", notePath: null }) } },
      [`GET ${EXPLAINERS}/ex_1`]: { body: { explainer: view({ status: "pending", notePath: null }) } },
    });
    const target = createServer({ env: ENV, fetch, exec: fakeExec(), sleep: sleeper });
    const result = await callTool(target, "explain_change", { summary: "Never finishes" });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("pending");
    expect(textOf(result)).toContain("ex_1");
    expect(sleeper).toHaveBeenCalledTimes(75);
    expect(sleeper).toHaveBeenCalledWith(2000);
  });

  it("returns a failed explainer as an error carrying its message", async () => {
    const target = server({
      [key]: { status: 202, body: { explainer: view({ status: "pending", notePath: null }) } },
      [`GET ${EXPLAINERS}/ex_1`]: {
        body: { explainer: view({ status: "failed", error: "The model refused the diff.", notePath: null }) },
      },
    });
    const result = await callTool(target, "explain_change", { summary: "Bad" });
    expect(result).toMatchObject({ isError: true, content: [{ text: "The model refused the diff." }] });
  });

  it("requires a summary and reports an empty diff", async () => {
    expect((await callTool(server(), "explain_change", {})).isError).toBe(true);
    const empty = await callTool(server({}, { diff: "" }), "explain_change", { summary: "x" });
    expect(textOf(empty)).toContain("no changes");
  });
});

describe("check_understanding", () => {
  const check = `${EXPLAINERS}/ex_1/check`;
  const questions = {
    quizId: "q_1",
    questions: [
      {
        id: "qn_1",
        prompt: "Why does withRetry add jitter?",
        choices: [
          { value: "a", label: "To avoid synchronized retries" },
          { value: "b", label: "To make the delay shorter" },
        ],
      },
      { id: "qn_2", prompt: "What happens after the last retry?", choices: [{ value: "a", label: "It rethrows" }] },
    ],
  };

  it("waits for the explainer then formats the questions for reading out", async () => {
    const target = server({
      [`GET ${EXPLAINERS}/ex_1`]: [
        { body: { explainer: view({ status: "pending" }) } },
        { body: { explainer: view({ status: "ready" }) } },
      ],
      [`GET ${check}`]: { body: questions },
    });
    const text = textOf(await callTool(target, "check_understanding", { explainer_id: "ex_1" }));
    expect(text).toContain("1. [question_id: qn_1] Why does withRetry add jitter?");
    expect(text).toContain('- value "a": To avoid synchronized retries');
    expect(text).toContain('- value "b": To make the delay shorter');
    expect(text).toContain("2. [question_id: qn_2] What happens after the last retry?");
    expect(text).toContain("value null: I don't know");
  });

  it("returns pending when the explainer never finishes and an error when it failed", async () => {
    const pending = server({ [`GET ${EXPLAINERS}/ex_1`]: { body: { explainer: view({ status: "pending" }) } } });
    const waiting = await callTool(pending, "check_understanding", { explainer_id: "ex_1" });
    expect(waiting.isError).toBeUndefined();
    expect(textOf(waiting)).toContain("still generating");

    const failed = server({
      [`GET ${EXPLAINERS}/ex_1`]: { body: { explainer: view({ status: "failed", error: "Generation failed." }) } },
    });
    expect(await callTool(failed, "check_understanding", { explainer_id: "ex_1" })).toMatchObject({
      isError: true,
      content: [{ text: "Generation failed." }],
    });
  });

  it("posts answers in the contract shape and formats the graded result", async () => {
    const target = server({
      [`POST ${check}`]: {
        body: {
          correct: 1,
          total: 2,
          passed: false,
          passMark: 2,
          questions: [
            {
              id: "qn_1",
              prompt: "Why does withRetry add jitter?",
              correct: true,
              yourValue: "a",
              answerValue: "a",
              answerLabel: "To avoid synchronized retries",
              explanation: "Jitter spreads callers out.",
              concept: "retry jitter",
            },
            {
              id: "qn_2",
              prompt: "What happens after the last retry?",
              correct: false,
              yourValue: null,
              answerValue: "a",
              answerLabel: "It rethrows",
              explanation: "The last error is thrown.",
              concept: "error propagation",
            },
          ],
          missedConcepts: ["error propagation"],
          reviewItemsAdded: 1,
          quizPath: "/learn/quiz/q_1",
        },
      },
    });
    const result = await callTool(target, "check_understanding", {
      explainer_id: "ex_1",
      answers: [
        { question_id: "qn_1", value: "a" },
        { question_id: "qn_2", value: null },
      ],
    });
    expect(postBody(target.fetch)).toEqual({
      answers: [
        { questionId: "qn_1", value: "a" },
        { questionId: "qn_2", value: null },
      ],
    });
    const text = textOf(result);
    expect(text).toContain("Score: 1/2 (pass mark 2). Not passed.");
    expect(text).toContain("1. Correct: Why does withRetry add jitter?");
    expect(text).toContain("2. Missed: What happens after the last retry?");
    expect(text).toContain("Your answer: I don't know");
    expect(text).toContain("Right answer: It rethrows");
    expect(text).toContain("The last error is thrown.");
    expect(text).toContain("Missed concepts: error propagation");
    expect(text).toContain("Review items added to daily practice: 1");
  });

  it("rejects malformed answers before any request", async () => {
    const target = server();
    const result = await callTool(target, "check_understanding", {
      explainer_id: "ex_1",
      answers: [{ question_id: "qn_1" }],
    });
    expect(result.isError).toBe(true);
    expect(target.fetch).not.toHaveBeenCalled();
  });
});

describe("what_do_i_know", () => {
  it("groups concepts by level and appends the structured JSON", async () => {
    const known = {
      topic: "retries",
      concepts: [
        { term: "exponential backoff", level: "known", correct: 4, missed: 0 },
        { term: "retry jitter", level: "shaky", correct: 1, missed: 2 },
        { term: "idempotency keys", level: "unassessed", correct: 0, missed: 0 },
      ],
    };
    const target = server({ "GET /api/v1/understanding/known?topic=retries": { body: known } });
    const result = await callTool(target, "what_do_i_know", { topic: "retries" });
    expect(result.content).toHaveLength(2);
    expect(result.content[0].text).toContain("known: exponential backoff");
    expect(result.content[0].text).toContain("shaky: retry jitter");
    expect(result.content[0].text).toContain("unassessed: idempotency keys");
    expect(JSON.parse(result.content[1].text)).toEqual(known);
  });

  it("works without a topic and says none for empty levels", async () => {
    const target = server({ "GET /api/v1/understanding/known": { body: { topic: null, concepts: [] } } });
    const text = textOf(await callTool(target, "what_do_i_know"));
    expect(text).toContain("known: none");
    expect(text).toContain("shaky: none");
  });
});

describe("capture", () => {
  const key = "POST /api/v1/captures";

  it("posts only the fields given", async () => {
    const target = server({ [key]: { status: 201, body: { capture: { id: "c_1" } } } });
    const result = await callTool(target, "capture", { url: "https://example.com/post", title: "A post" });
    expect(postBody(target.fetch)).toEqual({ url: "https://example.com/post", title: "A post" });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Saved");
  });

  it("treats a 409 duplicate as already in the inbox, not an error", async () => {
    const target = server({ [key]: problem(409, "conflict", "Already captured.") });
    const result = await callTool(target, "capture", { url: "https://example.com/post" });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("already in your Polymath inbox");
  });

  it("needs text or a url, and surfaces a missing scope", async () => {
    expect((await callTool(server(), "capture", { title: "only a title" })).isError).toBe(true);
    const target = server({ [key]: problem(403, "forbidden", "This key needs captures:write.") });
    expect(await callTool(target, "capture", { text: "note" })).toMatchObject({
      isError: true,
      content: [{ text: "This key needs captures:write." }],
    });
  });
});

describe("understanding hook", () => {
  const preferences = (overrides: Record<string, unknown> = {}) => ({
    body: { autoSuggest: false, pushWarning: false, questionCount: 5, difficulty: "standard", ...overrides },
  });
  const input = (event: string, command: string) =>
    JSON.stringify({ hook_event_name: event, cwd: "/work/my-repo", tool_input: { command } });
  const bigCommit = " 4 files changed, 120 insertions(+), 40 deletions(-)\n";

  function runHook_(
    event: string,
    routes: Record<string, Reply | Reply[]>,
    execOverrides: Parameters<typeof fakeExec>[0] = {},
  ) {
    const fetch = fakeFetch(routes);
    return runHook({ input: input(event, "git"), env: ENV, fetch, exec: fakeExec(execOverrides) }).then(
      (output: string) => ({
        output,
        fetch,
      }),
    );
  }

  it("prints nothing after a commit when auto-suggest is off", async () => {
    const { output } = await runHook_(
      "PostToolUse",
      { "GET /api/v1/understanding/preferences": preferences() },
      { shortstat: bigCommit },
    );
    expect(output).toBe("");
  });

  it("asks Claude to suggest the explainer after a big commit when auto-suggest is on", async () => {
    const { output } = await runHook_(
      "PostToolUse",
      { "GET /api/v1/understanding/preferences": preferences({ autoSuggest: true }) },
      { shortstat: bigCommit },
    );
    const parsed = JSON.parse(output);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("160 lines");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("/polymath:explain");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("do not run it");
  });

  it("stays quiet after a small commit", async () => {
    const { output } = await runHook_(
      "PostToolUse",
      { "GET /api/v1/understanding/preferences": preferences({ autoSuggest: true }) },
      { shortstat: " 1 file changed, 10 insertions(+), 2 deletions(-)\n" },
    );
    expect(output).toBe("");
  });

  it("warns before a push when no explainer for HEAD passed, and never blocks", async () => {
    const { output, fetch } = await runHook_("PreToolUse", {
      "GET /api/v1/understanding/preferences": preferences({ pushWarning: true }),
      [`GET ${EXPLAINERS}?repo=acme%2Fapp&commit=${SHA}`]: { body: { explainers: [view({ passed: false })] } },
    });
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({ systemMessage: expect.stringContaining(SHA.slice(0, 7)) });
    expect(parsed.systemMessage).toContain("no passed understanding check");
    expect(output).not.toContain("permissionDecision");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("is quiet before a push when the check passed or the warning is off", async () => {
    const passed = await runHook_("PreToolUse", {
      "GET /api/v1/understanding/preferences": preferences({ pushWarning: true }),
      [`GET ${EXPLAINERS}?repo=acme%2Fapp&commit=${SHA}`]: {
        body: { explainers: [view({ passed: false }), view({ passed: true })] },
      },
    });
    expect(passed.output).toBe("");
    const off = await runHook_("PreToolUse", { "GET /api/v1/understanding/preferences": preferences() });
    expect(off.output).toBe("");
  });

  it("fails open and silent on server errors, bad input, and missing key", async () => {
    const down = await runHook_("PreToolUse", {
      "GET /api/v1/understanding/preferences": problem(500, "internal", "Boom"),
    });
    expect(down.output).toBe("");
    const unreachable = await runHook({
      input: input("PreToolUse", "git push"),
      env: ENV,
      fetch: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
      exec: fakeExec(),
    });
    expect(unreachable).toBe("");
    expect(await runHook({ input: "not json", env: ENV, fetch: fakeFetch({}), exec: fakeExec() })).toBe("");
    const keyless = fakeFetch({});
    expect(await runHook({ input: input("PreToolUse", "git push"), env: {}, fetch: keyless, exec: fakeExec() })).toBe(
      "",
    );
    expect(keyless).not.toHaveBeenCalled();
  });

  it("reads the plugin option variables Claude Code sets", async () => {
    const fetch = fakeFetch({ "GET /api/v1/understanding/preferences": preferences() });
    await runHook({
      input: input("PreToolUse", "git push"),
      env: { CLAUDE_PLUGIN_OPTION_POLYMATH_URL: "http://opt.test", CLAUDE_PLUGIN_OPTION_API_KEY: "axm_opt" },
      fetch,
      exec: fakeExec(),
    });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("http://opt.test/api/v1/understanding/preferences");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer axm_opt");
  });

  it("exits 0 with empty output as a real process when Polymath is unreachable", () => {
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: input("PreToolUse", "git push origin main"),
      env: { ...process.env, POLYMATH_URL: "http://127.0.0.1:9", POLYMATH_API_KEY: "axm_test_key" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });
});
