import type { BugSignal } from "./signal";

/*
 * Triage is a pure function of the signal: the same sighting always gets the
 * same labels, files and fix decision, so a label on GitHub can be traced back
 * to a rule here. No model call: the rules are small enough to read, and the
 * judgement-heavy work (reading the code, writing the fix) happens in the
 * GitHub workflow where Claude Code has the repository and the code graph.
 */

type Severity = "high" | "medium" | "low";

export type Triage = {
  area: string;
  severity: Severity;
  reproducibility: "recurring" | "once";
  suspectedFiles: string[];
  /** Small and high-confidence: the issue is labelled `agent:fix` and Claude Code drafts a PR. */
  autoFix: boolean;
  labels: string[];
};

const AGENT_LABEL = "bug-agent";
const FIX_LABEL = "agent:fix";

/**
 * Paths an automated fix may never touch. The fix workflow enforces the same
 * list on the actual diff (`.github/workflows/bug-agent-fix.yml`); here it
 * stops the agent from asking for a fix it would refuse.
 */
const PROTECTED = /^(src\/db\/migrations\/|src\/proxy\.ts|src\/lib\/auth|src\/domains\/identity\/)/;

/** Error types whose fixes are usually a guard or a typo, not a redesign. */
const SIMPLE_ERROR_TYPES = new Set(["TypeError", "ReferenceError", "RangeError"]);

const MAX_SUSPECTED_FILES = 5;

export function triageSignal(signal: BugSignal, input: { occurrences: number; routeFiles: string[] }): Triage {
  const frameFiles = unique(signal.frames.map((frame) => frame.file));
  const suspectedFiles = unique([...frameFiles, ...input.routeFiles]).slice(0, MAX_SUSPECTED_FILES);
  const area = areaOf(frameFiles[0] ?? input.routeFiles[0] ?? null, signal.route);
  const severity = severityOf(signal, input.occurrences);
  const reproducibility = input.occurrences >= 2 ? "recurring" : "once";

  // A draft PR needs a trace that points into our code: a report has none,
  // and a trace that starts in a dependency or a protected path is not a
  // small fix. The PR is still only a draft a human reviews.
  const autoFix =
    signal.source === "sentry" &&
    signal.errorType !== null &&
    SIMPLE_ERROR_TYPES.has(signal.errorType) &&
    signal.frames.length > 0 &&
    signal.frames[0].line !== null &&
    frameFiles.every((file) => !PROTECTED.test(file));

  return {
    area,
    severity,
    reproducibility,
    suspectedFiles,
    autoFix,
    labels: [
      AGENT_LABEL,
      "bug",
      `area:${area}`,
      `sev:${severity}`,
      `repro:${reproducibility}`,
      ...(autoFix ? [FIX_LABEL] : []),
    ],
  };
}

function severityOf(signal: BugSignal, occurrences: number): Severity {
  if (signal.level === "fatal" || occurrences >= 20) return "high";
  if (signal.level === "error") return "medium";
  return "low";
}

/** The owning domain or destination, from the innermost in-app file, else the route. */
function areaOf(file: string | null, route: string | null): string {
  const fromFile = file ? /^src\/(?:domains|components|integrations)\/([\w-]+)\//.exec(file)?.[1] : null;
  if (fromFile) return fromFile;
  const fromApp = file ? /^src\/app\/(?:\([\w-]+\)\/)*(?:api\/(?:v1\/)?)?([\w-]+)\//.exec(file)?.[1] : null;
  if (fromApp) return fromApp;
  const fromRoute = route?.split("/").find((segment) => segment && segment !== ":id");
  return fromRoute ?? "unknown";
}

/**
 * The page and layout files that render a route pattern. `pages` are
 * repo-relative `page.tsx` paths under `src/app`; route groups `(x)` are
 * transparent and a dynamic segment `[x]` matches `:id` or any slug.
 */
export function filesForRoute(route: string | null, pages: string[]): string[] {
  if (!route) return [];
  const wanted = route.split("/").filter(Boolean);
  return pages.filter((page) => {
    const segments = page
      .replace(/^src\/app\//, "")
      .split("/")
      .slice(0, -1)
      .filter((segment) => !/^\(.*\)$/.test(segment));
    if (segments.length !== wanted.length) return false;
    return segments.every((segment, i) => (segment.startsWith("[") ? true : segment === wanted[i]));
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/* ------------------------------ the issue text ----------------------------- */

export type IssueDraft = { title: string; body: string; labels: string[] };

export function draftIssue(
  signal: BugSignal,
  triage: Triage,
  context: { occurrences: number; firstSeenAt: Date; similar: number[] },
): IssueDraft {
  const lines: string[] = [];
  lines.push(
    signal.source === "sentry"
      ? "Reported automatically from a Sentry alert."
      : "Reported from the in-app **Report a bug** button.",
  );
  lines.push("");
  lines.push("| | |", "|---|---|");
  lines.push(`| Fingerprint | \`${signal.fingerprint}\` |`);
  lines.push(`| Seen | ${context.occurrences} time(s) since ${context.firstSeenAt.toISOString().slice(0, 10)} |`);
  lines.push(`| Severity | ${triage.severity} |`);
  if (signal.route) lines.push(`| Route | \`${signal.route}\` |`);
  if (signal.reportKind) lines.push(`| Reporter said | ${signal.reportKind} |`);
  if (signal.sentryIssueUrl) lines.push(`| Sentry | ${signal.sentryIssueUrl} |`);

  if (signal.errorType || signal.message) {
    lines.push("", "### Error", "", "```text");
    lines.push([signal.errorType, signal.message].filter(Boolean).join(": "));
    lines.push("```");
  }

  if (signal.frames.length > 0) {
    lines.push("", "### Stack (in-app frames, innermost first)", "", "```text");
    for (const frame of signal.frames) {
      lines.push(`at ${frame.fn ?? "<anonymous>"} (${frame.file}${frame.line !== null ? `:${frame.line}` : ""})`);
    }
    lines.push("```");
  }

  lines.push("", "### Repro hints", "");
  if (signal.route) lines.push(`- Open a page matching \`${signal.route}\` while signed in.`);
  if (signal.frames[0]) lines.push(`- The throw is in \`${signal.frames[0].file}\`; start there.`);
  lines.push(
    triage.reproducibility === "recurring"
      ? `- Recurring: seen ${context.occurrences} times.`
      : "- Seen once so far; it may need specific data to reproduce.",
  );

  if (triage.suspectedFiles.length > 0) {
    lines.push("", "### Suspected files", "");
    for (const file of triage.suspectedFiles) lines.push(`- \`${file}\``);
  }

  if (context.similar.length > 0) {
    lines.push("", "### Possibly related", "");
    for (const number of context.similar) lines.push(`- #${number}`);
  }

  lines.push(
    "",
    "---",
    triage.autoFix
      ? `_Labelled \`${FIX_LABEL}\`: Claude Code will try a draft fix PR. A human reviews and merges; nothing merges automatically._`
      : `_Add the \`${FIX_LABEL}\` label to ask Claude Code for a draft fix PR._`,
  );

  const title = signal.title.length > 120 ? `${signal.title.slice(0, 119)}…` : signal.title;
  return { title, body: lines.join("\n"), labels: triage.labels };
}
