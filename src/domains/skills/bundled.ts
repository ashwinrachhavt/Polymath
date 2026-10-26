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
    "linear-issue-draft",
    "Linear issue draft",
    "Turn a note or capture into a fully formed Linear issue proposal with acceptance criteria, grounded in its source.",
    `# Linear issue draft

Write a Linear issue proposal from the source note or capture you are given.

1. Restate the ask as one imperative title a stranger could act on.
2. Problem: what is broken or missing, and for whom - one paragraph, only
   what the source supports.
3. Proposal: the smallest change that resolves it.
4. Acceptance criteria: each one an observable behavior a reviewer could
   check, phrased as a checkbox. Three is usually right; every criterion
   must trace to a line in the source.
5. Out of scope: what this issue deliberately does not do.
6. Quote the source material below the proposal so every claim is checkable.

Never invent scope the source does not contain; write open questions into the
relevant section instead. The proposal is a draft for review - creating the
issue in Linear is a separate, deliberate act.`,
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

The Canva handoff is not available: no supported route transfers brief
content into Canva yet, so never claim a design was or will be created. The
saved brief is the deliverable; the handoff is a separate, later step.`,
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
  bundled(
    "calendar-conflicts",
    "Calendar conflicts",
    "Find overlapping events and propose how to resolve each, with the trade-off of every option. Changes wait for approval.",
    `# Calendar conflicts

1. Call calendar_conflicts and read its notices first. They say whether Google
   Calendar is connected and when it last synced; repeat them to the owner as
   they are.
2. For each conflict, name the events and how many minutes overlap.
3. Lay out the options the tool returned, with each trade-off in plain words:
   how far the event moves, who it affects, whether it clears the overlap.
   Never invent a time the tool did not offer.
4. Recommend one option per conflict and say why in one sentence.
5. Events that come from Google cannot be changed from here. Say so, and tell
   the owner to decline or reschedule them in Google Calendar.
6. Only propose a move the owner asked for, or one you recommended and they
   accepted. Use calendar_conflict_propose with the option unchanged. The move
   waits in the review queue; say it is awaiting approval, never that it
   happened.
7. If a refusal comes back, read the conflicts again instead of retrying.

Nothing is written to any calendar without approval.`,
  ),
];

export function bundledSkill(slug: string): InspectedSkill | null {
  return BUNDLED_SKILLS.find((skill) => skill.slug === slug) ?? null;
}
