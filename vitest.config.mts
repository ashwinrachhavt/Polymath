import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // The shape is declared now so a test lands in the right place rather than
    // the root of the repo; see tests/README.md for what each one proves. The
    // unit project runs under the pinned clock in tests/unit/setup.clock.ts;
    // the db project keeps the real clock because it compares against
    // Postgres timestamps from the service container. Every project installs
    // the default-deny fetch guard in tests/setup.fetch-guard.ts, so a
    // regression that reaches for the network fails loudly instead of
    // shipping as "works locally".
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          // load-env first: unit files legitimately manipulate DATABASE_URL
          // (e2e-database deletes it, live-polymath-pages stubs it empty) and
          // src/lib/db-transaction.ts caches its client at first evaluation,
          // so setup.db-url.ts pins the variable to the scratch database
          // before any unit module graph loads. No unit file opens a database.
          setupFiles: [
            "tests/setup.load-env.ts",
            "tests/unit/setup.db-url.ts",
            "tests/unit/setup.clock.ts",
            "tests/setup.fetch-guard.ts",
          ],
          // Unit files are pure: no database, no shared filesystem state, so
          // their per-file startup (import + transform, the bulk of the serial
          // wall) can overlap safely. The root false below stays in force for
          // every project that does not override it here.
          fileParallelism: true,
        },
      },
      {
        test: {
          name: "db",
          include: ["tests/{integration,contract,migration}/**/*.test.ts"],
          // Loopback-only rather than deny-all: integration tests drive real
          // production code (the outbox dispatchers) against local mock HTTP
          // servers. See tests/setup.fetch-guard.loopback.ts.
          // load-env runs first so TEST_DATABASE_URL exists on a developer
          // machine; without it every file here silently skips locally and the
          // suite reports green without opening a connection.
          setupFiles: ["tests/setup.load-env.ts", "tests/setup.fetch-guard.loopback.ts"],
        },
      },
      // Component tests render React, so they need a DOM and a `.tsx` include
      // that the `unit` project's `*.test.ts` pattern cannot match. They keep
      // the same pinned clock; the unit project stays out of jsdom so its
      // thousands of pure tests keep running in milliseconds.
      {
        test: {
          name: "ui",
          include: ["tests/unit/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["tests/unit/setup.clock.ts", "tests/unit/setup.ui.ts", "tests/setup.fetch-guard.ts"],
        },
      },
    ],
    // All integration files share one test database, and reliability.test.ts
    // truncates every table in its beforeAll. Parallel files race that truncate
    // against concurrent seeds and fail with FK violations and deadlocks, so
    // files run one at a time (within a file, tests still parallelize where
    // independent).
    fileParallelism: false,
    // The truncate-everything suites (document-schema, reliability) guard
    // against the operator pointing DATABASE_URL at the scratch database.
    // makeTestDb retargets process.env.DATABASE_URL in its own worker, and
    // projects share the worker pool, so a guard reading the live variable
    // sees whatever the previous file in that worker left behind. Capture the
    // operator's value once here, in the parent, before any test can mutate
    // it, and inject it into every worker read-only.
    env: { PRISTINE_DATABASE_URL: process.env.DATABASE_URL ?? "" },
  },
});
