/*
 * Local agent-artifact scanner: the guard and discovery layer that feeds the
 * parsers. Reads the user's own ~/.claude and ~/.codex folders with their own
 * file permissions — nothing is sent anywhere, no model is called.
 *
 * The guard adapts the skills importer's (src/domains/skills/sources/local.ts,
 * ASH-200) with one deliberate flip: there the allowed root is a ceiling and
 * the user path is the suspect; here the root IS the target, so the guard's
 * job is realpath on the roots, an lstat walk that never follows symlinks,
 * and per-scan caps. The skills' 200-file / 5 MiB budgets are one-package
 * budgets; a heavy user has hundreds of transcripts inside a 30-day default
 * retention window, so these caps are the stated defaults:
 *   - maxSessionFiles: 500 session files per scan
 *   - maxFileBytes: 64 MiB per transcript
 *   - maxTotalBytes: 512 MiB of transcript bytes per scan
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseClaudeCodeTranscript } from "./claude-code";
import { parseCodexSession, readCodexSessionMeta, threadIdFromFileName, type CodexRolloutFile } from "./codex";
import type { AgentSource, ParsedSession, ScanErrorKind } from "./types";

export type AgentArtifactRoots = { "claude-code": string; codex: string };

/** Per-scan caps, stated in the re-spec review; overridable for tests. */
export type ScanLimits = {
  /** Session files processed per scan, across both sources. */
  maxSessionFiles: number;
  /** Per-transcript byte ceiling; larger files are skipped, not truncated. */
  maxFileBytes: number;
  /** Tree-wide transcript-byte budget per scan. */
  maxTotalBytes: number;
};

export const SCAN_LIMITS: ScanLimits = {
  maxSessionFiles: 500,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
};

/**
 * Roots default to the agents' own homes; the agents' own relocation env vars
 * are respected so a relocated install keeps working. Polymath's override
 * (POLYMATH_AGENT_ARTIFACT_ROOTS, "claude-code=...;codex=...") exists for
 * tests and sandboxes pointing at fixture folders.
 */
export function defaultRoots(): AgentArtifactRoots {
  const override = process.env.POLYMATH_AGENT_ARTIFACT_ROOTS;
  const home = homedir();
  const roots: AgentArtifactRoots = {
    "claude-code": process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"),
    codex: process.env.CODEX_HOME ?? path.join(home, ".codex"),
  };
  if (override === undefined || override.trim() === "") return roots;
  for (const part of override.split(";")) {
    const [name, value] = part.split("=", 2);
    if (name === "claude-code" && value !== undefined && value !== "") roots["claude-code"] = value;
    if (name === "codex" && value !== undefined && value !== "") roots.codex = value;
  }
  return roots;
}

export type SkippedFile = {
  source: AgentSource;
  path: string;
  kind: ScanErrorKind;
  reason: string;
};

export type UnavailableSource = {
  source: AgentSource;
  kind: ScanErrorKind;
  message: string;
};

export type SessionRecord = {
  source: AgentSource;
  /** Raw transcript bytes, as received — stored deduped, never rendered. */
  raw: string;
  rawSha256: string;
  parsed: ParsedSession;
};

export type ScanOutput = {
  records: SessionRecord[];
  skipped: SkippedFile[];
  unavailable: UnavailableSource[];
};

type Budget = { bytes: number; files: number };

type FoundFile = { source: AgentSource; path: string; fileName: string; bytes: number };

/** Orphaned/superseded siblings are set-aside transcripts, not live session files. */
function isLiveClaudeTranscript(fileName: string): boolean {
  if (!fileName.endsWith(".jsonl")) return false;
  return !(fileName.includes(".orphaned-") || fileName.includes(".jsonl.superseded-"));
}

function overBudget(budget: Budget, size: number, limits: ScanLimits): boolean {
  return budget.files + 1 > limits.maxSessionFiles || budget.bytes + size > limits.maxTotalBytes;
}

async function listClaudeTranscripts(
  root: string,
  budget: Budget,
  limits: ScanLimits,
  skipped: SkippedFile[],
): Promise<FoundFile[]> {
  const projectsDir = path.join(root, "projects");
  const found: FoundFile[] = [];
  let entries;
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    skipped.push({ source: "claude-code", path: projectsDir, kind: "unreadable", reason: describe(error) });
    return found;
  }
  for (const slugDir of entries) {
    // lstat-based dirent checks: a symlinked slug directory is skipped, never followed.
    if (slugDir.isSymbolicLink() || !slugDir.isDirectory()) continue;
    const dirPath = path.join(projectsDir, slugDir.name);
    let files;
    try {
      files = await readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      skipped.push({ source: "claude-code", path: dirPath, kind: "unreadable", reason: describe(error) });
      continue;
    }
    for (const file of files) {
      if (file.isSymbolicLink() || !file.isFile()) continue;
      if (!isLiveClaudeTranscript(file.name)) continue;
      const filePath = path.join(dirPath, file.name);
      const size = await sizeOf(filePath);
      if (size === undefined) {
        skipped.push({ source: "claude-code", path: filePath, kind: "unreadable", reason: "stat failed" });
        continue;
      }
      if (size > limits.maxFileBytes) {
        skipped.push({
          source: "claude-code",
          path: filePath,
          kind: "too_large",
          reason: `${size} bytes over per-file cap`,
        });
        continue;
      }
      if (overBudget(budget, size, limits)) {
        skipped.push({ source: "claude-code", path: filePath, kind: "too_large", reason: "scan cap reached" });
        continue;
      }
      budget.files += 1;
      budget.bytes += size;
      found.push({ source: "claude-code", path: filePath, fileName: file.name, bytes: size });
    }
  }
  return found;
}

/** Walk sessions/YYYY/MM/DD — exactly the documented layout, links never followed. */
async function listCodexRollouts(
  root: string,
  budget: Budget,
  limits: ScanLimits,
  skipped: SkippedFile[],
): Promise<FoundFile[]> {
  const sessionsDir = path.join(root, "sessions");
  const found: FoundFile[] = [];
  let years;
  try {
    years = await readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    skipped.push({ source: "codex", path: sessionsDir, kind: "unreadable", reason: describe(error) });
    return found;
  }
  for (const year of years) {
    if (year.isSymbolicLink() || !year.isDirectory()) continue;
    for (const month of await safeListDirs(path.join(sessionsDir, year.name), skipped)) {
      for (const day of await safeListDirs(path.join(sessionsDir, year.name, month), skipped)) {
        let files;
        try {
          files = await readdir(path.join(sessionsDir, year.name, month, day), { withFileTypes: true });
        } catch (error) {
          skipped.push({
            source: "codex",
            path: path.join(sessionsDir, year.name, month, day),
            kind: "unreadable",
            reason: describe(error),
          });
          continue;
        }
        for (const file of files) {
          if (file.isSymbolicLink() || !file.isFile()) continue;
          if (!file.name.startsWith("rollout-") || !file.name.endsWith(".jsonl")) continue;
          const filePath = path.join(sessionsDir, year.name, month, day, file.name);
          const size = await sizeOf(filePath);
          if (size === undefined) {
            skipped.push({ source: "codex", path: filePath, kind: "unreadable", reason: "stat failed" });
            continue;
          }
          if (size > limits.maxFileBytes) {
            skipped.push({
              source: "codex",
              path: filePath,
              kind: "too_large",
              reason: `${size} bytes over per-file cap`,
            });
            continue;
          }
          if (overBudget(budget, size, limits)) {
            skipped.push({ source: "codex", path: filePath, kind: "too_large", reason: "scan cap reached" });
            continue;
          }
          budget.files += 1;
          budget.bytes += size;
          found.push({ source: "codex", path: filePath, fileName: file.name, bytes: size });
        }
      }
    }
  }
  return found;
}

async function safeListDirs(dir: string, skipped: SkippedFile[]): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => !entry.isSymbolicLink() && entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    skipped.push({ source: "codex", path: dir, kind: "unreadable", reason: describe(error) });
    return [];
  }
}

async function sizeOf(filePath: string): Promise<number | undefined> {
  try {
    const stats = await lstat(filePath);
    return stats.size;
  } catch {
    return undefined;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export type CollectOptions = {
  roots?: Partial<AgentArtifactRoots>;
  limits?: Partial<ScanLimits>;
};

/**
 * Resolve, guard, discover, group, and parse. Missing or unreadable roots are
 * reported per source in `unavailable` — one agent not being installed must
 * not hide the other one's sessions.
 */
export async function collectSessionRecords(options: CollectOptions = {}): Promise<ScanOutput> {
  const limits: ScanLimits = { ...SCAN_LIMITS, ...options.limits };
  const configured = { ...defaultRoots(), ...options.roots };
  const skipped: SkippedFile[] = [];
  const unavailable: UnavailableSource[] = [];
  const resolved = new Map<AgentSource, string>();

  for (const source of ["claude-code", "codex"] as const) {
    const requested = configured[source];
    try {
      resolved.set(source, await realpath(requested));
    } catch {
      unavailable.push({ source, kind: "not_found", message: `${requested} does not exist` });
    }
  }

  const budget: Budget = { bytes: 0, files: 0 };
  const claudeRoot = resolved.get("claude-code");
  const codexRoot = resolved.get("codex");

  const [claudeFiles, codexFiles] = await Promise.all([
    claudeRoot ? listClaudeTranscripts(claudeRoot, budget, limits, skipped) : Promise.resolve<FoundFile[]>([]),
    codexRoot ? listCodexRollouts(codexRoot, budget, limits, skipped) : Promise.resolve<FoundFile[]>([]),
  ]);

  const claudeRecords = await readClaudeSessions(claudeFiles, skipped);
  const codexRecords = await groupAndParseCodex(codexRoot ?? "", codexFiles, skipped);

  const records = [...claudeRecords, ...codexRecords];
  records.sort((a, b) =>
    a.source === b.source
      ? a.parsed.summary.externalSessionId < b.parsed.summary.externalSessionId
        ? -1
        : 1
      : a.source < b.source
        ? -1
        : 1,
  );
  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { records, skipped, unavailable };
}

async function readClaudeSessions(files: FoundFile[], skipped: SkippedFile[]): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];
  for (const file of files) {
    try {
      const raw = await readFile(file.path, "utf8");
      // The filename stem is the fallback session id; records carry their own.
      const sessionId = path.basename(file.fileName, ".jsonl");
      const parsed = parseClaudeCodeTranscript(raw, sessionId);
      records.push({ source: "claude-code", raw, rawSha256: sha256(raw), parsed });
    } catch (error) {
      skipped.push({ source: "claude-code", path: file.path, kind: "unreadable", reason: describe(error) });
    }
  }
  return records;
}

/**
 * Group rollout files by session (resume replays across files) BEFORE parsing,
 * then skip non-user rollouts: sub-agent threads and Codex-internal bookkeeping
 * (cwd inside the codex root) never become session rows.
 */
async function groupAndParseCodex(root: string, files: FoundFile[], skipped: SkippedFile[]): Promise<SessionRecord[]> {
  const byThread = new Map<string, CodexRolloutFile[]>();
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file.path, "utf8");
    } catch (error) {
      skipped.push({ source: "codex", path: file.path, kind: "unreadable", reason: describe(error) });
      continue;
    }
    const meta = readCodexSessionMeta(text);
    const threadId = meta.threadId ?? threadIdFromFileName(file.fileName);
    if (threadId === undefined) {
      skipped.push({
        source: "codex",
        path: file.path,
        kind: "unreadable",
        reason: "no session id in meta or filename",
      });
      continue;
    }
    if (meta.parentThreadId !== undefined) {
      skipped.push({
        source: "codex",
        path: file.path,
        kind: "unsafe_path",
        reason: "sub-agent rollout (parent_thread_id set)",
      });
      continue;
    }
    if (meta.cwd !== undefined && isInside(meta.cwd, root)) {
      skipped.push({
        source: "codex",
        path: file.path,
        kind: "unsafe_path",
        reason: "codex-internal bookkeeping rollout",
      });
      continue;
    }
    const group = byThread.get(threadId) ?? [];
    group.push({ fileName: file.fileName, text });
    byThread.set(threadId, group);
  }

  const records: SessionRecord[] = [];
  for (const [threadId, group] of byThread) {
    const parsed = parseCodexSession(group);
    const raw = group.map((file) => file.text).join("\n");
    if (isUnreadable(parsed, group)) {
      skipped.push({
        source: "codex",
        path: threadId,
        kind: "unreadable",
        reason: "no lines decoded (compressed or corrupt rollout)",
      });
      continue;
    }
    records.push({ source: "codex", raw, rawSha256: sha256(raw), parsed });
  }
  return records;
}

/** A group where nothing decoded and nothing was extracted is not a usable session. */
function isUnreadable(parsed: ParsedSession, files: CodexRolloutFile[]): boolean {
  const summary = parsed.summary;
  return (
    parsed.stats.records === 0 &&
    parsed.stats.skippedRecords > 0 &&
    summary.cwd === "" &&
    summary.humanPrompts.length === 0 &&
    summary.commandsRun.length === 0 &&
    files.length > 0
  );
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
