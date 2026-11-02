/*
 * The operator's DATABASE_URL, captured in the vitest parent at config-eval
 * time and injected into workers via test.env (vitest.config.mts). makeTestDb
 * retargets process.env.DATABASE_URL in its own worker and projects share the
 * worker pool, so nothing inside a worker can recover the original value by
 * reading the live variable.
 */
export function pristineDatabaseUrl(): string | undefined {
  const value = process.env.PRISTINE_DATABASE_URL;
  return value === undefined || value === "" ? undefined : value;
}
