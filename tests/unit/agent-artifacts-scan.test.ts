import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectSessionRecords, defaultRoots } from "@/lib/agent-artifacts/scan";

/*
 * Scanner-level behavior, on trees built in a tmpdir so symlinks and
 * set-aside siblings are real. The slug trap below is the point of the
 * "never decode the slug" rule: the directory name embeds the project path
 * plus a decoy suffix that any decoding would carry into the summary, while
 * the true cwd rides on the records.
 */

const CLAUDE_TWO_LINES = [
  '{"type":"user","uuid":"u-1","sessionId":"sess-scan","cwd":"/home/pino/Polymath","timestamp":"2026-11-01T10:00:00.000Z","message":{"role":"user","content":"Fix the flaky login test"}}',
  '{"type":"assistant","uuid":"a-1","sessionId":"sess-scan","cwd":"/home/pino/Polymath","timestamp":"2026-11-01T10:01:00.000Z","message":{"id":"m-1","role":"assistant","content":[{"type":"text","text":"On it"}]}}',
  "",
].join("\n");

function writeClaudeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "aa-claude-"));
  const slugDir = join(root, "projects", "-home-pino-Polymath-DECOY1a2b");
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(join(slugDir, "11111111-2222-3333-4444-555555555555.jsonl"), CLAUDE_TWO_LINES);
  // Set-aside siblings of the live transcript: not sessions, never parsed.
  writeFileSync(join(slugDir, "11111111-2222-3333-4444-555555555555.orphaned-20261102T000000.jsonl"), CLAUDE_TWO_LINES);
  writeFileSync(
    join(slugDir, "11111111-2222-3333-4444-555555555555.jsonl.superseded-20261102T000000"),
    CLAUDE_TWO_LINES,
  );
  // A symlink that would point outside any allowlist: never followed.
  symlinkSync("/etc/passwd", join(slugDir, "evil.jsonl"));
  return root;
}

function writeCodexTree(): string {
  const root = mkdtempSync(join(tmpdir(), "aa-codex-"));
  const day = join(root, "sessions", "2026", "11", "01");
  mkdirSync(day, { recursive: true });
  writeFileSync(
    join(day, "rollout-2026-11-01T09-00-00-11111111-2222-3333-4444-555555555555.jsonl"),
    [
      '{"timestamp":"2026-11-01T09:00:00.000Z","type":"session_meta","payload":{"id":"11111111-2222-3333-4444-555555555555","cwd":"/home/pino/Polymath"}}',
      '{"timestamp":"2026-11-01T09:00:05.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Ship the parser"}]}}',
      "",
    ].join("\n"),
  );
  const laterDay = join(root, "sessions", "2026", "11", "02");
  mkdirSync(laterDay, { recursive: true });
  // Sub-agent thread: its own rollout, parent_thread_id names the parent.
  writeFileSync(
    join(laterDay, "rollout-2026-11-02T09-00-00-99999999-2222-3333-4444-555555555555.jsonl"),
    '{"timestamp":"2026-11-02T09:00:00.000Z","type":"session_meta","payload":{"id":"99999999-2222-3333-4444-555555555555","session_id":"child-1","cwd":"/home/pino/Polymath","parent_thread_id":"11111111-2222-3333-4444-555555555555"}}\n',
  );
  // Codex-internal bookkeeping: cwd inside the codex root itself.
  writeFileSync(
    join(laterDay, "rollout-2026-11-02T09-30-00-88888888-2222-3333-4444-555555555555.jsonl"),
    '{"timestamp":"2026-11-02T09:30:00.000Z","type":"session_meta","payload":{"id":"88888888-2222-3333-4444-555555555555","cwd":"' +
      root +
      '"}}\n',
  );
  return root;
}

const savedEnv: Record<string, string | undefined> = {};

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
});

function stashEnv(key: string): void {
  savedEnv[key] = process.env[key];
}

describe("agent-artifact scanner", () => {
  it("matches projects by record cwd, never by decoding the slug", async () => {
    const claudeRoot = writeClaudeTree();
    const scan = await collectSessionRecords({
      roots: { "claude-code": claudeRoot, codex: join(tmpdir(), "aa-missing-codex") },
    });
    expect(scan.unavailable).toEqual([
      { source: "codex", kind: "not_found", message: expect.stringContaining("does not exist") },
    ]);
    // The orphaned and superseded siblings are set-asides; only the live
    // transcript is a session.
    expect(scan.records).toHaveLength(1);
    const summary = scan.records[0]?.parsed.summary;
    expect(summary?.cwd).toBe("/home/pino/Polymath");
    expect(JSON.stringify(summary)).not.toContain("DECOY1a2b");
    expect(scan.skipped.map((s) => s.path)).toEqual(expect.arrayContaining([expect.stringContaining("evil.jsonl")]));
  });

  it("skips sub-agent and codex-internal rollouts with reasons", async () => {
    const codexRoot = writeCodexTree();
    const scan = await collectSessionRecords({
      roots: { "claude-code": join(tmpdir(), "aa-missing-claude"), codex: codexRoot },
    });
    expect(scan.unavailable).toEqual([
      { source: "claude-code", kind: "not_found", message: expect.stringContaining("does not exist") },
    ]);
    expect(scan.records).toHaveLength(1);
    expect(scan.records[0]?.source).toBe("codex");
    const reasons = scan.skipped.map((s) => s.reason);
    expect(reasons).toContain("sub-agent rollout (parent_thread_id set)");
    expect(reasons).toContain("codex-internal bookkeeping rollout");
  });

  it("stops at the session-file cap and says so", async () => {
    const claudeRoot = writeClaudeTree();
    const slugDir = join(claudeRoot, "projects", "-home-pino-Polymath-DECOY1a2b");
    writeFileSync(join(slugDir, "22222222-2222-3333-4444-555555555555.jsonl"), CLAUDE_TWO_LINES);
    const scan = await collectSessionRecords({
      roots: { "claude-code": claudeRoot, codex: join(tmpdir(), "aa-missing-codex") },
      limits: { maxSessionFiles: 1 },
    });
    expect(scan.records).toHaveLength(1);
    expect(scan.skipped.filter((s) => s.reason === "scan cap reached")).toHaveLength(1);
  });

  it("honours the agents' own relocation vars and the Polymath override", () => {
    stashEnv("POLYMATH_AGENT_ARTIFACT_ROOTS");
    stashEnv("CLAUDE_CONFIG_DIR");
    stashEnv("CODEX_HOME");
    process.env.CLAUDE_CONFIG_DIR = "/tmp/ccdir";
    process.env.CODEX_HOME = "/tmp/cxhome";
    expect(defaultRoots()).toEqual({ "claude-code": "/tmp/ccdir", codex: "/tmp/cxhome" });
    process.env.POLYMATH_AGENT_ARTIFACT_ROOTS = "claude-code=/tmp/over-claude;codex=/tmp/over-codex";
    expect(defaultRoots()).toEqual({ "claude-code": "/tmp/over-claude", codex: "/tmp/over-codex" });
  });
});
