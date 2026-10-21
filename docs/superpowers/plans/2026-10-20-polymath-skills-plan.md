# Polymath Skills — implementation plan

**Spec:** `docs/superpowers/specs/2026-10-20-polymath-skills-design.md` (binding authority)
**Issue:** ASH-200
**Branch:** `ash-200-skills`

## Global Constraints

These bind every task. A change that violates one is a defect regardless of what a task
says.

1. **TypeScript strict, no `any`, no non-null assertions on provider data.** Parse every
   external payload with Zod at the boundary (`src/domains/skills/sources/*`) and pass
   typed values inward.
2. **Every owned table carries `workspace_id`**, and every query is scoped by
   `AuthContext`. A client never supplies the workspace.
3. **Mutations are server actions**, ordered: authenticate → resolve `AuthContext` → parse
   input → domain command → audit in the same transaction → revalidate cache tags.
   `requireRole(auth, "member")` for every write on this surface.
4. **Nothing fetched from a network or read from disk is executed.** No `eval`, no `sh`,
   no dynamic `import()` of imported content, no package lifecycle scripts.
5. **Provider/model text is untrusted.** Imported skill bodies are stored as data. They are
   never interpolated into SQL, shell, filesystem paths, or used to authorise a tool.
6. **One error shape.** Server actions throw `Error` with a sentence a person can act on;
   route handlers return `problemResponse`. Error copy names what failed and how to
   recover, never apologises.
7. **Naming is the product's vocabulary:** *skill*, *source*, *run*. Never "specialist",
   never "hire" on the new surface.
8. **Sentence case, plain verbs, no exclamation marks** in all user-facing copy
   (`agents/product.md` § Voice).
9. **Forward-only migrations.** New migration file only; never edit `0221` or earlier.
   Register it in `src/db/migrations/meta/_journal.json` with the next `idx`.
10. **Tests run against real Postgres** for invariants (unique identity, workspace
    isolation, idempotency). No live network in CI.
11. **`pnpm check` passes** (lint, typecheck, test, build) before any task is called done.
12. **No new dependency** except `modern-tar` in Task 3, and the commit message must say
    why (`tar`'s API writes to disk; this walks an in-memory buffer).

## Task order and interfaces

Task 1 produces the table and domain module every later task imports. Task 2 produces
`inspectSource()` returning `InspectedSkill[]`, which Task 3's adapters implement and
Task 6's actions call. Task 4's pin travels through Task 5's token. Task 6's surface
consumes Tasks 1, 2, 4. Task 7 is the acceptance gate.

---

## Task 1: The skills table, schema module, and domain queries

**Files created:** `src/domains/skills/schema.ts`, `src/domains/skills/queries.ts`,
`src/domains/skills/commands.ts`, `src/db/migrations/0225_skills.sql` (numbered 0222 when written; renumbered 0225 at merge because main landed 0222–0224 first).
**Files touched:** `src/db/migrations/meta/_journal.json`.

Add the `skills` table exactly as the spec's Data model section defines it, using
`primaryId()`, `tenantId()`, and `mutable` from `src/db/columns.ts` so the column shape
matches every other tenant table. Use a `check` constraint for `source_kind`, matching the
style in `src/domains/agents/schema.ts`.

Export from `schema.ts`:

```ts
export const skillSourceKinds = ["github", "local", "bundled"] as const;
export type SkillSourceKind = (typeof skillSourceKinds)[number];
export const skills = pgTable("skills", { /* … */ });
export type Skill = typeof skills.$inferSelect;
export type SkillFile = { path: string; text: string };
```

`queries.ts` exports, all workspace-scoped:

```ts
listSkills(auth: { workspaceId: string }, filter?: { enabled?: boolean }): Promise<Skill[]>
getSkill(auth: { workspaceId: string }, id: string): Promise<Skill | null>
getSkillBySlug(auth: { workspaceId: string }, slug: string): Promise<Skill | null>
/** Used by the Eve resolver. Returns the body, description and files for one workspace-scoped id. */
loadPinnedSkill(workspaceId: string, skillId: string): Promise<{ description: string; body: string; files: SkillFile[] } | null>
```

`commands.ts` exports:

```ts
installSkill(auth: AuthContext, input: InspectedSkill & { sourceKind: SkillSourceKind; sourceRef: string; sourcePath: string; revision: string }): Promise<{ skillId: string; created: boolean }>
setSkillEnabled(auth: AuthContext, input: { id: string; enabled: boolean }): Promise<{ updated: boolean }>
removeSkill(auth: AuthContext, input: { id: string }): Promise<{ removed: boolean }>
```

`installSkill` inserts with `onConflictDoNothing()` on the identity index and reads back on
conflict, so a double submit returns the existing row. It calls `recordAudit` in the same
transaction with action `skill.installed` and subject type `skill`. `removeSkill` is a hard
delete of the row, and calls `recordAudit` with `skill.removed` **before** the delete, in
the same transaction; run history lives in `agent_runs.policy_snapshot`, not in this table,
so provenance survives.

`src/domains/skills/manifest.ts` also defines the shared type (created in this task, used
by every later one):

```ts
export type InspectedSkill = {
  name: string;
  slug: string;
  description: string;
  body: string;
  files: SkillFile[];
  warnings: string[];
  contentHash: string;
};
```

For this task `InspectedSkill` may be declared in `manifest.ts` with no producer yet;
Task 2 supplies `inspectSource()` which returns `InspectedSkill[]`.

**Migration:** `0225_skills.sql` with the DDL from the spec, statements separated by
`--> statement-breakpoint` as in `0221_hybrid_search_ontology.sql`. Journal entry `idx:
222`.

**Tests** — `tests/integration/skills-registry.test.ts`, against real Postgres via
`tests/helpers/test-workspace.ts`:

1. Installing the same identity twice inserts one row and the second call returns
   `created: false` with the same id.
2. The same `source_ref` with a different `source_path` inserts a second row.
3. Two workspaces can each hold the same identity (workspace isolation).
4. `removeSkill` deletes the row and writes a `skill.removed` audit row.
5. `listSkills` with `{ enabled: true }` omits a disabled skill.
6. `loadPinnedSkill` returns `null` for an id in another workspace.

**Acceptance check:** `pnpm vitest run tests/integration/skills-registry.test.ts` passes,
and `pnpm typecheck` passes.

---

## Task 2: The source protocol, the command parser, and inspection orchestration

**Files created:** `src/domains/skills/sources/types.ts`,
`src/domains/skills/sources/command.ts`, `src/domains/skills/inspect.ts`,
`src/domains/skills/package.ts`.

`types.ts`:

```ts
export type SourceRequest =
  | { kind: "github"; owner: string; repo: string; ref?: string; path?: string }
  | { kind: "local"; root: string; path?: string };

export type InspectResult =
  | { ok: true; sourceKind: "github" | "local"; sourceRef: string; revision: string; skills: InspectedSkill[]; warnings: string[] }
  | { ok: false; code: InspectFailureCode; message: string };

export type InspectFailureCode =
  | "unsupported_input" | "unsafe_command" | "not_found" | "private_repo"
  | "rate_limited" | "timeout" | "too_large" | "no_skill_found"
  | "unsafe_path" | "invalid_metadata";
```

`command.ts` exports `parseSkillCommand(input: string): SourceRequest | { error: string }`.

It accepts **only** `npx skills add <owner>/<repo>` optionally followed by
`--path <value>`, allowing leading/trailing whitespace. It must reject, with a specific
message naming the offending token and suggesting the safe form:

- any of `;`, `&&`, `||`, `|`, `>`, `<`, `` ` ``, `$(`,
- any executable other than `npx`,
- any flag other than `--path`,
- an argument that is not `owner/repo` (no URL, no scp form, no `..`).

Return `{ kind: "github", owner, repo, path }` on success. The parser **never** shells out.

`package.ts` exports:

```ts
export type PackageFile = { path: string; bytes: Uint8Array };
/** Find every SKILL.md package in a flat path→bytes map, validating names and metadata. */
export function extractPackages(files: Map<string, PackageFile>): { skills: InspectedSkill[]; warnings: string[] }
export function contentHashOf(skill: InspectedSkill): string
```

Rules: a package is a directory containing `SKILL.md`. `description` is required for a
packaged skill (Eve's rule); a missing description is `invalid_metadata`. The skill name is
the directory name, lowercased, non-alphanumerics collapsed to `-`, and must match
`/^[a-z0-9][a-z0-9_-]{0,63}$/` after slugging. Files over 128 KB or non-UTF-8 are recorded
in `warnings` and omitted from `files`. More than 64 files or 512 KB total is
`too_large`. Symlinks and paths containing `..`, absolute paths, and NUL bytes are
`unsafe_path`.

`inspect.ts` exports:

```ts
export function parseSource(input: string): SourceRequest | { error: string }
export async function inspectSource(request: SourceRequest): Promise<InspectResult>
```

`parseSource` first tries `parseSkillCommand`, then a GitHub URL in the forms
`github.com/{owner}/{repo}`, `…/tree/{ref}/{path}`, `…/blob/{ref}/{path}/SKILL.md`, then
treats anything else as a local path candidate (resolved and validated in Task 3).

`inspectSource` dispatches to the adapter for the request kind. Task 2 ships the dispatch
and a `github`/`local` branch that throws `new Error("adapter not implemented")`; Task 3
fills them. Tests in Task 2 cover the parser, `extractPackages`, and `contentHashOf` only —
they must not depend on Task 3.

**Tests** — `tests/unit/skills-command.test.ts` and `tests/unit/skills-package.test.ts`:

- `parseSkillCommand`: accepts the plain form and the `--path` form; rejects each of
  `; rm -rf /`, `&& curl evil`, `| sh`, `$(whoami)`, `` `id` ``, `npx other add x/y`,
  `npx skills add --force x/y`, and `npx skills add https://…`.
- `extractPackages`: finds two packages in a two-directory tree; rejects a package missing
  `description`; rejects `../outside/SKILL.md`; rejects an absolute path; warns and omits a
  200 KB file; rejects 65 files with `too_large`; a path byte-identical package produces
  the same `contentHash` regardless of map insertion order.

**Acceptance check:** `pnpm vitest run tests/unit/skills-command.test.ts
tests/unit/skills-package.test.ts` passes.

---

## Task 3: GitHub tarball and local folder adapters

**Files created:** `src/domains/skills/sources/github.ts`,
`src/domains/skills/sources/local.ts`, `tests/fixtures/skills-repo.tar.gz`.
**Files touched:** `src/domains/skills/inspect.ts` (wire the adapters), `package.json`
(add `modern-tar`).

`github.ts` exports `inspectGithub(request: Extract<SourceRequest, {kind:"github"}>):
Promise<InspectResult>`:

1. Resolve `ref` (default: the repo's default branch) to a commit SHA by calling
   `https://api.github.com/repos/{owner}/{repo}/commits/{ref}` through `safeFetch` from
   `src/lib/safe-fetch.ts`, reading only the top-level `sha`. Map 404 to `not_found`, 401/403
   to `private_repo` (v1 has no credentials), 403 with a rate-limit body to `rate_limited`.
2. Fetch `https://codeload.github.com/{owner}/{repo}/tar.gz/{sha}` through `safeFetch` with
   `maxBytes: 5 * 1024 * 1024`. A timeout maps to `timeout`; an oversize body to `too_large`.
3. Untar in memory with `modern-tar`'s web entry (`modern-tar`), stripping the leading
   `{repo}-{sha}/` directory. Reject any entry that is a symlink, a hardlink, a device, or
   whose name is absolute or contains `..` → `unsafe_path`. Reject more than 200 entries →
   `too_large`.
4. If `request.path` is set, restrict the map to that subtree before calling
   `extractPackages`; a path that matches nothing is `no_skill_found`.
5. Return `{ ok: true, sourceKind: "github", sourceRef: `${owner}/${repo}`, revision: sha,
   skills, warnings }`.

No `fs`, no temp directory, no shell.

`local.ts` exports `inspectLocal(request: Extract<SourceRequest, {kind:"local"}>):
Promise<InspectResult>`:

1. `root = process.env.SKILLS_LOCAL_ROOT ?? join(homedir(), "Projects")`.
2. Resolve `realpath(request.root)`; it must equal or be under `realpath(root)` after
   normalisation, else `unsafe_path`. `realpath` is what defeats a symlinked escape.
3. Walk with `readdir` + `lstat`, **not** following symlinks (`withFileTypes`, skip
   `isSymbolicLink()`), bounded to 200 files and 5 MB total.
4. `sourceRef` is the absolute real path; `revision` is `contentHashOf` over the combined
   packages.

**Fixture:** `tests/fixtures/skills-repo.tar.gz`, a small tarball with `repo/README.md`,
`repo/skills/research/SKILL.md` (frontmatter `description`, body, one
`references/checklist.md` sibling). Build it once with `tar czf`; it is checked in. Tests
read the file, not the network.

**Tests** — `tests/unit/skills-sources.test.ts`:

- GitHub: the fixture tarball through the untar → `extractPackages` path yields one skill
  named `research` whose `files` include `references/checklist.md`. (Test the untar step
  directly against the fixture bytes; do not call the network.)
- GitHub: a tarball entry named `repo/../../etc/passwd` yields `unsafe_path`.
- GitHub: a tarball with a symlink entry yields `unsafe_path`.
- Local: a fixture directory under a temp root yields one skill; `sourceRef` is the realpath.
- Local: a path outside `SKILLS_LOCAL_ROOT` yields `unsafe_path` (set the env var to a temp
  dir for the test).
- Local: a symlink inside the root pointing outside it is skipped, and the walk does not
  read through it.

**Acceptance check:** `pnpm vitest run tests/unit/skills-sources.test.ts` passes.

---

## Task 4: Run pinning — policy snapshot and start route

**Files touched:** `src/domains/agents/engine.ts`, `src/app/api/v1/runs/route.ts`,
`src/domains/agents/queries.ts` (if a run-fetch helper is needed to render history).

`PolicySnapshot` gains an optional field:

```ts
/** The skill this run is pinned to. Frozen at start; a later skill edit cannot change it. */
skill?: { id: string; revision: string; contentHash: string; name: string };
```

`engine.start` accepts `skillId?: string`. When present it loads the skill through
`getSkill` scoped to `input.auth.workspaceId`; a missing or disabled skill throws
`new Error("That skill is not available. Enable it in Skills and try again.")`. The loaded
skill's `{ id, revision, contentHash, name }` is written into the policy snapshot object
before the row is inserted, so it is frozen by the same insert.

`POST /api/v1/runs` accepts `skillId: z.string().uuid().optional()`, threaded to
`engine.start`. The idempotency receipt hash must include `skillId` (add it to the hashed
array) so the same key with a different skill is a 422, matching the existing rule.

**Tests** — `tests/integration/skills-run-pin.test.ts`:

1. Starting with a valid `skillId` produces a run whose `policy_snapshot.skill` has the
   skill's id, revision and content hash.
2. Editing the skill's `body` afterwards leaves the stored snapshot unchanged.
3. Starting with a disabled skill throws and creates no run row.
4. Starting with a `skillId` from another workspace throws and creates no run row.
5. Re-using an idempotency key with a different `skillId` returns 422.

**Acceptance check:** `pnpm vitest run tests/integration/skills-run-pin.test.ts` passes.

---

## Task 5: Bridge token claims and the Eve skill resolver

**Files touched:** `src/domains/agents/bridge-token.ts`,
`src/domains/agents/eve-driver.ts`,
`eve/alfred/agent/channels/eve.ts`.
**Files created:** `eve/alfred/agent/skills/polymath_skill.ts`,
`tests/unit/bridge-token-skills.test.ts`.

`BridgeClaims` gains `runId?: string; skillId?: string`. `Payload` gains `rid?: string;
skid?: string`. `signBridgeToken` includes them only when present. `verifyBridgeToken`
validates that, when present, they are strings, and returns them in `BridgeClaims`.

`eve-driver.ts`: `SessionDriver.start` already receives `policy`; read
`policy.skill?.id` and pass `skillId` plus the run's own id into `signBridgeToken`.

`eve/alfred/agent/channels/eve.ts`: add `runId` and `skillId` to the returned
`attributes`.

`eve/alfred/agent/skills/polymath_skill.ts`: exactly the resolver in the spec, importing
`loadPinnedSkill` from `../../../../src/domains/skills/queries` (relative, as eve's bundle
cannot resolve the `@/` alias — see the comment in `hooks/bridge.ts`).

**Tests:**

- `tests/unit/bridge-token-skills.test.ts`: a token signed with `runId` and `skillId` round-
  trips them; a token signed without them omits the keys; a tampered `skid` fails
  verification.
- Extend `tests/unit/bridge-token.test.ts` only if its existing shape requires it.

**Acceptance check:** `pnpm vitest run tests/unit/bridge-token-skills.test.ts
tests/unit/bridge-token.test.ts` passes, and `pnpm typecheck` passes (this proves the eve
resolver's imports resolve).

---

## Task 6: The Skills surface and the Assist integration

**Files created:** `src/app/(workspace)/alfred/skills/page.tsx`,
`src/app/(workspace)/alfred/skills/[id]/page.tsx`,
`src/app/(workspace)/alfred/skills/actions.ts`,
`src/app/(workspace)/alfred/skills/add-skill-form.tsx`,
`src/app/(workspace)/alfred/skills/skill-controls.tsx`,
`src/app/(workspace)/alfred/skills/skill-picker.tsx`,
`src/app/(workspace)/alfred/specialists/page.tsx` (redirect only).
**Files deleted:** `src/app/(workspace)/alfred/specialists/actions.ts`,
`src/app/(workspace)/alfred/specialists/specialist-controls.tsx`,
`src/domains/agents/roster.ts`, `src/domains/agents/specialists.ts`.
**Files touched:** `src/lib/navigation.ts`, `src/app/(workspace)/alfred/start-run-form.tsx`.

- `navigation.ts`: replace the Specialists destination with
  `{ href: "/alfred/skills", label: "Skills", purpose: "Give the assistant a procedure to follow.", icon: Library }` — keep it in the same array position so the rail order does not shift.
- `specialists/page.tsx` becomes a `redirect("/alfred/skills")` server component.
- Page: server component, `await connection()`, mirrors the shape of the deleted
  specialists page (PageHeader + Section + EmptyState + ListToolbar). Sections: **Add a
  skill**, **My skills**, **Discover**. Filter Ready/Disabled. Empty state offers "Add a
  skill" with a one-line example.
- Detail page: procedure in a `<pre className="whitespace-pre-wrap">`, file list, source +
  revision + hash + install time, warnings, readiness, recent runs that used it (query
  `agent_runs` where `policy_snapshot->'skill'->>'id' = $1`).
- `actions.ts`: `inspectSkillAction`, `installSkillAction`, `setSkillEnabledAction`,
  `removeSkillAction`. All `requireRole(auth, "member")`, Zod-parsed, and revalidate
  `/alfred/skills`.
- `skill-picker.tsx`: client island added to `start-run-form.tsx`, a `<select>` of enabled
  skills whose value posts as `skillId`. When a skill is chosen, the textarea placeholder
  becomes "Describe what to do with this skill."
- All new copy follows `agents/product.md` § Voice. No "specialist", no "hire".

**Tests** — `tests/integration/skills-surface.test.ts`:

- `inspectSkillAction` returns discovered skills for a fixture local directory without
  writing a row.
- `installSkillAction` writes exactly one row for a double submit with the same input.
- `removeSkillAction` deletes the row and leaves an `agent_runs` row that referenced it
  intact (seed a run first through `engine.start`).

**Acceptance check:** `pnpm vitest run tests/integration/skills-surface.test.ts` passes and
`pnpm build` succeeds.

---

## Task 7: The acceptance gate

No new product code. This task proves the ticket's happy path end to end and writes down
what it saw.

Run and record in the PR description:

1. `pnpm check` — lint, typecheck, test, build.
2. A scripted walk against a local dev server with a local Postgres: create workspace →
   import the fixture local directory through `installSkillAction` → list shows it Ready →
   start a run with `skillId` → assert the run's `policy_snapshot.skill.revision` matches
   the skill's `revision` → disable it → assert it is absent from the enabled list while
   the run still reads back.
3. `pnpm vitest run` full suite.

If the dev server is not reachable in this environment, state that plainly in the PR
description rather than claiming a UI verification that did not happen.

**Acceptance check:** the four commands above have been run and their output is in the PR
description.
