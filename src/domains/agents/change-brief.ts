/*
 * The change brief's data shape (Workbench D2): a deterministic, evidence-tiered
 * read of what a captured checkpoint changed. No model anywhere in this module —
 * every claim is derived from the stored diff bytes, the captured test results,
 * the recorded decision, or the linked project's stated outcome, and each section
 * carries the tier that matches its evidence. The panel component renders this
 * shape; the capture script's constants re-export from here so the write path
 * (scripts/workbench) and the read path (the run page) cannot drift apart.
 */

import type { CapturedTestResult } from "@/domains/agents/schema";

/** The disclosure line every brief carries: capture is local and model-free. */
export const CAPTURE_DISCLOSURE = "Captured locally from git state and provided test results. Nothing was sent to a model.";
/** The literal fallback when no decision was recorded at capture time. */
export const RATIONALE_INFERRED = "rationale inferred after implementation";

export type DiffFileStatus = "added" | "removed" | "modified";

export type DiffFile = {
  /** The repository-relative path as the diff names it (b/ side, a/ side on deletions). */
  path: string;
  status: DiffFileStatus;
};

/** Changed paths grouped by the area of the codebase they belong to. */
export type ChangeArea = { area: string; paths: string[] };

/** The diff's file-level behaviour reading: what appeared, what went away, what changed in place. */
export type ChangeBehavior = {
  added: string[];
  removed: string[];
  modified: string[];
};

export type ChangeBriefCheckpoint = {
  id: string;
  repoUrl: string;
  baseCommitSha: string;
  commitSha: string;
  decisionNote: string | null;
  decisionStatus: "recorded" | "inferred";
  capturedAt: Date;
};

export type ChangeBriefProject = {
  name: string;
  intendedOutcome: string | null;
};

/*
 * What the panel renders, one field per brief section. `diffText` is null when
 * the blob's retention lapsed or the bytes would not read — a missing diff stays
 * missing, never rendered as empty.
 */
export type ChangeBriefData = {
  checkpoint: ChangeBriefCheckpoint;
  areas: ChangeArea[];
  behavior: ChangeBehavior;
  /** Captured test results; null when the operator provided no test-results file. */
  tests: CapturedTestResult[] | null;
  diffText: string | null;
  diffUnavailableReason: string | null;
  project: ChangeBriefProject | null;
  /** Designer's header sizing: grounded vs interpreted vs unrun, counted over the sections actually present. */
  tierCounts: { grounded: number; inferred: number; hypothesis: number };
  /** The decision section's literal text after the recorded/inferred resolution. */
  decisionLine: string;
};

/*
 * The diff parser reads the headers `git diff --binary` writes. It does not
 * parse hunks — the panel shows the diff verbatim — only the file list and
 * each file's add/remove/modify status, which feed the areas and behaviour
 * sections.
 */
export function parseDiffFiles(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: { path: string; status: DiffFileStatus } | null = null;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      current = { path: diffHeaderPath(line), status: "modified" };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "removed";
  }
  if (current) files.push(current);
  return files;
}

/**
 * The path from a `diff --git` header line. Git quotes paths that are not
 * simple ASCII (`"a/\316\273.txt"`); unquote and decode the C-style octal
 * escapes so the reader sees the real name. Falls back to the raw text —
 * a mangled name is worse than an honest odd one.
 */
function diffHeaderPath(line: string): string {
  const quoted = /^diff --git "(?:a\/)?(.*)" "(?:b\/)?(.*)"$/.exec(line);
  if (quoted) return unquoteGitPath(quoted[2]);
  const raw = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
  return raw ? raw[2] : line.slice("diff --git ".length);
}

function unquoteGitPath(path: string): string {
  return path.replace(/\\(?:["\\]|([0-7]{3}))/g, (_, octal: string | undefined) =>
    octal !== undefined ? String.fromCharCode(parseInt(octal, 8)) : _ === '\\\\' ? "\\" : '"',
  );
}

/**
 * The area of the codebase a path belongs to, read from the path itself —
 * no domain list is hardcoded here, so the mapping cannot go stale when a
 * domain is added. Paths under `src/domains/<d>/` map to `<d>`; the other
 * top-level homes (app, components, lib) map to themselves; anything else
 * reports its first segment.
 */
export function areaOfPath(path: string): string {
  const domain = /^src\/domains\/([^/]+)\//.exec(path);
  if (domain) return domain[1];
  const top = /^(src\/app|src\/components|src\/lib|scripts|docs)\//.exec(path);
  if (top) return top[1];
  const root = /^([^/]+)\//.exec(path);
  return root ? root[1] : "(root)";
}

/** Group changed paths by area, largest group first so the dominant area reads first. */
export function groupAreas(files: DiffFile[]): ChangeArea[] {
  const byArea = new Map<string, string[]>();
  for (const file of files) {
    const paths = byArea.get(areaOfPath(file.path)) ?? [];
    paths.push(file.path);
    byArea.set(areaOfPath(file.path), paths);
  }
  return [...byArea.entries()]
    .map(([area, paths]) => ({ area, paths }))
    .sort((a, b) => b.paths.length - a.paths.length || a.area.localeCompare(b.area));
}

export function behaviorOf(files: DiffFile[]): ChangeBehavior {
  const behavior: ChangeBehavior = { added: [], removed: [], modified: [] };
  for (const file of files) behavior[file.status].push(file.path);
  return behavior;
}

/*
 * The tier counts summarise the sections the brief actually renders, per the
 * Designer's header spec ("4 grounded · 1 inferred · 2 hypotheses"). A section
 * whose evidence is absent (no tests provided, no readable diff) counts as
 * neither: absence is reported in its section, never dressed as a tier.
 */
function tierCountsOf(input: {
  hasProject: boolean;
  hasTests: boolean;
  hasDiff: boolean;
  decisionStatus: "recorded" | "inferred";
}): ChangeBriefData["tierCounts"] {
  let grounded = 0; // areas + behaviour are always grounded (observed in the diff)
  if (input.hasProject) grounded += 1;
  if (input.hasTests) grounded += 1;
  if (input.hasDiff) grounded += 1;
  grounded += 2;
  return { grounded, inferred: input.decisionStatus === "inferred" ? 1 : 0, hypothesis: 0 };
}

export function buildChangeBriefData(input: {
  checkpoint: ChangeBriefCheckpoint;
  tests: CapturedTestResult[] | null;
  diffText: string | null;
  diffUnavailableReason: string | null;
  project: ChangeBriefProject | null;
}): ChangeBriefData {
  const files = input.diffText ? parseDiffFiles(input.diffText) : [];
  return {
    checkpoint: input.checkpoint,
    areas: groupAreas(files),
    behavior: behaviorOf(files),
    tests: input.tests,
    diffText: input.diffText,
    diffUnavailableReason: input.diffUnavailableReason,
    project: input.project,
    tierCounts: tierCountsOf({
      hasProject: input.project !== null,
      hasTests: input.tests !== null,
      hasDiff: input.diffText !== null,
      decisionStatus: input.checkpoint.decisionStatus,
    }),
    decisionLine: input.checkpoint.decisionNote ?? RATIONALE_INFERRED,
  };
}
