import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Two <main> elements render on app routes (shell #content main plus the
    // route-level loading skeleton), so a bare page.locator("main") resolves
    // to 2 elements and fails CI under strict mode. Scope to "#content".
    files: ["tests/e2e/**/*.spec.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='locator'][arguments.0.value='main']",
          message: 'Bare locator("main") matches both the shell #content main and the route loading skeleton. Use locator("#content").',
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated eve dev-host artifacts (gitignored; appears after `pnpm dev`).
    "**/.eve/**",
    // Vendored agent skills: third-party scripts, not our source.
    ".claude/skills/**",
    // The Chrome companion is browser code, not part of the Next build. Its
    // libs/ are vendored (Readability, Turndown) and fail rules they predate.
    "extensions/**",
    // Scratch: gitignored by design, so CI never lints it - but `pnpm lint`
    // walks the working tree, and a local-only failure made the documented
    // gate red for anyone who had run a dev session or a skill. Linting
    // untracked scratch proves nothing about the source that ships.
    ".superpowers/**",
    ".gstack/**",
    ".run/**",
  ]),
]);

export default eslintConfig;
