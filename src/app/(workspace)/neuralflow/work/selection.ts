/*
 * Selection state for the Work list's bulk edit (Product Spec: "bulk edit").
 * Pure functions so the honest-selection rules are unit-testable without
 * rendering the list.
 */

/**
 * Toggle one row. Order is selection order - the action bar's count and the
 * audit order both follow it.
 */
export function toggleSelection(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
}

/**
 * Selection only ever names rows currently on screen: a filter, page or
 * refresh that drops a row drops it from the selection too, so an invisible
 * id can never ride along into a later bulk action.
 */
export function pruneSelection(selected: string[], visibleIds: ReadonlySet<string>): string[] {
  return selected.filter((id) => visibleIds.has(id));
}
