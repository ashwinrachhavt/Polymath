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
    "design-brief",
    "Design brief",
    "Turn a research card into a structured design brief, ready for review.",
    `# Design brief

Turn one research card (a report, memo, document, note, or zettel card) into a
design brief with exactly these fields: title, objective, audience, key
message, tone, format, visual direction, deliverables, constraints, call to
action.

1. Read the card in full before writing anything. In the app, the card's own
   "Design brief" action runs this procedure and saves the brief as a memo
   artifact; in chat, work from the card the owner pasted or found for you.
2. "format" is one of Canva's presets: doc, whiteboard, or presentation.
3. Ground every field in the card. A field the card does not support is null,
   never invented - no brand facts, audiences, or constraints from nowhere.
4. Keep the key message to one sentence; a brief with three key messages has
   none.
5. Close by naming what the brief leaves open, so the reviewer knows what to
   check.

The Canva handoff is approval-gated: the brief page's "Send to Canva" files a
canva.design.import proposal, and only the owner's approval of that exact
revision in Reviews starts Canva's asynchronous import job. Never claim a
design was or will be created before the job's terminal status lands - a
created job is not an imported design, and Canva's rendering of the generated
document is not verified yet.`,
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
