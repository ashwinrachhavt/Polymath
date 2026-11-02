export default function setup() {
  // Snapshot the run-start DATABASE_URL for tests/helpers/app-db-safety.ts:
  // workers and makeTestDb() repoint process.env.DATABASE_URL later, so a test
  // that wants to compare against "what the operator started this run with"
  // must read the value captured before the pool forked.
  if (process.env.DATABASE_URL) {
    process.env.POLYMATH_APP_DATABASE_URL_AT_START = process.env.DATABASE_URL;
  }
}
