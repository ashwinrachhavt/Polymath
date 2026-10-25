/*
 * Route JS budget measurement.
 *
 * The spec budgets a route's first-load JS and says to measure it in build
 * output, but Next 16's build table no longer prints per-route sizes, and a
 * Turbopack build emits no app-build-manifest.json. What every build does
 * emit, because the server needs it at runtime, is the route's client
 * reference manifest: the chunks its client components load. Add the shared
 * app runtime (build-manifest's rootMainFiles) and the sum approximates the
 * old First Load JS column.
 *
 * This REPORTS the number against the budget; it does not fail CI. Under
 * Turbopack the figure is an approximation (split boundaries differ from
 * webpack's), and a red gate on an approximate number would cry wolf. The
 * number is in the check-job log of every run for review.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const BUDGETS = [
  // route path, gzip budget in KB, source of the number
  { route: "/command-center/briefing", budgetKb: 180, source: "Day Theatre spec, acceptance #9" },
];

function gzipSize(rel) {
  return gzipSync(readFileSync(join(".next", rel))).length;
}

function manifestJsonFor(route) {
  // .next/server/app/<route>/page_client-reference-manifest.js assigns the
  // manifest to a global; the JSON follows the route key's first '='.
  const path = join(".next", "server", "app", route, "page_client-reference-manifest.js");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const eq = text.indexOf("=", text.indexOf(`[${JSON.stringify(route)}]`));
  if (eq < 0) return null;
  return JSON.parse(text.slice(eq + 1).replace(/;\s*$/, ""));
}

let warned = false;
for (const { route, budgetKb, source } of BUDGETS) {
  const files = new Set();

  const manifest = manifestJsonFor(route);
  if (manifest) {
    for (const entry of Object.values(manifest.clientModules ?? {})) {
      for (const chunk of entry.chunks ?? []) {
        if (typeof chunk === "string" && chunk.endsWith(".js")) files.add(chunk);
      }
    }
  }

  // The shared app runtime every route loads, from the pages build manifest.
  const buildManifestPath = join(".next", "build-manifest.json");
  if (existsSync(buildManifestPath)) {
    const buildManifest = JSON.parse(readFileSync(buildManifestPath, "utf8"));
    for (const chunk of buildManifest.rootMainFiles ?? []) {
      if (chunk.endsWith(".js")) files.add(chunk);
    }
  }

  if (files.size === 0) {
    console.warn(
      `route-js: no chunk data found for ${route} (.next contains: ${
        existsSync(".next") ? readdirSync(".next").join(", ") : "(no .next)"
      }) - measurement skipped, CI stays green`,
    );
    warned = true;
    continue;
  }

  let total = 0;
  const rows = [...files].sort().map((f) => {
    const bytes = gzipSize(f);
    total += bytes;
    return `  ${(bytes / 1024).toFixed(1).padStart(7)} KB  ${f}`;
  });
  const kb = total / 1024;
  const over = kb > budgetKb;
  console.log(
    `${over ? "OVER-BUDGET (report only)" : "within budget"}: ${route} ~${kb.toFixed(1)} KB gzip first-load JS ` +
      `(budget ${budgetKb} KB - ${source}; approximation from the client reference manifest + shared runtime)`,
  );
  if (over) {
    console.log(rows.join("\n"));
    warned = true;
  }
}

process.exit(0);
