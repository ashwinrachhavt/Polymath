import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // The repo marks a deliberately unused binding with a leading underscore
    // (`_request`, `_toolkitSlug`, `_statement`) — 50-odd call sites use it,
    // mostly callbacks whose position is fixed by a framework signature. Teach
    // the rule the convention so those stop reading as dead code.
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
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
          message:
            'Bare locator("main") matches both the shell #content main and the route loading skeleton. Use locator("#content").',
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
    // Parallel-agent git worktrees (gitignored, so CI never sees them). Each
    // holds another branch's checkout plus its generated .next/types, and
    // `pnpm lint` walks the working tree - so linting them reported another
    // branch's in-progress code as this branch's errors.
    ".claude/worktrees/**",
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
