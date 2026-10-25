/*
 * Route JS budget check.
 *
 * Next 16's build table no longer prints per-route First Load JS, so the
 * budget the product spec sets ("measure in build output") has nothing to
 * read. This restores the measurement from the build manifest instead:
 * the app-build-manifest lists exactly the client chunks a route loads on
 * first paint (framework, shared, page), which is what the old table summed.
 *
 * Budgets are gzip bytes, matching the spec's unit.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const BUDGETS = [
  // route path, gzip budget in KB, source of the number
  { route: "/command-center/briefing", budgetKb: 180, source: "Day Theatre spec, acceptance #9" },
];

const manifestPath = join(".next", "app-build-manifest.json");
if (!existsSync(manifestPath)) {
  console.error(
    `route-js: ${manifestPath} not found. .next root contains: ${
      existsSync(".next") ? readdirSync(".next").join(", ") : "(no .next)"
    }`,
  );
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const pages = manifest.pages ?? {};
let failed = false;

for (const { route, budgetKb, source } of BUDGETS) {
  const key = Object.keys(pages).find((k) => k === `${route}/page`);
  if (!key) {
    console.error(`route-js: no manifest entry for ${route}. Keys: ${Object.keys(pages).join(", ")}`);
    failed = true;
    continue;
  }
  const files = pages[key].filter((f) => f.endsWith(".js"));
  let total = 0;
  const rows = files.map((f) => {
    const bytes = gzipSync(readFileSync(join(".next", f))).length;
    total += bytes;
    return `  ${(bytes / 1024).toFixed(1).padStart(7)} KB  ${f}`;
  });
  const kb = total / 1024;
  const ok = kb <= budgetKb;
  console.log(`${ok ? "ok  " : "OVER"} ${route}: ${kb.toFixed(1)} KB gzip (budget ${budgetKb} KB - ${source})`);
  if (!ok) {
    console.log(rows.join("\n"));
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
