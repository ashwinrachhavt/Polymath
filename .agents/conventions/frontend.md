# React and Next.js application boundaries

Applies when changing routes, Server/Client Components, hooks, UI state, editors, or browser behavior. Use [engineering principles](engineering.md), [API protection](api.md), and the installed Next.js version's own docs when relevant. Prefer the app's existing primitives over introducing another UI or data-fetching framework.

## Render and data ownership

- Default to Server Components for reads and composition; use Client Components for actual interaction, browser APIs, or local UI state. Keep client boundaries as small as is practical.
- Resolve authenticated, workspace-scoped data on the server through the owning domain. Props, URL parameters, cached results, and client-side guards do not grant access.
- Keep route components and server actions thin: validate and authorize inputs, call domain operations, then map results into UI/transport representations. Do not duplicate domain query rules inside JSX.
- Distinguish server-backed state from ephemeral UI state. Derive values during rendering when possible; do not mirror props or derived values into effects and synchronized state without a real requirement.
- Make loading, empty, denied, error, pending, and completed states truthful and accessible. A spinner or optimistic update is not proof that a write succeeded.
- Use the existing accessible components and semantic HTML first. Every interaction should have a keyboard path, useful name, and predictable focus behavior; test real interaction, not just snapshots.

## Performance and lifecycle

- Prevent accidental sequential awaits for independent reads; parallelize only when their authorization and failure semantics permit it. Avoid N+1 data fetches and repeated client/server round trips.
- Keep heavyweight editors and visualizations (such as Excalidraw or React Flow) off unrelated initial paths when lazy loading demonstrably improves the user experience.
- Use state and effect lifecycles intentionally: subscribe with cleanup, cancel or ignore stale work, and avoid effects for event-driven actions that belong in handlers.
- Do not apply memoization, caching, dynamic imports, or custom hooks automatically. Name the measured problem and make cache scope, invalidation, and error behavior explicit.
- Preserve URL/navigation semantics and progressive enhancement where possible. Use links for navigation and buttons for actions; avoid custom JavaScript where browser behavior suffices.
- Verify behavior across loading and errors, not only a successful screenshot. Use existing UI tests and targeted Playwright flows where appropriate.

## Version and verification

- This repository uses Next.js 16 and React 19; do not rely on remembered framework APIs. Consult `node_modules/next/dist/docs/` and current project examples before adopting framework-specific features.
- Follow the actual `package.json`, `eslint.config.mjs`, and test configuration rather than copying a generic style guide. For UI work, run relevant type/lint/UI checks and inspect rendered behavior when tooling permits.
- For high-impact Next/React performance changes, consult [Vercel's React best practices](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices) selectively; do not paste its entire rulebook into always-loaded instructions.
