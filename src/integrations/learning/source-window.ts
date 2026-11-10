/**
 * The part of a source one generation call reads. A model call sees at most
 * `size` characters of each source, so a long source is read through
 * equal-size windows spread evenly from its start to its end, and call
 * `part` reads window `part` (wrapping around). A source that fits in one
 * window is always read whole. Every window is a verbatim slice, so quotes
 * from any of them still verify against the full source text.
 */
export function sourceWindow(text: string, size: number, part = 0): string {
  if (text.length <= size) return text;
  const windows = Math.ceil(text.length / size);
  const step = (text.length - size) / (windows - 1);
  const start = Math.round((part % windows) * step);
  return text.slice(start, start + size);
}
