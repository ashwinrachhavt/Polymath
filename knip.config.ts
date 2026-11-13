/*
 * Knip: unused files, exports, and dependencies in one report. Run via
 * `pnpm knip` locally; enforced in CI on every PR (see .github/workflows/ci.yml).
 * The npm script exports a dead-port DATABASE_URL first: the drizzle plugin
 * loads drizzle.config.ts, which refuses to read without the variable set, and
 * nothing here connects (the same trick the CI drift gate uses).
 *
 * Everything not spelled out here follows the defaults plus knip's plugins for
 * the tooling this repo already configures (next, vitest, playwright, tsx,
 * typescript, eslint, prettier, drizzle, tailwind, github-actions). The Next
 * plugin owns the app-router and API-route entry patterns and knows Next 16's
 * proxy.ts; the vitest and playwright plugins own tests/. What needs an
 * explicit reason below is the exception, not the rule.
 */
const config = {
  entry: [
    // The chrome extension is loaded by the browser from manifest.json, not
    // imported by the app graph — knip has no extension plugin, so the
    // manifest-referenced surfaces are entries by hand. HTML files load their
    // own script tags (api.js appears in three of them), the content_scripts
    // list names libs/ plus the widget css, and the popups link their css.
    "extensions/chrome/manifest.json",
    "extensions/chrome/*.html",
    "extensions/chrome/*.css",
    // focus-block.js is script-tag-loaded by focus-block.html and
    // focus-blocker.js importScripts-loaded by background.js (MV3 service
    // workers resolve neither through the module graph).
    "extensions/chrome/{api,background,content,dashboard,extract,focus-block,focus-blocker,popup,sidepanel}.js",
    "extensions/chrome/libs/{readability,turndown}.js",

    // Operator scripts invoked from the Makefile (queue-up, eve-up) or run by
    // hand as documented in their headers and call-site comments — knip cannot
    // see Makefile targets and there is no package.json script for these.
    "scripts/eve-dev.ts",
    "scripts/outbox-worker.ts",
    "scripts/sync-instant-catalog.ts",
    // The grader eval is run by hand against a provider; it writes its numbers
    // to stdout for the owner to set the bar against.
    "scripts/grader-eval.mts",
    // Run by hand inside the Oracle VM's web container (deploy/oracle/README.md).
    "deploy/oracle/check-env.ts",

    // Claude Code launches the Polymath plugin's hook script as a process from
    // hooks.json; nothing imports it. The MCP server is the polymath-mcp script.
    "plugins/polymath/hooks/understanding-hook.mjs",

    // The eve agent trees are compiled by the eve runner against root src —
    // through relative paths and the root tsconfig's @/ alias — so their
    // module graphs reach into src/domains and mark everything they consume
    // live.
    "eve/polymath/agent/**",
    "eve/specialist/agent/**",
  ],

  // Optional ground-truth layer of the langfuse-redis healthcheck unit test:
  // the real-server case skips itself where the binaries are absent, so they
  // are runtime-optional and not project dependencies.
  ignoreBinaries: ["redis-server", "redis-cli"],
};

export default config;
