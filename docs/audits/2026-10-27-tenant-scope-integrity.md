# Tenant-scope integrity audit

**Verified at** `0aa50a36ccc8b3cc272cff1d7d47a7db7da90ef5`, 2026-10-27.
**Method:** parsed every `CREATE TABLE`, `CREATE UNIQUE INDEX`, and
`ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` in `src/db/migrations/*.sql`, folding
`0248`'s dossiers→notebooks rename and excluding the six tables genuinely dropped by
`0235` and `0257`.

> **Counting caution, and the basis.** Three passes were needed because the same
> numbers are reachable three different ways and two of them are wrong.
>
> 1. Composite keys are **not** `ALTER TABLE … UNIQUE (…)`. The real form is
>    `CREATE UNIQUE INDEX … USING btree ("workspace_id","id")` — `people` and
>    `organizations` in `0006`, `context_manifests` in `0142`. Both I and a second
>    session first searched the wrong form and got 5, then 0.
> 2. `dossiers`, `dossier_questions` and `dossier_sources` were **renamed, not
>    dropped** (`0248_notebooks_from_dossiers.sql`). Treating them as dropped
>    undercounts the tenant table set by 3.
> 3. Only `daily_outcomes` and the five `learning_*` tables were genuinely dropped
>    (`0235_drop_learning.sql`, `0257`).
>
> **Basis for every number below: 154 tables in the current schema, of which 151
> carry `workspace_id`.** The three without it are `users` and `workspaces` (the
> tenant boundary itself) and `integration_catalog` (global provider metadata). If
> you recompute 151 and the older draft says 148, the older draft was wrong.

## The finding

Tenancy is enforced in two places today:

1. **`workspace_id NOT NULL` on every owned table** — each row is stamped with a tenant.
2. **Application-level scoping** — queries filter on `AuthContext.workspaceId`.

Neither stops a *reference* from crossing tenants. A foreign key
`document_id uuid REFERENCES documents(id)` is satisfied by a document in any
workspace, so a defect that supplies a foreign id writes a row whose `workspace_id`
says A and whose `document_id` points into B.

`src/domains/identity/schema.ts` already names the fix, in a comment on `people`:

> `// Unique so child tables can target (workspace_id, id) with a composite`
> `// FK — the check that makes a cross-tenant endpoint impossible.`

That comment is the right design. It is applied to **3 tables**.

## Measurements

| Measure | Count |
|---|---:|
| Tables in the current schema | 154 |
| Tables with `workspace_id NOT NULL` | 151 |
| Tables exposing `unique(workspace_id, id)` | **3** |
| Live FK constraints | 274 |
| FK constraints already composite (workspace-scoped) | **14** |
| Single-column FKs pointing at a tenant table with no composite key | **125** |
| Distinct target tables needing a key | **40** |

Tables that already have the composite key: `context_manifests`, `organizations`,
`people`. The 14 composite FKs all target those three.

Highest-exposure targets without one:

| Target table | Inbound unprotected FKs |
|---|---:|
| `documents` | 18 |
| `artifacts` | 13 |
| `document_extractions` | 11 |
| `agent_runs` | 6 |
| `opportunities` | 6 |
| `contacts` | 6 |
| `tasks` | 6 |
| `companies` | 5 |
| `action_proposals` | 4 |
| `document_folders` | 4 |

## What this is not

- **Not evidence of a live leak.** Query-layer scoping was in place in every path
  read for this audit. The exposure is that nothing *structurally* prevents a future
  one. Defence-in-depth gap, not a breach.
- **Not fixable with RLS alone.** There is **no `ROW LEVEL SECURITY` anywhere** in
  the migrations. If RLS is added later, note that PostgreSQL's referential-integrity
  checks bypass RLS, so it would not close this. The composite FK is the constraint
  that survives every future caller.
- **Not a blanket migration.** Most of the 122 edges are between rows that are
  already created together inside one workspace-scoped transaction. The risk is
  concentrated in edges a client can influence — foreign ids arriving from a request
  body, a webhook, or a model. Those are the ones worth converting first.

## The fix

Additive, revertible, no data rewrite. Four steps.

### Step 1 — expose the composite key on the target tables

```sql
CREATE UNIQUE INDEX "documents_workspace_id_key"
  ON "documents" USING btree ("workspace_id","id");
```

`id` is already a primary key, so the pair is trivially unique and the index is
small. Required before step 2 is expressible.

### Step 2 — convert the edges that matter, highest-risk first

`documents`, `document_extractions`, `action_proposals`, `tasks` are the paths the
capture → extraction → obligation → action journey actually walks. Convert those
before the long tail.

```sql
ALTER TABLE document_extractions
  DROP CONSTRAINT document_extractions_document_id_documents_id_fk,
  ADD CONSTRAINT document_extractions_document_same_workspace_fk
    FOREIGN KEY (workspace_id, document_id)
    REFERENCES documents (workspace_id, id)
    ON DELETE CASCADE;
```

Two properties to check per edge rather than assume:

- **NULL components.** A composite FK with a NULL part is not checked under
  `MATCH SIMPLE`. That is correct for genuinely optional relationships
  (`tasks.project_id`). Where "both or neither" must hold, use `MATCH FULL`.
- **Delete action.** `ON DELETE SET NULL` on a composite key nulls *both* columns;
  where the child's `workspace_id` is NOT NULL that action is inexpressible. Find
  those edges first and re-examine the relationship rather than converting
  mechanically.

### Step 3 — a test that keeps it closed

One integration test, parameterised over the converted pairs:

```
seed workspace A and B
insert a parent in B
insert a child in A whose FK column points at the B parent
→ every attempt must raise a foreign-key violation
```

The test is the deliverable. The constraints are what make it pass.

### Step 4 — drive the remaining edges from the test's failure list

Do not convert all 122 blind. Convert what the test proves is exploitable, then
extend the test.

## Sequencing note

A second session pushed back that a blanket migration across every tenant table is
a large, hard-to-reverse diff for a risk that is concentrated in a handful of edges.
That is correct, and it is why step 2 is scoped by journey rather than by table list.
Ship steps 1 and 3 first; they are behaviour-neutral and make the size of step 2
measurable.
