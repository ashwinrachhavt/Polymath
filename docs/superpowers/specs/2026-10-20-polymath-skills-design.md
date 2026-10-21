# Polymath Skills — local-first import, management, and Eve invocation

**Issue:** ASH-200
**Date:** 2026-10-20
**Status:** approved in session; this document is the authority the implementation plan argues from.

## Outcome

Replace the Specialists roster with a Skills library. A person imports a skill from a
GitHub URL, a supported `npx skills add …` command, or a local folder; inspects what was
found before anything is stored; enables or disables it; invokes it explicitly from the
Assist page; and sees which run used which revision. A skill supplies a procedure, never
authority.

## Verified baseline (ASH-200 WP1)

Checked against the installed tree, not memory:

- **Eve `0.76.3`** (`node_modules/eve`). Supports `agent/skills/*/SKILL.md` (static,
  compiled in, restart to pick up) and `defineDynamic` skill resolvers keyed on
  `ctx.session.auth` at `session.started` / `turn.started`, returning `defineSkill(...)`
  or `null`. `node_modules/eve/docs/skills.mdx`,
  `docs/guides/dynamic-capabilities.md#dynamic-skills`.
- **The bridge token already carries identity.** `src/domains/agents/bridge-token.ts`
  signs `{ userId, workspaceId, role }` with `EVE_BRIDGE_SECRET`, 60s TTL.
  `eve/alfred/agent/channels/eve.ts` verifies it and places `workspaceId` in session
  attributes.
- **Eve tools already read Postgres.** `eve/alfred/agent/tools/documents_search.ts`
  imports `src/domains/agents/queries` directly.
- **Runs freeze policy.** `agent_runs.policy_snapshot` is written at start and never
  updated (`src/domains/agents/engine.ts`). `agent_runs.session_ref` holds Eve's id.
- **The current surface** is `src/app/(workspace)/alfred/specialists/` (page, actions,
  controls) over `src/domains/agents/roster.ts` (30 roles) materialised into
  `agent_profiles` rows.

## Decisions taken (deviating from the ticket where evidence did not support it)

1. **Skills load through a dynamic resolver, not a filesystem copy.** ASH-200's WP4/WP6
   assume atomic install into `eve/alfred/agent/skills/` plus restart. Eve 0.76.3's dynamic
   skills make that unnecessary and strictly worse: a filesystem copy is process-global
   (no workspace isolation), requires a restart to take effect, and cannot pin a run to a
   revision. Skills therefore live in Postgres and a resolver returns exactly the run's
   pinned skill. **Cost if wrong:** if a later Eve version drops dynamic skills, the
   install path moves to compiled static files; the record and surface are unaffected.
2. **Explicit invocation only.** A skill is loaded only when the person pinned it to the
   run. No description-based suggestion, no model routing. **Cost if wrong:** discovery
   is manual until a suggestion affordance is designed.
3. **The roster is hidden, not deleted.** `roster.ts` and the Specialists route are
   removed from the product; `/alfred/specialists` redirects. `agent_profiles` rows named
   `specialist:*` and their runs stay in the database and stay readable. **Cost if wrong:**
   nothing is lost; the roster can be restored from git.
4. **GitHub import fetches a tarball over HTTPS**, not `git clone`. It resolves the
   branch head to a commit SHA, fetches `codeload.github.com`, and walks the archive in
   memory through the existing SSRF-guarded `src/lib/safe-fetch.ts`. **Cost if wrong:** a
   repo using submodules or LFS yields an incomplete package, which inspection reports as
   a warning rather than a silent gap.
5. **Local import takes a server-side path inside an allowlist root**
   (`SKILLS_LOCAL_ROOT`, default `~/Projects`), not an OS folder-picker dialog.
   **Cost if wrong:** a hosted deployment cannot use local import at all; it is a
   development-workflow feature, as the ticket scopes it.
6. **Inspect is stateless.** Inspection returns discovered packages to the client; install
   re-fetches the pinned revision. No staging directory exists between the two calls.
   **Cost if wrong:** a large repo is fetched twice.

## Data model

New domain `src/domains/skills/`. One migration, `src/db/migrations/0222_skills.sql`.

```sql
create table skills (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  slug text not null,
  name text not null,
  description text not null,
  body text not null,
  files jsonb not null default '[]',
  source_kind text not null check (source_kind in ('github','local','bundled')),
  source_ref text not null,
  source_path text not null,
  revision text not null,
  content_hash text not null,
  enabled boolean not null default true,
  warnings jsonb not null default '[]',
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  version integer not null default 1
);
create unique index skills_identity_key on skills (workspace_id, source_kind, source_ref, source_path);
create index skills_workspace_enabled_idx on skills (workspace_id, enabled);
```

- **Stable identity** is `(workspace_id, source_kind, source_ref, source_path)`. Display
  name and slug can change; identity cannot.
- `files` is `[{ path, text }]`, text only. Limits: ≤ 64 files, ≤ 128 KB each, ≤ 512 KB
  total. A binary file is recorded as a warning and not stored.
- `revision` is the resolved commit SHA for GitHub and the content hash for local.
- `content_hash` is sha256 over the normalised package (sorted paths + bytes), so
  re-importing identical content is detectable without comparing blobs.

A run pins `skillId`, `revision`, `contentHash` inside `agent_runs.policy_snapshot.skill`.
That object is frozen at start, so a later edit to a skill cannot change a past run.

## Loading into Eve

`BridgeClaims` gains optional `runId` and `skillId`; `signBridgeToken` signs them and
`eve/alfred/agent/channels/eve.ts` copies them into session attributes. Both ends are in
this repo and change together.

New file `eve/alfred/agent/skills/polymath_skill.ts`:

```ts
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const attrs = ctx.session.auth.current?.attributes;
      const skillId = attrs?.skillId;
      const workspaceId = attrs?.workspaceId;
      if (typeof skillId !== "string" || typeof workspaceId !== "string") return null;
      const skill = await loadPinnedSkill(workspaceId, skillId);
      return skill
        ? defineSkill({ description: skill.description, markdown: skill.body, files: skill.files })
        : null;
    },
  },
});
```

Skills are declared on the **alfred** agent only. Skill prose cannot widen tools: the tool
list still comes from `policySnapshot.allowedTools` and is checked by
`eve/alfred/agent/lib/policy.ts`.

Because the pin travels in the signed token rather than in a row written after session
creation, there is no `session.started` race of the kind the specialist brief has.

## Import

Three adapters in `src/domains/skills/sources/`, each returning `InspectedSkill[]` plus
diagnostics, none executing anything:

| Adapter | Accepts | Rejects |
|---|---|---|
| `github.ts` | `github.com/{owner}/{repo}`, `…/tree/{ref}/{path}`, `…/blob/{ref}/{path}/SKILL.md` | any other host; repo > 5 MB; > 200 files; absolute paths; `..` segments; symlinks; device files; non-UTF-8 |
| `command.ts` | `npx skills add <owner>/<repo>` with optional `--path <p>` | pipes, `;`, `&&`, `\|\|`, `$(`, backticks, other executables, unknown flags — each with a named reason and the safe equivalent to paste |
| `local.ts` | a directory under `SKILLS_LOCAL_ROOT` | paths outside the root; symlinks escaping the package; oversized files |

A package is any `SKILL.md` with valid frontmatter (`description` required for packaged
skills, per Eve's rules). A repo with several packages returns them all for selection.

## Surface

`/alfred/skills` replaces `/alfred/specialists`. Nav label `Skills`, purpose "Give the
assistant a procedure to follow."

- **My skills** — filter Ready / Needs setup / Disabled. Card: name, description, source,
  revision (short), file count, `Use skill`.
- **Skill detail** `/alfred/skills/[id]` — procedure text, file list, source + revision +
  hash + install time, warnings, capability requirements and readiness, recent runs.
- **Add skill** — paste a URL or command, Inspect, choose packages, Install. Local folder
  path is a second input.
- **Discover** — three bundled examples shipped with the app; no marketplace.
- **Use skill** posts to the existing `POST /api/v1/runs` with `{ objective, skillId }`.
  No new run path. The Assist composer gains a skill picker using the same field.

Readiness vocabulary from the ticket: `Ready`, `Needs connection`, `Needs account
selection`, `Unsupported requirement`, `Disabled`, `Restart required`. In this slice only
`Ready`, `Disabled`, `Needs connection` and `Unsupported requirement` can occur.

## Errors

Named, never blank: bad URL (says what was wrong), private repo (auth unavailable in v1,
stated plainly), 404, rate limit, timeout, no `SKILL.md`, several packages, already
installed, oversized (names the limit), unsafe path or symlink (names the path).

## Tests

- Unit: each parser's allowlist and rejection set; traversal, symlink, oversized, binary.
- Tarball walk against a checked-in sanitized fixture. Never a live network call in CI.
- Integration against real Postgres: unique install identity, idempotent re-import,
  workspace isolation, disable preserves runs, remove preserves provenance.
- Playwright: import fixture → inspect → install → use → run shows pinned revision →
  disable → gone from picker, history intact.

## Out of scope

npm importer (WP11), update/diff, repair, hosted distribution (WP12), curated marketplace,
skill-provided tools or authority, executing package scripts or binaries.

## Deleted

`src/domains/agents/roster.ts`; `src/app/(workspace)/alfred/specialists/{page.tsx,
actions.ts, specialist-controls.tsx}`; the Specialists nav entry. Data is untouched.
