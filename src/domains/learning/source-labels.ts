import { displayTitle, titleFromText } from "@/lib/display-text";

/*
 * What a quiz calls its sources. A stored title can be raw markdown (a
 * capture filed before titles were cleaned keeps "> ## Documentation Index")
 * and several sources can share one title, so the name shown is worked out
 * from the source, never printed as stored:
 *
 * 1. the stored title with its markdown stripped;
 * 2. when that title is only the first line of the text, the title the text
 *    gives itself (its heading), since nobody chose the first line;
 * 3. when sources still share a name, their site, or else the day they were
 *    saved, tells them apart; sources nothing tells apart are counted.
 */

export type LabelSource = {
  title: string;
  text?: string | null;
  sourceUrl?: string | null;
  createdAt?: Date | null;
};

const UNTITLED = "Untitled source";

function ownTitle(source: LabelSource): string {
  const stored = displayTitle(source.title);
  if (!source.text) return stored || UNTITLED;
  const firstLine = displayTitle(source.text.split("\n").find((line) => line.trim()) ?? "");
  const derived = !stored || stored === firstLine || firstLine.startsWith(stored.replace(/…$/, ""));
  return derived ? titleFromText(source.text, stored || UNTITLED) : stored;
}

function site(source: LabelSource): string | null {
  if (!source.sourceUrl) return null;
  try {
    return new URL(source.sourceUrl).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const day = (source: LabelSource) => (source.createdAt ? DAY.format(source.createdAt) : null);

/** One display name per source, in the order given. */
export function sourceLabels(sources: LabelSource[]): string[] {
  const labels = sources.map(ownTitle);
  for (const detail of [site, day]) {
    const sharing = new Map<string, number[]>();
    labels.forEach((label, i) => sharing.set(label, [...(sharing.get(label) ?? []), i]));
    for (const indexes of sharing.values()) {
      const details = indexes.map((i) => detail(sources[i]));
      if (indexes.length < 2 || new Set(details).size < 2) continue;
      indexes.forEach((i, n) => {
        if (details[n]) labels[i] = `${labels[i]} (${details[n]})`;
      });
    }
  }
  return labels;
}

function counted(labels: string[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts].map(([label, count]) => ({ label, count }));
}

/** The quiz's name: its source, or its first source and how many other names follow. */
export function quizHeading(labels: string[]): string {
  const names = counted(labels);
  if (names.length === 0) return "Quiz";
  const [first] = names;
  if (names.length === 1) return first.count === 1 ? first.label : `${first.label} (${first.count} sources)`;
  return `${first.label} + ${names.length - 1} more`;
}

/** "From 8 sources: A, B (3), C": each name once, with a count where sources share it. */
export function sourcesLine(labels: string[]): string {
  const names = counted(labels).map(({ label, count }) => (count > 1 ? `${label} (${count})` : label));
  return `From ${labels.length} sources: ${names.join(", ")}`;
}
