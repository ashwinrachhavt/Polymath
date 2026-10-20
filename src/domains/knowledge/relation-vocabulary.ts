/*
 * The relation vocabulary, in one pure module so the domain, the note editor
 * and the graph read the same words. Eleven names, grouped the way a mind
 * sorts an idea against another one (the Aristotelian questions): what kind of
 * thing it is, what it is part of, what it leads to, and how it argues.
 * Machine and provenance edges (semantic, reference, source) are not chosen by
 * the owner and sit apart.
 */
export const RELATION_GROUPS = [
  { group: "Kind and structure", types: ["instance_of", "part_of", "extends", "applies"] },
  { group: "Cause and explanation", types: ["causes", "explains"] },
  { group: "Argument", types: ["supports", "contradicts", "contrasts"] },
  { group: "Other", types: ["related"] },
] as const;

export const RELATION_TYPES = [
  "related", "explains", "supports", "contradicts", "applies", "extends", "contrasts",
  "instance_of", "part_of", "causes", "source",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/** Menu wording, read as "this idea ... that one". */
export const RELATION_LABELS: Record<string, string> = {
  related: "Related",
  explains: "Explains",
  supports: "Supports",
  contradicts: "Challenges",
  applies: "Applies to",
  extends: "Extends",
  contrasts: "Contrasts with",
  instance_of: "Is an example of",
  part_of: "Is part of",
  causes: "Leads to",
  source: "Derived from",
  reference: "Linked",
  semantic: "Suggested",
};

/** Short lowercase verb for an edge on the graph. */
export const RELATION_EDGE_LABELS: Record<string, string> = {
  related: "related",
  explains: "explains",
  supports: "supports",
  contradicts: "challenges",
  applies: "applies to",
  extends: "extends",
  contrasts: "contrasts with",
  instance_of: "example of",
  part_of: "part of",
  causes: "leads to",
  source: "derived from",
};
