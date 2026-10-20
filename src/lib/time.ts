/*
 * Relative time for list surfaces. Words, never a bare dash: a missing date
 * is "Never", not a glyph (agents/design.md bans the em dash in user-visible
 * strings). Server-rendered, so no live ticking; a reload is the refresh.
 */
export function timeAgo(date: Date | string | null | undefined): string {
  if (!date) return "Never";
  const at = date instanceof Date ? date : new Date(date);
  const ms = at.getTime();
  if (!Number.isFinite(ms)) return "Never";

  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return "Just now";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;

  const weeks = Math.round(days / 7);
  if (days < 31) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;

  const months = Math.round(days / 30.44);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;

  const years = Math.round(days / 365.25);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}
