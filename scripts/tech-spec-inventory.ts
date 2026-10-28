#!/usr/bin/env tsx
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

/*
 * Emits docs/generated/inventory.md — the parts of the technical spec that are
 * facts about the code rather than decisions about it.
 *
 * Why this exists: the previous tech spec listed tables, routes, and tools by
 * hand. It was accurate when written and stale within weeks, and a reader had
 * no way to tell which entries had rotted. Anything here that can be read off
 * the tree is read off the tree; the authored half of the spec never restates
 * it.
 *
 *   pnpm tsx scripts/tech-spec-inventory.ts
 *   make inventory
 */

const ROOT = process.cwd();
const OUT = "docs/generated/inventory.md";

function walk(dir: string, file: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, file, acc);
    else if (name.endsWith(file)) acc.push(path);
  }
  return acc;
}

const read = (p: string) => readFileSync(p, "utf8");

/*
 * Row-state classification lives in scripts/lib/row-state.ts so this generator and
 * the test that enforces the rule cannot drift apart. See that module for why.
 */
import { GUARDED_WITHOUT_VERSION, VERSIONED_WITH_TRIGGER_INVARIANT, readTables } from "./lib/row-state";

const byDomain = new Map<string, string[]>();
const stateCount = { versioned: 0, "append-only": 0, "mutable-unversioned": 0 };
const defects: string[] = [];

for (const { domain, name, key, state } of readTables(ROOT)) {
  const declared = GUARDED_WITHOUT_VERSION[key];
  const list = byDomain.get(domain) ?? [];
  stateCount[state]++;
  const marker =
    state === "mutable-unversioned"
      ? declared
        ? declared.guards.map((g) => g.kind).join(" + ")
        : "**DEFECT**"
      : state;
  if (state === "mutable-unversioned" && !declared) defects.push(`${key} is mutable with no version column and no declared guard`);
  // A versioned table can still carry a trigger freezing security-relevant columns.
  const invariants = VERSIONED_WITH_TRIGGER_INVARIANT[key]?.guards.map((g) => g.kind).join(" + ");
  list.push(`${name} — ${marker}${invariants ? ` (+ ${invariants})` : ""}`);
  byDomain.set(domain, list);
}

const domainDirs = readdirSync(join(ROOT, "src/domains")).filter((d) =>
  statSync(join(ROOT, "src/domains", d)).isDirectory(),
);
const withTables = [...byDomain.keys()].sort();
const withoutTables = domainDirs.filter((d) => !byDomain.has(d)).sort();

const routes = walk(join(ROOT, "src/app/api"), "route.ts")
  .map((f) => "/" + relative(join(ROOT, "src/app"), f).replace(/\/route\.ts$/, ""))
  .sort();

const manifest = read(join(ROOT, "src/domains/integrations/tool-manifest.ts"));
const toolBlock = manifest.slice(manifest.indexOf("export const TOOL_SCHEMAS"));
const tools = [...new Set([...toolBlock.slice(0, toolBlock.indexOf("};")).matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]))].sort();

const bundledSrc = read(join(ROOT, "src/domains/skills/bundled.ts"));
const bundled = [...bundledSrc.matchAll(/bundled\(\s*\n\s*"([a-z-]+)",\s*\n\s*"([^"]+)"/g)].map((m) => `${m[1]} (${m[2]})`);

const topicConsts = new Map<string, string>();
for (const file of walk(join(ROOT, "src"), ".ts")) {
  for (const m of read(file).matchAll(/const\s+([A-Z0-9_]*TOPIC)\s*(?::[^=]+)?=\s*"([a-z0-9_.]+)"/g)) {
    topicConsts.set(m[1], m[2]);
  }
}
const emitted = new Set<string>();
for (const file of walk(join(ROOT, "src"), ".ts")) {
  for (const m of read(file).matchAll(/topic:\s*"([a-z0-9_.:]+)"/g)) emitted.add(m[1]);
}
for (const t of topicConsts.values()) emitted.add(t);

const handlerSrc = read(join(ROOT, "src/domains/audit/outbox-handlers.ts"));
const ytSrc = read(join(ROOT, "src/domains/knowledge/youtube-handler.ts"));
const registered = new Set<string>();
const collectKeys = (src: string, from: string) => {
  const seg = src.slice(src.indexOf(from));
  for (const m of seg.matchAll(/\[([A-Z0-9_]+)\]/g)) registered.add(topicConsts.get(m[1]) ?? m[1]);
  for (const m of seg.matchAll(/"([a-z0-9_.]+)"\s*:/g)) registered.add(m[1]);
};
collectKeys(handlerSrc, "export function outboxHandlers");
collectKeys(ytSrc, "export const youtubeHandlers");

/*
 * Topics declared observation-only are a third category, not a gap. The audit
 * row is the record and the outbox row waits for a future subscriber; the suite
 * in tests/unit/outbox-topic-coverage.test.ts enforces the declaration. Without
 * reading it here the summary counts deliberate design as missing work.
 */
const auditOnlySrc = handlerSrc.slice(handlerSrc.indexOf("AUDIT_ONLY_TOPICS"));
const auditOnly = new Set<string>(
  [...auditOnlySrc.slice(0, auditOnlySrc.indexOf("];")).matchAll(/"([a-z0-9_.]+)"/g)].map((m) => m[1]),
);

const unhandled = [...emitted].filter((t) => !registered.has(t) && !auditOnly.has(t)).sort();
const declaredOnly = [...emitted].filter((t) => !registered.has(t) && auditOnly.has(t)).sort();

const pkg = JSON.parse(read(join(ROOT, "package.json")));
const dep = (n: string) => pkg.dependencies?.[n] ?? pkg.devDependencies?.[n] ?? "absent";
const migrations = readdirSync(join(ROOT, "src/db/migrations")).filter((f) => f.endsWith(".sql")).sort();

const testCount = (ext: string) => walk(join(ROOT, "tests"), ext).length;
const testDirs = ["unit", "integration", "e2e"].map(
  (d) => `${d}: ${walk(join(ROOT, "tests", d), ".test.ts").length + walk(join(ROOT, "tests", d), ".spec.ts").length}`,
);
const lines: string[] = [
  "# Generated inventory",
  "",
  "<!-- DO NOT EDIT. Emitted by `scripts/tech-spec-inventory.ts` (`make inventory`). -->",
  "",
  "Facts about the tree, read at generation time. The authored half of the",
  "technical specification is `docs/tech-spec-v2.md`; it does not restate any of this.",
  "",
  "Generated from the working tree. The output contains nothing environment-",
  "dependent, so `inventory:check` behaves the same on a laptop and in CI.",
  "",
  "## Stack",
  "",
  "| Package | Version |",
  "| --- | --- |",
  ...["next", "react", "drizzle-orm", "drizzle-kit", "postgres", "pg", "@clerk/nextjs", "@tiptap/react", "tailwindcss", "zod", "@vercel/blob", "eve", "vitest", "@playwright/test"]
    .map((n) => `| \`${n}\` | ${dep(n)} |`),
  "",
  `Migrations: ${migrations.length} files, highest \`${migrations.at(-1)?.replace(/\.sql$/, "")}\`.`,
  "",
  "## Tests",
  "",
  `${testCount(".test.ts")} \`.test.ts\` and ${testCount(".spec.ts")} \`.spec.ts\` files (${testDirs.join(", ")}).`,
  "## Domains",
  "",
  `${domainDirs.length} folders; ${withTables.length} own tables.`,
  "",
  "| Domain | Tables |",
  "| --- | ---: |",
  ...withTables.map((d) => `| \`${d}\` | ${byDomain.get(d)!.length} |`),
  "",
  `No tables: ${withoutTables.map((d) => `\`${d}\``).join(", ")}.`,
  "",
  "## Tables",
  "",
  "| Domain | Table | State |",
  "| --- | --- | --- |",
  ...[...byDomain.entries()]
    .sort()
    .flatMap(([d, list]) =>
      list.map((entry) => {
        const [name, marker] = entry.split(" — ");
        return `| \`${d}\` | \`${name}\` | ${marker ?? "versioned"} |`;
      }),
    ),
  "",
  `Totals: ${stateCount.versioned} versioned, ${stateCount["append-only"]} append-only, ${stateCount["mutable-unversioned"]} versionless but guarded (each declared with its guard and its file in \`scripts/lib/row-state.ts\`).`,
  "",
  "## Route handlers",
  "",
  ...routes.map((r) => `- \`${r}\``),
  "",
  "## Provider tools",
  "",
  `${tools.length} tools.`,
  "",
  ...tools.map((t) => `- \`${t}\``),
  "",
  "## Bundled skills",
  "",
  ...bundled.map((s) => `- ${s}`),
  "",
  "## Outbox",
  "",
  `Emitted topics: ${emitted.size}. Registered handlers: ${registered.size}. Declared audit-only: ${declaredOnly.length}.`,
  "",
  "Topics with no handler and no declaration (a defect if non-empty):",
  "",
  ...(unhandled.length ? unhandled.map((t) => `- \`${t}\``) : ["- none"]),
  "",
  "Declared audit-only (observation events; no consumer by design):",
  "",
  ...(declaredOnly.length ? declaredOnly.map((t) => `- \`${t}\``) : ["- none"]),
  "",
  ...(defects.length ? ["## Defects found by this generator", "", ...defects.map((d) => `- ${d}`), ""] : []),
];

mkdirSync(join(ROOT, "docs/generated"), { recursive: true });
const rendered = lines.join("\n");
const target = join(ROOT, OUT);
const previous = existsSync(target) ? readFileSync(target, "utf8") : "";
writeFileSync(target, rendered);
console.log(`${OUT}: ${byDomain.size} domains, ${stateCount.versioned + stateCount["append-only"] + stateCount["mutable-unversioned"]} tables, ${routes.length} routes, ${tools.length} tools, ${unhandled.length} unhandled topics (${declaredOnly.length} declared audit-only), ${defects.length} defects`);

/*
 * --check makes this a gate rather than a convenience. A generated document that
 * is only as current as the last time someone remembered to run it is the problem
 * the generator exists to solve, so `make check` runs this and fails on drift.
 */
if (process.argv.includes("--check")) {
  if (previous !== rendered) {
    console.error(`${OUT} is stale. Run \`make inventory\` and commit the result.`);
    process.exit(1);
  }
  console.log(`${OUT} is current.`);
}
