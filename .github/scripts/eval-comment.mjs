/*
 * Post the eval report as a PR comment, replacing the previous one.
 *
 * Why a comment and not only the job summary: the summary lives on the run
 * page, one click past the PR; the eval verdict is the thing a reviewer most
 * needs before reading a diff. This script renders the same table the job
 * summary shows and posts it as a comment tagged with a marker, deleting any
 * earlier marker comment first — replace, never stack, so a PR carries one
 * live results thread however many CI runs post to it.
 *
 * The gate stays the eval step's exit code. A failed post here must not mask
 * a failing eval run, so this script reports its own failure through its exit
 * code, and the workflow step runs under `always()` so the comment posts even
 * when the eval step failed — that is exactly when the table matters most.
 *
 * Usage: node .github/scripts/eval-comment.mjs <report.json> <repo> <pr-number>
 */

import { readFileSync } from "node:fs";

const [path, repo, prNumberArg] = process.argv.slice(2);
if (!path || !repo || !prNumberArg) {
  console.error("usage: eval-comment.mjs <report.json> <repo> <pr-number>");
  process.exit(2);
}
const prNumber = Number(prNumberArg);
if (!Number.isInteger(prNumber) || prNumber <= 0) {
  console.error(`invalid PR number: ${prNumberArg}`);
  process.exit(2);
}

const MARKER = "<polymath-eval-results>";

function readReport(file) {
  const raw = readFileSync(file, "utf8");
  const start = raw.lastIndexOf('\n{\n  "target"');
  const candidates = start >= 0 ? [raw.slice(start)] : [];
  candidates.push(raw);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && Array.isArray(parsed.results)) return parsed;
    } catch {
      // Try the next shape.
    }
  }
  return null;
}

const PASS_STATUSES = new Set(["passed", "pass", "completed"]);

function verdictOf(result) {
  const verdict = result.verdict;
  if (typeof verdict === "string") return verdict;
  if (verdict && typeof verdict === "object" && typeof verdict.status === "string") return verdict.status;
  const nested = result.result?.status;
  return typeof nested === "string" ? nested : "unknown";
}

const report = readReport(path);
if (!report) {
  console.error("Could not read the eval report; not posting a comment.");
  process.exit(1);
}

const rows = report.results.map((result) => {
  const assertions = result.assertions ?? [];
  const failed = assertions.filter((assertion) => !assertion.passed);
  const status = verdictOf(result).toLowerCase();
  const passed = PASS_STATUSES.has(status) && failed.length === 0;
  const firstFailure = failed[0]?.name ?? result.error ?? (passed ? "" : `status ${status}`);
  return {
    id: result.id,
    passed,
    gates: `${assertions.length - failed.length}/${assertions.length}`,
    detail: String(firstFailure).replaceAll("|", "\\|").slice(0, 90),
  };
});

const total = rows.length;
const failedCount = rows.filter((row) => !row.passed).length;
const icon = failedCount === 0 ? "✅" : "❌";

const body = [
  MARKER,
  `## ${icon} Agent evals: ${total - failedCount}/${total} passed`,
  "",
  "| Eval | Result | Gates | First failure |",
  "| --- | --- | --- | --- |",
  ...rows.map((row) => `| \`${row.id}\` | ${row.passed ? "pass" : "**fail**"} | ${row.gates} | ${row.detail || "—"} |`),
  "",
  `_CI eval run on ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z; comment replaced, not stacked._`,
].join("\n");

async function gh(pathname, init = {}) {
  const base = `https://api.github.com/repos/${repo}`;
  const response = await fetch(base + pathname, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status} on ${pathname}: ${detail.slice(0, 300)}`);
  }
  return response.json();
}

const comments = await gh(`/issues/${prNumber}/comments?per_page=100`);
const mine = comments.filter((comment) => comment.body?.startsWith(MARKER));
for (const comment of mine) {
  await gh(`/issues/comments/${comment.id}`, { method: "DELETE" });
}
await gh(`/issues/${prNumber}/comments`, {
  method: "POST",
  body: JSON.stringify({ body }),
});

console.log(`Posted eval results comment on PR #${prNumber} (${mine.length} previous replaced).`);
