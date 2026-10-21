import { contentHashOf } from "@/domains/skills/package";
import type { InspectedSkill } from "@/domains/skills/manifest";

/*
 * The three procedures that ship with Polymath, shown in Discover. They are
 * data, not code: installing one copies this text into the workspace's skills
 * table exactly as a source import would, and the run still loads it through
 * the same resolver.
 *
 * `sourcePath` uses the `examples/` prefix so a bundled skill can never collide
 * with a package read from a repository; `revision` is the content hash, so an
 * installed copy is detectable as the same text.
 */

function bundled(
  slug: string,
  name: string,
  description: string,
  body: string,
  files: Array<{ path: string; text: string }> = [],
): InspectedSkill {
  const skill: InspectedSkill = {
    slug,
    name,
    description,
    body,
    files,
    warnings: [],
    contentHash: "",
    sourcePath: `examples/${slug}`,
  };
  skill.contentHash = contentHashOf(skill);
  return skill;
}

export const BUNDLED_SKILLS: readonly InspectedSkill[] = [
  bundled(
    "weekly-review",
    "Weekly review",
    "Close the week: what moved, what stalled, and what carries into the next one.",
    `# Weekly review

Work through these steps in order and keep each answer to one sentence.

1. List what finished this week, with the outcome rather than the activity.
2. List what stalled, and name the concrete next action for each.
3. Read the open tasks and mark anything that no longer matters.
4. Choose the three outcomes the next week is for.
5. Write one line on what made this week harder than it needed to be.

Do not invent progress. If a record is missing, say which record and stop.`,
  ),
  bundled(
    "research-brief",
    "Research brief",
    "Turn a question and a set of sources into a short brief with every claim cited.",
    `# Research brief

1. Restate the question in one sentence.
2. Search the sources the run was given before searching the web.
3. For every claim, cite the passage it came from. A claim with no passage is
   either removed or marked as unresolved.
4. Separate what the sources say from what you conclude.
5. Close with the open questions, each naming what would settle it.

Never fill a gap with a plausible detail. An incomplete brief that says what is
missing is the correct output.`,
  ),
  bundled(
    "meeting-notes",
    "Meeting notes",
    "Turn a transcript into decisions, owners, and dates without commentary.",
    `# Meeting notes

1. List the decisions that were actually made.
2. For each decision, name the owner and the date it is due.
3. List open questions that were not resolved.
4. Do not summarise the discussion; keep only what changes what someone does.
5. If no owner was named, say so rather than assigning one.

Attribute statements only where the transcript names the speaker.`,
  ),
];

export function bundledSkill(slug: string): InspectedSkill | null {
  return BUNDLED_SKILLS.find((skill) => skill.slug === slug) ?? null;
}
