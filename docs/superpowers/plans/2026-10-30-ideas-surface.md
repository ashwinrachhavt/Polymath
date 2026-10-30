# Ideas Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ideas their own top-level surface, delete the cards, areas, and sittings subsystems with their tables, and rebuild the Document Vault as a flat row list.

**Architecture:** Ideas becomes a leaf destination under `/polymath/ideas`, reading the existing artifact-backed zettel collection through a split set of small components. Cards, areas, and sittings are deleted bottom-up — routes, then components, then domain modules — with `tsc` run between stages so dangling imports surface immediately. The vault keeps its `/polymath/knowledge` URL and its `?doc=` workbench, but loses its tab strip and folder grid in favour of the mockup's row list.

**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle ORM + Postgres, Tailwind, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-30-ideas-surface-design.md`

## Global Constraints

- The vault URL stays `/polymath/knowledge`; it is not renamed.
- No websocket or socket.io server is added. All streaming uses the existing NDJSON routes.
- Component files stay under 200 lines; `writing-surface.tsx` (467 lines) is deleted, not extended.
- Only the existing pill tokens in `globals.css` may be used for status colour; no new tints.
- Destructive migrations run only after the code that reads those tables is gone.
- Every removed URL maps to a successor in `featureRoutes`; no removed path may 404.
- Copy is sentence case, plain verbs, no "mastery", "recall", "learning loop", "sitting", or "area" in user-facing strings.

## Review Focus

- **A person with existing cards or areas hits the drop migration.** Expectation: their ideas survive untouched; the deleted features simply disappear. The migration drops only `cards`, `card_reviews`, `areas`.
- **An old bookmark to `/polymath/knowledge/zettels/session/<id>` is opened.** Expectation: it lands on Ideas, not a 404 or a stack trace.
- **A workspace with zero ideas opens Ideas.** Expectation: an invitation to capture, not an empty grey box.
- **A capture with no readable text runs "Generate zettels".** Expectation: the existing "No open capture has text to read" message, unchanged.
- **A document in the vault has pending zettel proposals and someone opens its review page.** Expectation: "Propose zettels" still works after sittings are gone.

---

## Task 1: Ideas destination in navigation

**Files:**
- Modify: `src/lib/navigation.ts`
- Test: `tests/unit/navigation-ideas.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a `Destination` at href `/polymath/ideas`, and `featureRoutes` entries mapping every removed path.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { destinations, destinationForPath } from "@/lib/navigation";

describe("Ideas destination", () => {
  it("is a top-level rail destination between Notes and Document Vault", () => {
    const labels = destinations.map((d) => d.label);
    const ideas = labels.indexOf("Ideas");
    expect(ideas).toBeGreaterThan(-1);
    expect(labels.indexOf("Notes")).toBeLessThan(ideas);
    expect(labels.indexOf("Document Vault")).toBeGreaterThan(ideas);
  });

  it("resolves its own path and every retired path to Ideas", () => {
    expect(destinationForPath("/polymath/ideas")?.label).toBe("Ideas");
    for (const retired of [
      "/polymath/knowledge/zettels",
      "/polymath/knowledge/zettels/session",
      "/polymath/knowledge/ideas",
      "/polymath/knowledge/cards",
      "/polymath/knowledge/areas",
    ]) {
      expect(destinationForPath(retired)?.label, retired).toBe("Ideas");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/navigation-ideas.test.ts`
Expected: FAIL — `labels.indexOf("Ideas")` is `-1`.

- [ ] **Step 3: Add the destination and the bridges**

In `src/lib/navigation.ts`, import `Lightbulb` from `lucide-react` and insert immediately after the Notes entry:

```ts
{
  href: "/polymath/ideas",
  label: "Ideas",
  purpose: "Your ideas, each with its evidence.",
  icon: Lightbulb,
  group: "polymath",
},
```

Add to `featureRoutes`:

```ts
"/polymath/knowledge/zettels": "/polymath/ideas",
"/polymath/knowledge/zettels/session": "/polymath/ideas",
"/polymath/knowledge/ideas": "/polymath/ideas",
"/polymath/knowledge/cards": "/polymath/ideas",
"/polymath/knowledge/areas": "/polymath/ideas",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/navigation-ideas.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/navigation.ts tests/unit/navigation-ideas.test.ts
git commit -m "feat(nav): add Ideas destination and retire zettel/card/area paths"
```

---

## Task 2: The idea card component

**Files:**
- Create: `src/components/polymath/ideas/idea-card.tsx`
- Test: `tests/unit/idea-card.test.tsx`

**Interfaces:**
- Consumes: `ZettelCardItem` from `@/domains/knowledge/zettels` (fields: `id`, `title`, `tags`, `excerpt`, `createdAt`, `sourceTitle`).
- Produces: `IdeaCard({ item, href }: { item: ZettelCardItem; href: string })` — a pure presentational component.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { IdeaCard } from "@/components/polymath/ideas/idea-card";

const item = {
  id: "z1",
  title: "The cache is the bill",
  tags: ["#llms", "#inference"],
  excerpt: "Long context bills in memory before it bills in tokens.",
  createdAt: new Date("2026-10-24T12:00:00Z"),
  updatedAt: new Date("2026-10-24T12:00:00Z"),
  sourceDocumentId: "d1",
  sourceTitle: "How KV caches scale",
  bloom: null,
  suggestedLinks: [],
};

describe("IdeaCard", () => {
  it("renders title, claim, tags, source attribution and date", () => {
    render(<IdeaCard item={item} href="/polymath/ideas/z1" />);
    expect(screen.getByText("The cache is the bill")).toBeDefined();
    expect(screen.getByText(/Long context bills in memory/)).toBeDefined();
    expect(screen.getByText("#llms")).toBeDefined();
    expect(screen.getByText(/How KV caches scale/)).toBeDefined();
    expect(screen.getByText(/Oct 24/)).toBeDefined();
    expect(screen.getByRole("link").getAttribute("href")).toBe("/polymath/ideas/z1");
  });

  it("carries no mastery, recall, or progress chrome", () => {
    const { container } = render(<IdeaCard item={{ ...item, bloom: { level: 1, levelName: "Recall" } }} href="/x" />);
    expect(container.textContent).not.toMatch(/mastery|recall|practice|progress/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/idea-card.test.tsx`
Expected: FAIL — cannot resolve `@/components/polymath/ideas/idea-card`.

- [ ] **Step 3: Implement `IdeaCard`**

A `<Link>` wrapping a bordered card. Title at `text-[15px] font-medium`; excerpt one line, `line-clamp-2`, muted; tags as pills using the existing pill token classes; a footer row with the muted `from {sourceTitle}` on the left and the `Oct 24`-formatted `createdAt` on the right. When `sourceTitle` is null the attribution is omitted entirely — not rendered as "from unknown". Date via `toLocaleDateString("en", { month: "short", day: "numeric" })`. Deliberately ignores `bloom`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/idea-card.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/polymath/ideas/idea-card.tsx tests/unit/idea-card.test.tsx
git commit -m "feat(ideas): add the idea card component"
```

---

## Task 3: The Ideas collection page

**Files:**
- Create: `src/app/(workspace)/polymath/ideas/page.tsx`
- Create: `src/components/polymath/ideas/idea-grid.tsx`
- Test: `tests/unit/idea-grid.test.tsx`

**Interfaces:**
- Consumes: `pageZettelCards(auth, params)` and `ZettelCardItem` from `@/domains/knowledge/zettels`; `IdeaCard` from Task 2.
- Produces: `IdeaGrid({ items, view, baseHref })` where `view` is `"cards" | "table" | "timeline" | "dictionary"`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { IdeaGrid } from "@/components/polymath/ideas/idea-grid";

const items = [
  { id: "a", title: "Snapshots, not locks", tags: [], excerpt: "MVCC buys concurrency.", createdAt: new Date("2026-10-14T00:00:00Z"), updatedAt: new Date("2026-10-14T00:00:00Z"), sourceDocumentId: null, sourceTitle: null, bloom: null, suggestedLinks: [] },
  { id: "b", title: "Libraries compound", tags: ["#product"], excerpt: "A saved source beats ten tabs.", createdAt: new Date("2026-10-09T00:00:00Z"), updatedAt: new Date("2026-10-09T00:00:00Z"), sourceDocumentId: null, sourceTitle: null, bloom: null, suggestedLinks: [] },
];

describe("IdeaGrid", () => {
  it("renders every idea once in cards view", () => {
    render(<IdeaGrid items={items} view="cards" baseHref="/polymath/ideas" />);
    expect(screen.getByText("Snapshots, not locks")).toBeDefined();
    expect(screen.getByText("Libraries compound")).toBeDefined();
  });

  it("orders dictionary view by title", () => {
    const { container } = render(<IdeaGrid items={items} view="dictionary" baseHref="/polymath/ideas" />);
    const titles = [...container.querySelectorAll("h3")].map((n) => n.textContent);
    expect(titles).toEqual(["Libraries compound", "Snapshots, not locks"]);
  });

  it("shows an invitation when there are no ideas", () => {
    render(<IdeaGrid items={[]} view="cards" baseHref="/polymath/ideas" />);
    expect(screen.getByText(/Capture something from Inbox/i)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/idea-grid.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `IdeaGrid` and the page**

`idea-grid.tsx` sorts a copy per view (`dictionary` by title; `timeline` newest-first by `createdAt`; `cards` and `table` in the order given) and renders `IdeaCard` for `cards`/`timeline`/`dictionary`, a `<table>` for `table`. Empty renders one sentence: "Capture something from Inbox and its ideas appear here."

`page.tsx` mirrors the deleted zettels page's plumbing: `Suspense` + `io()`, `parseListParams`, `pageZettelCards`, `Pagination`, `ListToolbar`, and a view switcher over `VIEWS = ["cards", "table", "timeline", "dictionary"]`. Header: title "Ideas", purpose from the navigation entry. `metadata = { title: "Ideas · Polymath" }`. Keep `BASE = "/polymath/ideas"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/idea-grid.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(workspace)/polymath/ideas/page.tsx" src/components/polymath/ideas/idea-grid.tsx tests/unit/idea-grid.test.tsx
git commit -m "feat(ideas): add the Ideas collection page and grid"
```

---

## Task 4: Delete the cards subsystem

**Files:**
- Delete: `src/app/(workspace)/polymath/knowledge/cards/` (4 files)
- Delete: `src/domains/knowledge/{cards,card-queries,learning-paths,recall-scheduler}.ts`
- Delete: `tests/unit/recall-scheduler.test.ts` (the scheduler is card-only)
- Delete: `tests/integration/cards.test.ts`
- Modify: `src/domains/integrations/reads/generic.ts`, `src/components/chat/record-links.ts`, `src/components/chat/surface-card.tsx`, `src/domains/supervisor/respond.ts`, `src/app/(workspace)/polymath/knowledge/page.tsx`
- Test: existing suite must stay green

**Interfaces:**
- Consumes: nothing.
- Produces: no `cards` symbol survives in `src/`.

- [ ] **Step 1: Delete the routes and domain files**

```bash
git rm -r "src/app/(workspace)/polymath/knowledge/cards"
git rm src/domains/knowledge/cards.ts src/domains/knowledge/card-queries.ts \
       src/domains/knowledge/learning-paths.ts src/domains/knowledge/recall-scheduler.ts
```

- [ ] **Step 2: Run `tsc` and collect every dangling import**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: FAIL, listing each file that imported the deleted modules.

- [ ] **Step 3: Remove each dangling reference**

In `generic.ts`, delete the `cards` read kind and its branch. In `record-links.ts`, delete the card link builder. In `surface-card.tsx`, delete the card surface variant. In `respond.ts`, delete the card reference. In `knowledge/page.tsx`, delete the Cards tab link.

- [ ] **Step 4: Delete the card tests and the card assertions in shared tests**

```bash
git rm tests/integration/cards.test.ts tests/unit/recall-scheduler.test.ts
```
Remove the card assertions from `tests/unit/generic-read.test.ts` and `tests/e2e/proposal-batches.spec.ts`; leave those files' other tests intact.

- [ ] **Step 5: Verify nothing references cards**

Run: `grep -rn "card-queries\|knowledge/cards\|recall-scheduler" src tests`
Expected: no output.

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run tests/unit`
Expected: typecheck clean; unit suite passes.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(knowledge): delete the cards subsystem"
```

---

## Task 5: Delete the areas subsystem

**Files:**
- Delete: `src/app/(workspace)/polymath/knowledge/areas/` (3 files)
- Delete: `src/domains/knowledge/{areas,area-queries,area-resolve}.ts`
- Delete: `tests/integration/areas.test.ts`
- Modify: `src/app/(workspace)/polymath/knowledge/page.tsx`
- Test: existing suite must stay green

**Interfaces:**
- Consumes: nothing.
- Produces: no `area` symbol survives in `src/`.

- [ ] **Step 1: Delete the routes and domain files**

```bash
git rm -r "src/app/(workspace)/polymath/knowledge/areas"
git rm src/domains/knowledge/areas.ts src/domains/knowledge/area-queries.ts src/domains/knowledge/area-resolve.ts
```

- [ ] **Step 2: Run `tsc` and collect every dangling import**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: FAIL with the importing files listed.

- [ ] **Step 3: Remove each dangling reference and the Areas tab link**

Follow the compiler. In `knowledge/page.tsx`, delete the Areas tab link.

- [ ] **Step 4: Delete the area tests and verify**

```bash
git rm tests/integration/areas.test.ts
grep -rn "area-queries\|area-resolve\|knowledge/areas" src tests
```
Expected: no output. Then `npx tsc --noEmit -p tsconfig.json && npx vitest run tests/unit` — clean and green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(knowledge): delete the areas subsystem"
```

---

## Task 6: Delete the sittings subsystem

**Files:**
- Delete: `src/app/(workspace)/polymath/knowledge/zettels/` (page + session routes)
- Delete: `src/app/api/v1/polymath/sittings/`
- Delete: `src/components/polymath/zettels/{writing-surface,workspace-shell,sitting-store,decomposition-panel,creation-stream-reducer,session-rail,ambient-panel}.tsx`
- Delete: `src/domains/knowledge/{sittings,sitting-run,sitting-events}.ts`
- Delete: `tests/unit/{sitting-events,sittings-constants,creation-stream-reducer}.test.ts`
- Modify: `src/domains/knowledge/decomposition.ts` (keep it; drop sitting entry points)- Test: existing suite must stay green

**Interfaces:**
- Consumes: nothing.
- Produces: `decomposition.ts` retains `proposeZettels`-facing document functions only.

**Preserved — do not delete:** `src/domains/knowledge/continuation.ts` (imported by the project notebook page, run page, API-keys panel, and `use-chat-stream`).

- [ ] **Step 1: Delete the routes first**

```bash
git rm -r "src/app/(workspace)/polymath/knowledge/zettels"
git rm -r src/app/api/v1/polymath/sittings
```

- [ ] **Step 2: Run `tsc`**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: FAIL — the component and domain imports those routes used are now unreferenced, and anything else pointing at them surfaces here.

- [ ] **Step 3: Delete the components, then the domain modules**

```bash
git rm src/components/polymath/zettels/{writing-surface,workspace-shell,sitting-store,decomposition-panel,creation-stream-reducer,session-rail,ambient-panel}.tsx
git rm src/domains/knowledge/sittings.ts src/domains/knowledge/sitting-run.ts src/domains/knowledge/sitting-events.ts
```

Keep `src/components/polymath/zettels/{idea-editor,suggested-links-strip,keyboard,idle-debounce}.ts`.

- [ ] **Step 4: Trim `decomposition.ts` to its document entry points**

Remove the sitting-pipeline functions the deleted modules called. Keep the ones `listZettelProposals`/`proposeZettels` on a document depend on. Then:

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Delete the sitting tests and verify the loop still works**

```bash
git rm tests/unit/sitting-events.test.ts tests/unit/sittings-constants.test.ts tests/unit/creation-stream-reducer.test.ts
npx vitest run tests/unit/decomposition.test.ts
```
Expected: PASS — the document→zettel path survives.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(zettels): remove the sitting creation flow"
```

---

## Task 7: Vault page rebuild

**Files:**
- Modify: `src/app/(workspace)/polymath/knowledge/page.tsx`
- Modify: `src/app/(workspace)/polymath/knowledge/vault.tsx`
- Test: `tests/unit/vault-rows.test.tsx`

**Interfaces:**
- Consumes: `getVaultDocuments(auth, folderId): Promise<VaultDocument[]>` and `vaultReview(key, undecidedProposals)` from `@/domains/knowledge/vault-review`.
- Produces: `VaultRows({ documents, total, needingAttention })`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { VaultRows } from "@/app/(workspace)/polymath/knowledge/vault-rows";
import type { LibraryStateFilter } from "@/domains/knowledge/library";

const doc = (over: Partial<{ id: string; title: string; reviewKey: LibraryStateFilter }> = {}) => ({
  id: "d1", title: "SoFi statement - September", filename: "sofi.pdf", mimeType: "application/pdf",
  kind: "file" as const, reviewKey: "needs_check" as const, undecidedProposals: 2,
  sourceUrl: null, updatedAt: "2026-10-30T09:30:00Z", sizeBytes: 217088,
  pageCount: 3, docType: "Bank statement", href: "/polymath/knowledge?doc=d1", ...over,
});

describe("VaultRows", () => {
  it("names the count and the exception count", () => {
    render(<VaultRows documents={[doc()]} total={6} needingAttention={2} />);
    expect(screen.getByText(/6 items/)).toBeDefined();
    expect(screen.getByText(/2 need attention/)).toBeDefined();
  });

  it("shows the review label only on rows that need it", () => {
    render(<VaultRows documents={[doc(), doc({ id: "d2", title: "Design brief", reviewKey: "filed" })]} total={2} needingAttention={1} />);
    expect(screen.getAllByText("Needs review")).toHaveLength(1);
  });

  it("renders type, size and a friendly date on each row", () => {
    render(<VaultRows documents={[doc()]} total={1} needingAttention={1} />);
    expect(screen.getByText(/Bank statement/)).toBeDefined();
    expect(screen.getByText(/212 KB/)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/vault-rows.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `VaultRows`**

New file `vault-rows.tsx` beside `vault.tsx`: a `<ul>` of rows, each a link to `document.href` with an icon, title, a `type · size · timestamp` meta line (size formatted as `212 KB` / `2.1 MB`), and the `vaultReview()` label on the right only when `needsReview`. Above it, the count line: `${total} items` and, when non-zero, `· ${needingAttention} need attention`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/vault-rows.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire the page to `VaultRows` and delete the tab strip**

In `knowledge/page.tsx`: remove the `<nav aria-label="Knowledge views">` block and the `DocumentVault` folder-grid rendering; compute `total` and `needingAttention` from `vaultDocuments` and render `<VaultRows/>`. Keep the `?doc=` review workbench branch untouched — it carries the "Propose zettels" button.

In `vault.tsx`: delete the folder tile grid, breadcrumb, view-mode switch, and folder-creation form. If the file drops below ~200 lines and has one responsibility, keep it; otherwise delete it and fold what remains into `vault-rows.tsx`.

- [ ] **Step 6: Verify the surface**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run tests/unit/vault-queries.test.ts tests/unit/vault-review.test.ts`
Expected: clean and green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(vault): rebuild the vault as a flat row list"
```

---

## Task 8: Drop the tables

**Files:**
- Create: `src/db/migrations/0224_drop_cards_and_areas.sql`
- Modify: `src/domains/knowledge/schema.ts`
- Test: `tests/integration/migrations-apply.test.ts` (existing runner)

**Interfaces:**
- Consumes: nothing.
- Produces: a database with no `cards`, `card_reviews`, `areas`, or `zettel_sitting_cards` tables.

- [ ] **Step 1: Confirm the code no longer reads the tables**

Run: `grep -rn "from cards\|cardReviews\|from areas\|zettelSittingCards" src`
Expected: no output. If anything remains, stop and finish Tasks 4–6 first.

- [ ] **Step 2: Write the migration**

```sql
-- 0224: cards, areas, and sittings are retired (spec 2026-10-30).
-- Drop order follows the foreign keys: reviews cite cards, sitting cards cite sittings.
DROP TABLE IF EXISTS card_reviews;
DROP TABLE IF EXISTS cards;
DROP TABLE IF EXISTS zettel_sitting_cards;
DROP TABLE IF EXISTS areas;
```

No `CASCADE`: a surviving foreign key is a signal that something still references these tables, and that should fail the migration loudly rather than silently remove a column from another table.

- [ ] **Step 3: Remove the dropped tables from `schema.ts`**

Delete the `cards`, `cardReviews`, `areas`, and `zettelSittingCards` table definitions and any `area_id` columns on surviving tables.

- [ ] **Step 4: Apply the migration and verify**

Run: `node scripts/migrate.mjs` (or the repo's `pnpm db:migrate`)
Expected: applies cleanly.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/0224_drop_cards_and_areas.sql src/domains/knowledge/schema.ts
git commit -m "feat(db): drop the cards, areas and sittings tables"
```

---

## Task 9: Full verification

**Files:**
- Test: whole suite

**Interfaces:**
- Consumes: every prior task.
- Produces: a green branch.

- [ ] **Step 1: Run the full unit suite**

Run: `npx vitest run tests/unit`
Expected: PASS, no skipped test that references a deleted feature.

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit -p tsconfig.json && npx eslint src tests`
Expected: clean.

- [ ] **Step 3: Confirm the deletions are total**

Run: `grep -rn "mastery\|recall-card\|learning.path\|sitting\b" src --include="*.ts" --include="*.tsx"`
Expected: no user-facing string matches; internal identifiers named after these concepts are gone with their modules.

- [ ] **Step 4: Drive the loop in a browser**

Start the dev server, capture something in Inbox, click "Generate zettels", accept a proposal, confirm the idea appears at `/polymath/ideas`, and open the old `/polymath/knowledge/zettels` URL to confirm it lands on Ideas.

- [ ] **Step 5: Commit any fixes, then report**

```bash
git status --short
```
