import { conceptName } from "@/domains/knowledge/concepts";

/*
 * The shape of an explainer, after Geoffrey Litt's "literate diff": background
 * first, then the intuition, then the changes told as a story rather than in
 * file order, then what to watch. The model proposes the parts; this module
 * disposes. A reference to a file the diff never touched is dropped and
 * counted, never repaired, so every `path:line` a reader sees points at code
 * that actually changed.
 */

type ExplainerPart = {
  title: string;
  story: string;
  refs: Array<{ path: string; line?: number }>;
};

export type ExplainerParts = {
  title: string;
  background: string;
  intuition: string;
  changes: ExplainerPart[];
  risks: string[];
  concepts: string[];
};

type ExplainerMeta = { repo: string; commit: string; range: string | null };

const MAX_CONCEPTS = 8;

/** The files a unified diff touches, by their new path. */
export function diffPaths(diff: string): Set<string> {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (header) paths.add(header[1]);
    const added = /^\+\+\+ b\/(.+)$/.exec(line);
    if (added) paths.add(added[1]);
  }
  return paths;
}

/** The parts with only the references the diff supports, and concept names in their stored form. */
export function verifiedParts(
  parts: ExplainerParts,
  paths: Set<string>,
): { parts: ExplainerParts; droppedRefs: number } {
  let droppedRefs = 0;
  const changes = parts.changes.map((change) => ({
    ...change,
    refs: change.refs.filter((ref) => {
      const kept = paths.has(ref.path) && (ref.line === undefined || (Number.isInteger(ref.line) && ref.line > 0));
      if (!kept) droppedRefs += 1;
      return kept;
    }),
  }));
  const seen = new Set<string>();
  const concepts = parts.concepts
    .map(conceptName)
    .filter((name) => {
      if (!name || seen.has(name.toLowerCase())) return false;
      seen.add(name.toLowerCase());
      return true;
    })
    .slice(0, MAX_CONCEPTS);
  return { parts: { ...parts, changes, concepts }, droppedRefs };
}

function refText(ref: { path: string; line?: number }): string {
  return `\`${ref.line === undefined ? ref.path : `${ref.path}:${ref.line}`}\``;
}

/** The note body: Markdown the editor stores as it is and the quiz reads as its source text. */
export function composeExplainer(parts: ExplainerParts, meta: ExplainerMeta): string {
  const where = `${meta.repo} at ${meta.commit.slice(0, 7)}${meta.range ? ` (${meta.range})` : ""}`;
  const lines = [
    `*${where}*`,
    "",
    "## Background",
    "",
    parts.background.trim(),
    "",
    "## Intuition",
    "",
    parts.intuition.trim(),
  ];
  lines.push("", "## What changed, in order");
  parts.changes.forEach((change, index) => {
    lines.push("", `### ${index + 1}. ${change.title.trim()}`, "", change.story.trim());
    if (change.refs.length > 0) lines.push("", `Where: ${change.refs.map(refText).join(", ")}`);
  });
  if (parts.risks.length > 0) {
    lines.push("", "## Risks and what to watch", "", ...parts.risks.map((risk) => `- ${risk.trim()}`));
  }
  if (parts.concepts.length > 0) lines.push("", "## Concepts", "", ...parts.concepts.map((name) => `- ${name}`));
  return `${lines.join("\n")}\n`;
}
