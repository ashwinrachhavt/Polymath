/*
 * The palette merges two phases: the fast title search answers first, the
 * hybrid knowledge ranking streams in behind it (the notes page's pattern).
 * Base rows keep their tiered order; extra rows append in their own fused
 * rank, minus anything the fast phase already found - a hit must never
 * appear twice. Rows identify themselves by `key` (the record id the JSX
 * renders as the React key).
 */
export function mergePaletteResults<Row extends { key: string }>(base: readonly Row[], extra: readonly Row[]): Row[] {
  const seen = new Set(base.map((row) => row.key));
  return [...base, ...extra.filter((row) => !seen.has(row.key))];
}
