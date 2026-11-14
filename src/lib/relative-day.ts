/** "today", "yesterday", "4 days ago", then the date: enough for "when was this last seen". */
export function relativeDay(when: Date): string {
  const days = Math.floor((Date.now() - when.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
