/*
 * Point DATABASE_URL at the scratch database before any unit test file's
 * module graph loads — UNIT PROJECT ONLY.
 *
 * Under shared workers (isolate: false) one worker evaluates
 * src/lib/db-transaction.ts once and caches its postgres client for the
 * worker's lifetime from whatever DATABASE_URL holds at that instant. Unit
 * files legitimately manipulate that variable (e2e-database deletes it, the
 * live-page renders stub it empty), so the first evaluation could cache a
 * broken value — the gateway's proposal path then connects as the OS user and
 * every DB-backed unit file's lazy connection fails with "password
 * authentication failed for user \"user\"". makeTestDb() already repoints
 * DATABASE_URL at the scratch database for exactly this reason; this pins it
 * the same way, so the worker's first evaluation is always the test database
 * no matter which file loads first.
 *
 * Deliberately not in the shared setup.load-env.ts: the integration suites
 * that truncate every table (reliability, document-schema) guard precisely on
 * TEST_DATABASE_URL differing from DATABASE_URL — repointing one at the other
 * project-wide would trip that guard and defeat it. Their serial, isolated
 * evaluation re-derives the connection per file via makeTestDb().
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
