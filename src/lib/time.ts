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

/*
 * The same scale, compressed for a menu row where the label beside it already
 * carries the meaning and every character of width is contested. Only the
 * largest unit is shown: "3d", not "3d 4h".
 */
export function timeAgoShort(date: Date | string | null | undefined): string {
  if (!date) return "Never";
  const at = date instanceof Date ? date : new Date(date);
  const ms = at.getTime();
  if (!Number.isFinite(ms)) return "Never";

  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;

  const weeks = Math.round(days / 7);
  if (days < 31) return `${weeks}w`;

  const months = Math.round(days / 30.44);
  if (months < 12) return `${months}mo`;

  return `${Math.round(days / 365.25)}y`;
}
