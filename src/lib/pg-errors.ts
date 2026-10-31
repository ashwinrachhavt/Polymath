/**
 * Postgres unique-violation (23505) detection in one predicate.
 *
 * The same server error arrives in several shapes: postgres-js surfaces the
 * PostgresError with `.code` at top level, drizzle wraps it in a
 * DrizzleQueryError whose `.cause` keeps the original, and some drivers nest
 * deeper still. "Duplicate means replay the winner" sites that check only one
 * shape silently miss the others and 500 on a legitimate replay instead.
 * Walk the cause chain (bounded, like the probe that shaped the original
 * site) and match the first 23505.
 *
 * With `constraint`, a violation that names a different constraint is not a
 * match — and because a wrapper does not always forward `constraint_name`, an
 * unnamed violation counts as a match (the conservative replay).
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  let current = error as { code?: unknown; constraint_name?: unknown; cause?: unknown } | null | undefined;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (
      current.code === "23505" &&
      (!constraint || !current.constraint_name || current.constraint_name === constraint)
    ) {
      return true;
    }
    current = current.cause as typeof current;
  }
  return false;
}
