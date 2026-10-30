# Dependency overrides

`pnpm.overrides` in `package.json` pins patched versions of transitive
packages whose direct requesters hold exact (or 0.x-caret) ranges that
exclude every patched release. Each selector is scoped to the vulnerable
range, so it only fires while the resolved version is vulnerable and goes
inert the moment an upstream requester bumps past it — the standing removal
condition for every line below. Delete a line once its requester's declared
range admits a patched version; nothing else changes.

Before/after audit records for this block: see the PR description and the
project's audit artifacts (2026-10-30, 41 findings → 0).

| Override | Advisory (worst) | Dependency path | Requester's declared range | Range-compatibility check | Removal condition |
|---|---|---|---|---|---|
| `undici@>=7 <7.30.1` → `7.30.1` | Multiple undici advisories (high) | `eve → just-bash → guarded-fetch → undici` | `guarded-fetch@0.1.3` pins `undici: 7.29.0` exactly | 7.30.1 is the same minor line requested (7.x); undici 7.30.1 already resolves in-tree via `@ai-sdk/provider-utils` | Delete when guarded-fetch bumps undici past 7.30.1, or just-bash/eve updates drop the exact pin |
| `undici@>=8 <8.12.2` → `8.12.2` | Multiple undici advisories (high) | `eve → undici` | `eve@0.76.3` pins `undici: 8.10.2` exactly | Same 8.x major; 8.12.2 is the patched threshold for the 8.x advisories | Delete when eve bumps undici past 8.12.2 |
| `nanoid@>=3 <3.3.18` → `3.3.20` | 5 nanoid advisories (high) | `@excalidraw/excalidraw → nanoid` (and the mermaid conversion chain) | `@excalidraw/excalidraw@0.18.1` pins `nanoid: 3.3.3` exactly | 3.3.20 is the same 3.x major and already resolves in-tree (postcss chain) | Delete when excalidraw bumps nanoid past 3.3.18 |
| `nanoid@>=4 <5.1.16` → `5.1.16` | 5 nanoid advisories (high) | Same chain, 5.x line | No 5.x instance resolves today | Defensive: matches the 5.x patched threshold if a 5.x requester appears | Delete if unneeded after the next full audit |
| `lodash-es@>=4 <4.18.1` → `4.18.1` | 3 lodash-es advisories (high) | `@excalidraw/excalidraw → @excalidraw/mermaid-to-excalidraw → @mermaid-js/parser → langium → chevrotain → lodash-es` | `chevrotain@11.0.3` pins `lodash-es: 4.17.21` exactly | 4.18.1 is the same 4.x major and already resolves in-tree (`chevrotain-allstar` requests `^4.17.21` and got 4.18.1) — same langium stack runs on it | Delete when chevrotain bumps lodash-es past 4.17.23 |
| `katex@>=0.11 <0.18.2` → `0.18.2` | katex advisory (low) | `@excalidraw/excalidraw → @excalidraw/mermaid-to-excalidraw → mermaid → katex` | `mermaid@11.17.2` requests `katex: ^0.16.47` (0.x caret — 0.18.2 is out of range) | Forced across one 0.x boundary; katex 0.18 keeps the `renderToString`/`render` API mermaid uses. Verified through the canvas/diagram consumers (see PR evidence). mermaid 11.17.2 is the newest 11.x — no upstream release supports 0.18 yet | Delete when mermaid supports katex >= 0.18 upstream |
| `esbuild@~0.18.20` → `0.25.12` | esbuild dev-server advisory (moderate) | `drizzle-kit → @esbuild-kit/esm-loader → @esbuild-kit/core-utils → esbuild` | `@esbuild-kit/core-utils@3.3.2` requests `esbuild: ~0.18.20` | Forced across 0.x minors; esbuild's transform/build API surface used by @esbuild-kit is stable across 0.19–0.25. Dev-time only (drizzle-kit tooling); 0.25.12 already resolves in-tree (drizzle-kit's own direct dep) and the database/migration suites exercise it | Delete when drizzle-kit drops the deprecated @esbuild-kit packages (it ships its own esbuild direct dep now) |
| `zod@>=4 <4.6.6` → `4.6.7` | zod advisory (high) | `@vercel/blob → @vercel/oidc → @vercel/cli-config → zod` | `@vercel/cli-config@0.3.1` pins `zod: 4.1.11` exactly | Same 4.x major (no forced major); 4.6.7 is the app's own direct zod, so this dedupes the duplicate to one resolved version | Delete when @vercel/cli-config bumps zod past 4.6.6 |
