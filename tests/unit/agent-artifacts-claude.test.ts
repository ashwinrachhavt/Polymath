import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseClaudeCodeTranscript } from "@/lib/agent-artifacts/claude-code";
import { REDACTED } from "@/lib/agent-artifacts/redact";

/*
 * Golden fixture for the Claude Code reader. The fixture hand-authors the
 * documented transcript shape (art_GNwwKckZ §2-§3) with the cases the reader
 * rules exist for: resume replay, machine-injected user records, a tool
 * result that read a .env value, and a truncated line. What each assertion
 * protects is named inline; the fixtures are synthetic, so passing here is
 * not real-machine evidence (the re-spec's manual smoke covers that).
 */

const fixtureText = readFileSync(
  fileURLToPath(new URL("../fixtures/agent-artifacts/claude-code/session-with-replay.jsonl", import.meta.url)),
  "utf8",
);

describe("Claude Code transcript parser", () => {
  const { summary, stats } = parseClaudeCodeTranscript(fixtureText);

  it("derives identity from records, never from the slug", () => {
    expect(summary.source).toBe("claude-code");
    expect(summary.externalSessionId).toBe("sess-111");
    // The fixture's slug directory cannot round-trip; cwd must come from the
    // records. (The scanner-level test proves the slug is never decoded.)
    expect(summary.cwd).toBe("/home/pino/Polymath");
    expect(summary.startedAt).toBe("2026-11-01T10:00:00.000Z");
    expect(summary.lastActivityAt).toBe("2026-11-01T11:00:01.000Z");
    expect(summary.aiTitle).toBe("Fix flaky login");
  });

  it("keeps exactly one human prompt when a resume replays it with a new promptId", () => {
    expect(summary.humanPrompts).toHaveLength(1);
    const prompt = summary.humanPrompts[0];
    expect(prompt?.text).toContain("Fix the flaky login test");
    expect(prompt?.at).toBe("2026-11-01T10:00:00.000Z");
  });

  it("excludes isMeta records, attachments, and tool results from the prompts", () => {
    const joined = summary.humanPrompts.map((p) => p.text).join("\n");
    expect(joined).not.toContain("Caveat");
    expect(joined).not.toContain("Edit applied");
    expect(joined).not.toContain("notes.md");
  });

  it("pairs tool calls to their own results and classifies touches", () => {
    expect(summary.commandsRun).toEqual([{ cmd: "npm test -- login", ok: false }]);
    expect(summary.filesTouched).toEqual([{ path: "/home/pino/Polymath/src/login.ts", op: "edit" }]);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.kind).toBe("tool_result");
    expect(summary.failures[0]?.detail).toContain("FAIL login.test.ts");
  });

  it("counts usage once per message.id, not per replayed record", () => {
    // msg_1 (100/50) plus msg_2 (200/80) counted once each — the replayed
    // a-0002 copy repeats msg_2's usage verbatim.
    expect(summary.usage).toEqual({ inputTokens: 300, outputTokens: 130 });
  });

  it("counts a malformed line as skipped and keeps parsing", () => {
    expect(stats.skippedRecords).toBe(1);
    expect(stats.dedupedRecords).toBe(2);
    expect(stats.records).toBe(12);
  });

  it("lets an explicit fallback session id win over the records", () => {
    const { summary: withFallback } = parseClaudeCodeTranscript(fixtureText, "from-filename");
    expect(withFallback.externalSessionId).toBe("from-filename");
  });

  it("stores no credential-shaped value anywhere in the summary", () => {
    const json = JSON.stringify(summary);
    expect(json).not.toContain("sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456");
    expect(json).not.toContain("hunter2secret");
    expect(json).not.toContain("sk-abc123def4567890");
    expect(summary.humanPrompts[0]?.text).toContain(REDACTED);
  });
});
