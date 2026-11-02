import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The notifications shell is a client component subtree. A runtime import from
 * a server module (the feed reads the database) drags postgres into the
 * browser bundle, and `next build` fails on the unresolvable node builtins —
 * a failure no unit test sees, because the component tests mock that graph.
 * The contract lives in the client-safe triage module; this pins the boundary
 * at the source level so the graph cannot silently regrow.
 */

const SHELL = join(import.meta.dirname, "../../src/components/shell");

const FORBIDDEN = [
  ["@/lib/db", /from\s+"@\/lib\/db/],
  ["@/lib/db (relative)", /from\s+"\.\.\/\.\.\/lib\/db/],
  ["@/domains/notifications/feed", /from\s+"@\/domains\/notifications\/feed/],
  ["@/domains/notifications/feed (relative)", /from\s+"(\.\.\/)+domains\/notifications\/feed/],
  ["@/domains/agents/queries", /from\s+"@\/domains\/agents\/queries/],
  ["@/domains/home/queue", /from\s+"@\/domains\/home\/queue/],
] as const;

function shellFiles(): string[] {
  const files = [join(SHELL, "notifications-panel.tsx")];
  const dir = join(SHELL, "notifications");
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".tsx") || entry.endsWith(".ts")) files.push(join(dir, entry));
  }
  return files;
}

describe("triage client boundary", () => {
  it("keeps the notifications shell free of server-module imports", () => {
    const files = shellFiles();
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const [label, pattern] of FORBIDDEN) {
        expect(
          src,
          `${file.replace(SHELL, "shell")} must not import ${label} — use @/domains/notifications/triage`,
        ).not.toMatch(pattern);
      }
    }
  });
});
