import { readdirSync } from "node:fs";
import path from "node:path";
import { gitHubIssues, type GitHubIssues } from "./github";
import { claimSignalsToFile, markSignalFiled, releaseSignal } from "./store";
import { draftIssue, filesForRoute, triageSignal } from "./triage";

/*
 * One filing pass, run by the outbox worker: lease what fits under today's
 * cap, triage it, file one GitHub issue per fingerprint, record the number.
 *
 * Off unless BUG_AGENT_ENABLED=true and a token and repository are set: the
 * env flag is the kill switch. Sightings are still recorded while it is off,
 * so turning it back on files the backlog, most-seen first, at the daily cap.
 */

export type BugAgentConfig = { token: string; repo: string; maxIssuesPerDay: number };

const DEFAULT_MAX_ISSUES_PER_DAY = 5;

export function bugAgentConfig(env: Record<string, string | undefined> = process.env): BugAgentConfig | null {
  if (env.BUG_AGENT_ENABLED !== "true") return null;
  const token = env.BUG_AGENT_GITHUB_TOKEN;
  const repo = env.BUG_AGENT_REPO;
  if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const cap = Number(env.BUG_AGENT_MAX_ISSUES_PER_DAY ?? DEFAULT_MAX_ISSUES_PER_DAY);
  return { token, repo, maxIssuesPerDay: Number.isInteger(cap) && cap >= 0 ? cap : DEFAULT_MAX_ISSUES_PER_DAY };
}

export type BugTriagePassResult = { filed: number; failed: number };

export async function runBugTriagePass(input: {
  config: BugAgentConfig;
  github?: GitHubIssues;
  appPages?: string[];
  now?: Date;
}): Promise<BugTriagePassResult> {
  const github = input.github ?? gitHubIssues({ token: input.config.token, repo: input.config.repo });
  const claimed = await claimSignalsToFile(input.config.maxIssuesPerDay, input.now);
  if (claimed.length === 0) return { filed: 0, failed: 0 };
  const pages = input.appPages ?? listAppPages();

  let filed = 0;
  let failed = 0;
  for (const row of claimed) {
    try {
      // A worker that died after GitHub accepted the issue but before the
      // number was stored would otherwise file it twice.
      const existing = await github.findByFingerprint(row.signal.fingerprint);
      if (existing !== null) {
        await markSignalFiled(row.id, existing, input.now);
        continue;
      }
      const triage = triageSignal(row.signal, {
        occurrences: row.occurrences,
        routeFiles: filesForRoute(row.signal.route, pages),
      });
      const similar = await github.findSimilar(triage.area);
      const issue = draftIssue(row.signal, triage, {
        occurrences: row.occurrences,
        firstSeenAt: row.firstSeenAt,
        similar,
      });
      const number = await github.create(issue);
      await markSignalFiled(row.id, number, input.now);
      filed += 1;
    } catch (cause) {
      failed += 1;
      await releaseSignal(row.id, cause instanceof Error ? cause.message : String(cause), input.now);
    }
  }
  return { filed, failed };
}

/** Repo-relative `page.tsx` paths under `src/app`, for route-to-file triage. */
function listAppPages(root = process.cwd()): string[] {
  try {
    return readdirSync(path.join(root, "src/app"), { recursive: true, encoding: "utf8" })
      .filter((file) => /(^|\/)page\.tsx$/.test(file))
      .map((file) => `src/app/${file.split(path.sep).join("/")}`);
  } catch {
    return [];
  }
}
