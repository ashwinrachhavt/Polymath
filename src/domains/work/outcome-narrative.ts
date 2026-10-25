/*
 * ASH-280: the weekly outcome narrative. Deterministic and factual: it only
 * restates what the owner recorded (their own outcome sentences on finished
 * focus sessions, the stones earned) and counts. No model writes it, nothing is
 * inferred, and by spec (7.4, 7.6) it carries no score, points or streak -
 * "not a scorecard". An empty week yields no narrative at all.
 */

export type NarrativeSession = { endedAt: string; minutes: number; taskTitle: string | null; subject: string | null; outcome: string | null };
export type NarrativeStone = { label: string; note: string | null };

export type OutcomeNarrativeInput = {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
  sessions: NarrativeSession[];
  stones: NarrativeStone[];
};

export type OutcomeNarrative = { title: string; markdown: string; plainText: string };

const MAX_LISTED = 8;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function fmtDay(date: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function composeOutcomeNarrative(input: OutcomeNarrativeInput): OutcomeNarrative | null {
  if (input.sessions.length === 0 && input.stones.length === 0) return null;

  const minutes = input.sessions.reduce((sum, s) => sum + s.minutes, 0);
  const lines: string[] = [];

  const facts: string[] = [];
  if (input.sessions.length > 0) facts.push(`finished ${plural(input.sessions.length, "focus session")} (${plural(minutes, "minute")} in all)`);
  if (input.stones.length > 0) facts.push(`earned ${plural(input.stones.length, "stone")}`);
  lines.push(`This week you ${facts.join(" and ")}.`);

  const outcomes = [...input.sessions]
    .sort((a, b) => a.endedAt.localeCompare(b.endedAt))
    .flatMap((s) => {
      const outcome = s.outcome ? clean(s.outcome) : "";
      if (!outcome) return [];
      const about = clean(s.taskTitle ?? s.subject ?? "");
      return [about ? `${about}: ${outcome}` : outcome];
    });
  const stoneNotes = input.stones.flatMap((s) => (s.note && clean(s.note) ? [clean(s.note)] : []));
  const written = [...outcomes, ...stoneNotes.filter((n) => !outcomes.some((o) => o.endsWith(n)))];

  const listed = written.slice(0, MAX_LISTED);
  const bullets: string[] = [];
  if (listed.length > 0) {
    bullets.push("In your own words:");
    for (const item of listed) bullets.push(`- ${item}`);
    if (written.length > listed.length) bullets.push(`- and ${plural(written.length - listed.length, "more outcome")}`);
  } else if (input.sessions.length > 0) {
    bullets.push("No outcome sentence was recorded on these sessions.");
  }

  const stoneLabels = new Map<string, number>();
  for (const s of input.stones) stoneLabels.set(s.label, (stoneLabels.get(s.label) ?? 0) + 1);
  const stoneLine =
    stoneLabels.size > 0 ? `Stones: ${[...stoneLabels].map(([label, n]) => `${n} ${label}`).join(", ")}.` : "";

  const title = `Week of ${fmtDay(input.start)} to ${fmtDay(input.end)}`;
  const body = [lines[0], ...(bullets.length ? ["", ...bullets] : []), ...(stoneLine ? ["", stoneLine] : [])];
  const markdown = body.join("\n");
  return { title, markdown, plainText: markdown.replace(/^- /gm, "") };
}

/** Editor document for a kept narrative: one paragraph per line, list items as plain paragraphs. */
export function narrativeToNoteContent(narrative: OutcomeNarrative): Record<string, unknown> {
  const paragraphs = narrative.markdown.split("\n").filter((l) => l.length > 0);
  return {
    type: "doc",
    content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
  };
}
