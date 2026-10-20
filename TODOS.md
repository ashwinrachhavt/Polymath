# TODOS

Deferred work recorded by /ship on 2026-10-18, from the ASH-120 tranche-1 branch
(`ashwinr/ash-120-workspace-access`). Organized by component; priorities P0–P4.

## Frontend reliability (ASH-186)

**Priority:** P2

- **TanStack Query was scoped out.** ASH-186 §3 asks for it, but `agents/agent.md` §9
  says stop before adding a runtime dependency. Server components plus Server Actions
  already cover the canonical reads and writes; the library would buy caching and
  background revalidation on the interactive surfaces. Decide whether to adopt it
  before migrating any domain to it.
- **Client request layer and the preview store are now the two error paths.** Any new
  client island calls `requestJson` (`src/lib/client-request.ts`), never raw `fetch`;
  any new preview mutation returns `{ ok, persisted }` and never reports a refused
  write as saved. Both are documented in `agents/frontend.md`.

**Priority:** P3

- **Clamped failure copy is hover-only.** `upload-dropzone.tsx` clamps a long failure
  cause to two lines with the full sentence in `title`, which a keyboard or touch user
  cannot reach. An `aria-describedby` reveal would fix it.



## Notebooks (NotebookLM parity)

**Priority:** P2

- **Unify the two citation models.** The chat stream emits `citations` frames
  carrying full `DocumentCitation` objects as structured tool output
  (`feat/eve-agents-chat-composio`). The notebook renderer parses `[[n]]`
  markers out of the model's prose (`src/domains/knowledge/inline-citations.ts`).
  Both are correct for their seam, and forcing one through the other means
  inventing markers the model never wrote. The open decision: does the agent
  generate markers, or does the renderer number structured output? Decide that,
  then delete the losing path. Until then a saved note uses the marker form and
  a streamed answer uses the frame form, and the two do not share numbering.

**Priority:** P3

- **Learning eval for answer leakage.** `tests/unit/teaching-contract.test.ts`
  pins that a teaching card carries no `answer`, `answerIndex` or `explanation`.
  That is not the same as proving the model cannot leak what it was never shown.
  The eval needs a real turn with `learning_next` as the only tool, and belongs
  next to `chat-grounding.eval.ts`. Note: evals run serially
  (`maxConcurrency: 1`) because concurrent Gemini sessions intermittently 429.

## Identity / authorization

**Priority:** P1

- Wire `requireRole` and `assertWorkspaceScope` into every server entry point
  (server actions, route handlers). The guards exist (`src/lib/auth/guards.ts`)
  and the ADR's authorization matrix is the target state; today only the
  resolution spine (`identity/resolve.ts` via `src/lib/auth.ts`) is enforced.
  This is ASH-120 F04+ enforcement work.

**Priority:** P2

- Postgres RLS as defense-in-depth over the `workspace_id` query-scope check.
  Deferred by ADR 0001 to the F11/F12 benchmark/rollout tickets; needs the
  non-owner/non-BYPASSRLS runtime role and connection-identity tests first.
- Constrain `account_person_links.method` to a CHECK over its two known values
  (`verified`, `review`) once a second write path exists.
- Workspace-leading indexes for `party_relationships_person_idx` and
  `contact_points_value_idx` when the first real query paths arrive.

## Roles

**Priority:** P4

- Custom role definitions beyond the four fixed roles (owner/admin/member/
  viewer): post-v1 by ADR 0001; revisit when a second workspace shape exists.

## E2E

**Priority:** P3

- Playwright coverage of the legacy `/apps/**` preview screens still assumes
  the pre-split IA in places (switch-product journeys); reconcile with the
  launcher now that canonical chrome is single-sourced.

## File intake

### A sniff mismatch returns 201 instead of quarantining the original

**What:** `tests/integration/file-intake.test.ts` ("a sniff mismatch quarantines
the original instead of rejecting it") asserts a 200 with `fileStatus:
"quarantined"`; the route returns 201.

**Why:** The suite is red on every PR that runs integration tests, so a real
regression in file intake has nowhere to show up. A wrong file status is also the
difference between a quarantined upload and an accepted one.

**Context:** Reproduced on a pristine `origin/main` checkout (`cf47131`) in a
throwaway worktree with a local Postgres: same 201-vs-200, so it is not
introduced by any one branch. The route and the test disagree on the contract;
decide which is correct before changing the assertion. Failing output:

```
AssertionError: expected 201 to be 200
 ❯ tests/integration/file-intake.test.ts:118:24
   expect(res.status).toBe(200);
```

**Effort:** S
**Priority:** P0
**Depends on:** None

## Completed

- ASH-120 F01–F03 (scope ADR, glossary, canonical identity schema, auth
  spine): **v-unversioned** (2026-10-18), PR #10.

## CRM / outreach

**Priority:** P1

- **Ship a `MailSender` adapter.** The send executor is complete — it refuses
  unapproved sends, binds approval to a revision, and leaves an `unknown`
  attempt that blocks retry until reconciled. But there is no implementation of
  the port anywhere in `src/`; `unconfiguredSender` (`src/domains/crm/send-executor.ts`)
  always throws, so no approved message can leave the workspace. The settings
  capability panel reports "Email sending is not implemented" for exactly this
  reason, and the release claim excludes sending until it is untrue. **What:**
  one adapter over a connected account (Composio Gmail first), wired through the
  existing `sendApprovedCorrespondence` path with an idempotency key per
  attempt. **Why:** without it the approval-gated send story is untestable
  outside unit tests, and the `action_attempts` reconciliation work has no live
  producer. **Depends on:** an explicit go-ahead before any real send.

## Inbox / command center

**Priority:** P3

- Arrow-key roving through inbox list rows. **What:** roving tabindex or
  arrow-key navigation across capture rows, complementing the plain-link
  navigation shipped with the two-pane redesign. **Why:** keyboard-first
  users clear a 50-row queue without tabbing through every row; the design
  review (D12, 2026-10-20) deferred it to keep the keyboard model minimal.
  **Pros:** power-user speed through the queue; consistent with Linear-style
  keyboard workflows. **Cons:** a new a11y pattern to maintain and test;
  focus-management edge cases with the detail pane. **Context:** rows are
  plain links per the a11y spec in
  `docs/superpowers/specs/2026-10-20-inbox-redesign-and-extraction-cleanup.md`;
  revisit when the first keyboard-first feedback arrives. **Depends on:**
  the two-pane inbox shipping first.
