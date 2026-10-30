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
    // Postgres timestamps from the service container.
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          setupFiles: ["tests/unit/setup.clock.ts"],
        },
      },
      {
        test: {
          name: "db",
          include: ["tests/{integration,contract,migration}/**/*.test.ts"],
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
          setupFiles: ["tests/unit/setup.clock.ts", "tests/unit/setup.ui.ts"],
        },
      },
    ],
    // All integration files share one test database, and reliability.test.ts
    // truncates every table in its beforeAll. Parallel files race that truncate
    // against concurrent seeds and fail with FK violations and deadlocks, so
    // files run one at a time (within a file, tests still parallelize where
    // independent).
    fileParallelism: false,
  },
});
