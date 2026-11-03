/*
 * The wizard's suggestion catalog: which tools and priorities step two
 * offers, keyed off the role the person chose at step one. Pure data and a
 * pure lookup — no client or server imports — so the wizard, its fixtures,
 * and the unit tests all read the same list. Nothing here reaches the brief
 * schema's ceilings by construction: suggestions stay well inside the
 * per-field maxima (tools 30, priorities 20).
 */

export type RoleSuggestions = { tools: string[]; priorities: string[] };

/** Step one's role chips: the common shapes, not a taxonomy. The field below them takes any wording. */
export const ROLE_OPTIONS = [
  "Founder or executive",
  "Software engineer",
  "Designer",
  "Student or researcher",
  "Operations",
  "Writer",
] as const;

const ROLE_SUGGESTIONS: ReadonlyArray<{ match: readonly string[]; then: RoleSuggestions }> = [
  {
    match: ["founder", "ceo", "co-founder", "indie"],
    then: {
      tools: ["Gmail", "Notion", "Linear", "Google Calendar", "Slack"],
      priorities: ["Keep the inbox at zero", "Never miss a renewal or deadline", "Protect deep-work mornings"],
    },
  },
  {
    match: ["engineer", "developer", "programmer", "devops", "data"],
    then: {
      tools: ["GitHub", "Linear", "Slack", "VS Code", "Notion"],
      priorities: ["Triage issues before they age", "Keep PR reviews moving", "Protect focus blocks"],
    },
  },
  {
    match: ["design"],
    then: {
      tools: ["Figma", "Notion", "Slack", "Linear"],
      priorities: ["Keep critique notes actionable", "Track design debt", "Protect maker time"],
    },
  },
  {
    match: ["research", "student", "phd", "academic", "scien"],
    then: {
      tools: ["Zotero", "Notion", "Google Scholar", "Gmail"],
      priorities: ["Keep the reading list moving", "Turn notes into writing", "Never lose a source"],
    },
  },
  {
    match: ["operations", "ops", "chief of staff", "project manager", "program manager"],
    then: {
      tools: ["Notion", "Linear", "Google Calendar", "Slack", "Gmail"],
      priorities: ["Never let a deadline surprise me", "Keep the weekly review honest", "Unblock people fast"],
    },
  },
  {
    match: ["writ", "journalist", "editor", "content", "market"],
    then: {
      tools: ["Notion", "Gmail", "Google Docs", "Slack"],
      priorities: ["Keep a steady publishing cadence", "Capture ideas before they evaporate", "Track what resonates"],
    },
  },
];

/** The offer when no role matches: the same few tools the interview's own placeholder names. */
const GENERAL: RoleSuggestions = {
  tools: ["Gmail", "Notion", "Google Calendar", "Slack"],
  priorities: ["Keep the inbox at zero", "Protect deep-work time"],
};

/**
 * Suggested tools and priorities for a role, read from the words the person
 * wrote — "Founder at a two-person studio" matches "founder" the same way
 * the bare chip does. Multiple matches union in catalog order; caps keep a
 * role that names several worlds from wallpapring the step.
 */
export function suggestionsForRole(role: string): RoleSuggestions {
  const text = role.toLowerCase();
  const hits = ROLE_SUGGESTIONS.filter((entry) => entry.match.some((needle) => text.includes(needle)));
  if (hits.length === 0) return GENERAL;
  const tools = [...new Set(hits.flatMap((hit) => hit.then.tools))].slice(0, 8);
  const priorities = [...new Set(hits.flatMap((hit) => hit.then.priorities))].slice(0, 6);
  return { tools, priorities };
}

/** Split a review field's comma- or semicolon-separated text into clean values. */
export function parseList(text: string, separators: RegExp): string[] {
  return text
    .split(separators)
    .map((item) => item.trim())
    .filter(Boolean);
}
