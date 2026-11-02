import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCodexSession, stripInjectedBlocks, threadIdFromFileName } from "@/lib/agent-artifacts/codex";
import { REDACTED } from "@/lib/agent-artifacts/redact";

/*
 * Golden fixtures for the Codex reader: one main rollout and one resume
 * rollout for the same thread (art_GNwwKckZ §3). The cases the reader rules
 * exist for — cross-file replay, call_id pairing across an interleaved call,
 * injected blocks and the request prefix, cached-inside-input usage, an
 * encrypted inter-agent payload, and the token_count fallback that must lose
 * to token_usage_record — are each pinned by one assertion below.
 */

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL("../fixtures/agent-artifacts/codex/" + name, import.meta.url)), "utf8");
}

const MAIN = "rollout-2026-11-01T09-00-00-11111111-2222-3333-4444-555555555555.jsonl";
const RESUME = "rollout-2026-11-01T09-05-00-11111111-2222-3333-4444-555555555555.jsonl";

describe("Codex rollout parser", () => {
  const { summary, stats } = parseCodexSession([
    { fileName: MAIN, text: fixture(MAIN) },
    { fileName: RESUME, text: fixture(RESUME) },
  ]);

  it("identifies the session from session_meta, not the filename alone", () => {
    expect(summary.source).toBe("codex");
    expect(summary.externalSessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(summary.cwd).toBe("/home/pino/Polymath");
    expect(summary.startedAt).toBe("2026-11-01T09:00:00.000Z");
    expect(summary.lastActivityAt).toBe("2026-11-01T09:07:30.000Z");
  });

  it("strips injected blocks and the request prefix, and dedupes the cross-file replay", () => {
    expect(summary.humanPrompts).toHaveLength(2);
    expect(summary.humanPrompts[0]?.text).toBe(`Ship the parser, skip the docs. Staging key ${REDACTED}`);
    expect(summary.humanPrompts[1]?.text).toBe("Also fix the retry loop");
  });

  it("pairs calls to outputs by call_id, never by arrival order", () => {
    // call-1's output arrived while call-2 was still pending; each command
    // must get its own verdict from its own output.
    expect(summary.commandsRun).toEqual([
      { cmd: "npm test -- login", ok: false },
      { cmd: "git status", ok: true },
      { cmd: "apply_patch src/retry.ts", ok: true },
    ]);
    expect(summary.filesTouched).toEqual([{ path: "src/retry.ts", op: "edit" }]);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.kind).toBe("command");
    expect(summary.failures[0]?.detail).toContain("npm ERR!");
  });

  it("takes usage from token_usage_record with cached-inside-input semantics", () => {
    // cached_input_tokens (200) is inside input_tokens (500) — never added.
    // The token_count event's 9999 running total must lose to the records.
    expect(summary.usage).toEqual({ inputTokens: 500, outputTokens: 300 });
  });

  it("keeps counters honest across the two files", () => {
    expect(stats.skippedRecords).toBe(0);
    // The resume replays the session_meta line and the first user prompt;
    // both dedupe on line identity. The replayed token_usage_record carries a
    // different payload for the same resp-1, so it is blocked by the
    // response_id dedupe instead — usage must not double-count either way.
    expect(stats.dedupedRecords).toBe(2);
  });

  it("stores no credential-shaped value anywhere in the summary", () => {
    const json = JSON.stringify(summary);
    expect(json).not.toContain("sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
    expect(json).not.toContain("sk-abc123def4567890");
    expect(json).not.toContain("gAAAAA-totally-encrypted-inter-agent-blob");
    expect(summary.humanPrompts[0]?.text).toContain(REDACTED);
  });

  it("ignores an output whose call never arrived", () => {
    const orphan =
      '{"timestamp":"2026-11-01T09:00:00.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"ghost","output":"{\\"metadata\\":{\\"exit_code\\":1}}"}}';
    const { summary: orphanSummary } = parseCodexSession([{ fileName: MAIN, text: orphan }]);
    expect(orphanSummary.commandsRun).toEqual([]);
    expect(orphanSummary.failures).toEqual([]);
  });

  it("records a call whose output never arrived as ok", () => {
    const callOnly =
      '{"timestamp":"2026-11-01T09:00:00.000Z","type":"response_item","payload":{"type":"function_call","call_id":"call-9","name":"shell","arguments":"{\\"command\\":[\\"ls\\"]}"}}';
    const { summary: callSummary } = parseCodexSession([{ fileName: MAIN, text: callOnly }]);
    expect(callSummary.commandsRun).toEqual([{ cmd: "ls", ok: true }]);
  });
});

describe("stripInjectedBlocks", () => {
  it("removes every official tag family", () => {
    const text = "<user_instructions>rules</user_instructions><environment_context>env</environment_context>real ask";
    expect(stripInjectedBlocks(text)).toBe("real ask");
  });

  it("treats an unclosed tag as injected to the end", () => {
    expect(stripInjectedBlocks("<skills_instructions>never closed real ask")).toBe("");
  });

  it("strips the request prefix case-insensitively", () => {
    expect(stripInjectedBlocks("## my request for codex: do the thing")).toBe("do the thing");
    expect(stripInjectedBlocks("## My request for Codex:\ndo the thing")).toBe("do the thing");
  });

  it("leaves ordinary text alone", () => {
    expect(stripInjectedBlocks("just fix the bug")).toBe("just fix the bug");
  });
});

describe("threadIdFromFileName", () => {
  it("reads the thread id from rollout filenames", () => {
    expect(threadIdFromFileName(MAIN)).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("reads the conversation id from revert filenames", () => {
    expect(
      threadIdFromFileName("rollout-2026-11-01T09-00-00-11111111-2222-3333-4444-555555555555_ab12cd34.jsonl"),
    ).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("returns undefined for non-rollout names", () => {
    expect(threadIdFromFileName("history.jsonl")).toBeUndefined();
  });
});
