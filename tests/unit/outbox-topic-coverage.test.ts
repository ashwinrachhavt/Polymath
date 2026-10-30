import { describe, expect, it } from "vitest";
import { AUDIT_ONLY_TOPICS, outboxHandlers } from "@/domains/audit/outbox-handlers";

/*
 * Every topic the app writes must have a stated fate: a handler that consumes it,
 * or an entry in AUDIT_ONLY_TOPICS saying no consumer is required. Without that
 * split a queued row cannot be distinguished from an abandoned one, and the gap is
 * invisible - the queue looks quiet rather than wrong.
 *
 * The emitted list is parsed from source rather than imported: topics are written
 * as string literals at their call sites, and importing every domain to collect
 * them would make this test depend on the whole app booting.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, acc);
    else if (name.endsWith(".ts")) acc.push(path);
  }
  return acc;
}

function emittedTopics(): Set<string> {
  const src = join(process.cwd(), "src");
  const topics = new Set<string>();
  for (const file of walk(src)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/topic:\s*"([a-z0-9_.:]+)"/g)) topics.add(m[1]);
    // Topic constants: `const X_TOPIC = "a.b";` then `[X_TOPIC]:` in a map.
    for (const m of text.matchAll(/const\s+[A-Z0-9_]*TOPIC\s*(?::[^=]+)?=\s*"([a-z0-9_.]+)"/g)) {
      topics.add(m[1]);
    }
    // Positional emit: `emit(tx, auth, "a.b", {...})` (notes.ts, commands.ts).
    for (const m of text.matchAll(/emit\(\s*\w+\s*,\s*\w+\s*,\s*"([a-z0-9_.:]+)"/g)) topics.add(m[1]);
  }
  return topics;
}

describe("outbox topic coverage", () => {
  const topics = emittedTopics();
  const handled = new Set(Object.keys(outboxHandlers()));
  const auditOnly = new Set(AUDIT_ONLY_TOPICS);

  it("finds the topics it is meant to check", () => {
    expect(topics.size).toBeGreaterThan(15);
    expect(handled.size).toBeGreaterThan(5);
  });

  it("has no topic that is both handled and declared audit-only", () => {
    const both = [...auditOnly].filter((t) => handled.has(t));
    expect(both).toEqual([]);
  });

  it("gives every emitted topic a handler or an audit-only declaration", () => {
    const orphans = [...topics].filter((t) => !handled.has(t) && !auditOnly.has(t)).sort();
    expect(orphans).toEqual([]);
  });

  it("declares no topic that is never emitted", () => {
    const stale = [...auditOnly].filter((t) => !topics.has(t)).sort();
    expect(stale).toEqual([]);
  });
});
