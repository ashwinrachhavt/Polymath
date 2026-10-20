/*
 * Renders the eve eval report as a GitHub job summary table.
 *
 * Why this exists: a CI gate nobody reads is a gate that gets disabled. The
 * artifact holds the full event streams, but a reviewer wants "which eval
 * failed, how many gates, and why" on the run page.
 *
 * The report is not pure JSON on stdout — eve prints warnings (model
 * compatibility notes) before the document — so this finds the report object
 * rather than trusting the whole buffer. A missing or unparseable report is a
 * failure, not a blank table: silently showing nothing would make a broken
 * runner look like a passing gate.
 *
 * Usage: node .github/scripts/eval-summary.mjs <report.json>
 */

import { readFileSync, appendFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: eval-summary.mjs <report.json>");
  process.exit(2);
}

function readReport(file) {
  const raw = readFileSync(file, "utf8");
  const start = raw.lastIndexOf('\n{\n  "target"');
  const candidates = start >= 0 ? [raw.slice(start)] : [];
  // Fall back to the first parseable object: harmless if eve stops indenting.
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

/**
 * The only verdict statuses that count as a passing eval. Anything else —
 * "failed", "error", "cancelled", or a status this script does not recognise —
 * renders as a failure, because an unknown verdict is missing evidence, not
 * success.
 */
const PASS_STATUSES = new Set(["passed", "pass", "completed"]);

/**
 * Read an eval's verdict status across the report's shapes. The runner writes
 * `verdict` as a plain string ("passed" | "failed" | ...); older/other shapes
 * nest it as `{status}`. `result.result.status` is the session's own state
 * ("waiting" for a healthy open session), so it is only a last resort — using it
 * first made every passing eval render as a failure.
 */
function verdictOf(result) {
  const verdict = result.verdict;
  if (typeof verdict === "string") return verdict;
  if (verdict && typeof verdict === "object" && typeof verdict.status === "string") return verdict.status;
  const nested = result.result?.status;
  return typeof nested === "string" ? nested : "unknown";
}

const report = readReport(path);
if (!report) {
  console.error("Could not read the eval report; the gate did not produce a parseable result.");
  process.exit(1);
}

const rows = report.results.map((result) => {
  const assertions = result.assertions ?? [];
  const failed = assertions.filter((assertion) => !assertion.passed);
  const status = verdictOf(result).toLowerCase();
  // Pass comes from the verdict, never from the assertion count. A crashed or
  // timed-out eval reports status "failed" with zero assertions, and treating
  // "no failed assertions" as success rendered exactly that as a green row.
  const passed = PASS_STATUSES.has(status) && failed.length === 0;
  const firstFailure =
    failed[0]?.name ?? result.error ?? (passed ? "" : `status ${status}`);
  return {
    id: result.id,
    status: passed ? "pass" : "fail",
    gates: `${assertions.length - failed.length}/${assertions.length}`,
    detail: String(firstFailure).replaceAll("|", "\\|").slice(0, 90),
  };
});

const total = rows.length;
const failedCount = rows.filter((row) => row.status === "fail").length;
const icon = failedCount === 0 ? "✅" : "❌";

const lines = [
  `## ${icon} Agent evals: ${total - failedCount}/${total} passed`,
  "",
  "| Eval | Result | Gates | First failure |",
  "| --- | --- | --- | --- |",
  ...rows.map((row) => `| \`${row.id}\` | ${row.status === "pass" ? "pass" : "**fail**"} | ${row.gates} | ${row.detail || "—"} |`),
  "",
];

if (report.target?.url) lines.push(`Target: \`${report.target.url}\``);

const summary = lines.join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

// The table is a view; the eval command's exit code remains the gate. This step
// only fails when it could not report at all.
process.exit(0);
