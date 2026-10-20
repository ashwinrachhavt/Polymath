# frontend.md — State, data flow, and interaction

**Purpose:** how the UI is built and where state lives. Visual language is
[design.md](design.md); rules for code shape are [coding.md](coding.md).

## The state hierarchy

There is exactly one order of preference. Use the earliest that works.

1. **The database.** Anything durable is a record. Not React state, not a cache.
2. **The URL.** Filters, sort, tab, selected record, pagination cursor. Shareable
   and reloadable for free.
3. **The server component.** Data read during render, composed server-side.
4. **The server action.** Mutations, then `revalidateTag`.
5. **Local component state.** Ephemeral UI only: an open menu, a draft in a
   textarea before submit, a hover.
6. **Never:** a global client store mirroring server data.

If you are reaching for a client store to hold records, the design is wrong.
Postgres already holds them, and the RSC already read them.

## State ownership

Every kind of state has exactly one home. A second copy is a copy that drifts.

| State kind | Where it lives | Example |
|---|---|---|
| Server records | Server component and the domain query layer | The note list composed by `pageNotes` in `(workspace)/alfred/notebook/page.tsx` |
| Shareable view state | The URL | `?q=capture&page=2&status=open` |
| Selected record | The URL | `?id=<noteId>` on the notebook and inbox, `?task=<taskId>` on work |
| Drafts and dialogs | Component state | A textarea before submit, an open menu, a hover |
| Preview records | The browser-preview store, localStorage only | `/apps/neuralflow`, `/activity`, `/settings` |

- **Server state is not copied into a client store.** The server component read
  it and passes typed props. A client store holding records creates a second
  source of truth that no one reconciles.
- **The URL owns what a person can share, reload, or return to.** Search text,
  filters, page, page size, and the selected record. A selected record is its own
  param (`?id=`, `?task=`), not part of the list contract. For list surfaces the
  target convention is `src/lib/list-params.ts`: `parseListParams` parses
  `{ q, page, pageSize, filters }` against a `ListSpec` and falls back to the
  default rather than throwing on a hand-edited URL; `listHref` writes a patch
  and drops only empty values and `page === 1`, so a default page size or a
  default filter value stays in the URL once set. Most list screens already use
  it. Treat this as the convention to move toward, not a description of every
  screen today: the `apps/*/[screen]` preview screens and the command-center
  apps screens still hold their search, status, selection, and paging in
  `useState`, and individual screens vary in which of those they keep there.
- **Component state owns what is not yet a fact.** A draft, an open dialog, a
  hover. It disappears on unmount, which is the correct lifetime.
- **The browser-preview store is not production data.**
  `src/components/workspace/workspace-provider.tsx` boots from
  `emptyWorkspaceState` and persists what the person creates to scoped
  localStorage: the bare key `axiom-ui-preview-v1` for the anonymous scope,
  `axiom-ui-preview-v1:<scope>` otherwise. There is no seeded sample content;
  an empty preview renders each screen's designed empty state.

  `WorkspaceProvider` wraps the whole shell, so the store is readable on every
  route, and two shell components read it unconditionally: `FocusDock` and
  `CommandLayer`. `isBrowserPreviewPath` in `src/lib/navigation.ts` does not
  describe where the store is read. It describes where the preview UI renders:
  the banner and the hydration skeleton, on every `/apps/*` path plus `/activity`
  and `/settings`. The storage warning is not gated by it; it is mounted on every
  route because preview mutations are reachable from canonical screens.

  Canonical data never comes from `useWorkspace`, and canonical writes never go
  through it. What the shell does read on every route is preview chrome, not
  records: the focus dock shows a preview focus session when one exists, and the
  command layer posts preview notices. Both are preview state, labelled as such,
  and neither stands in for a canonical read. A page's own content still comes
  from its domain query.

Preview and canonical writes are separate operations. A preview mutation never
stands in for a canonical one, and a preview success says nothing about what
Postgres holds.

Every preview mutation reports whether the write landed. Most return
`{ ok, persisted }`. The add paths return the created record or `undefined`, and
`clarifyCapture` returns the derived id or `undefined`; `undefined` means the
input was invalid or the write was refused.

`ok: false` means the write was refused. Not every operation guards existence:
`updateTask`, `updateContact`, `updateCapture`, `updateCompany`,
`updateOpportunity`, and `updateProject` commit an `ok: true` no-op for an
unknown id. The refusals that do occur: another tab moved first, a guarded
operation found no record, the attachment was a duplicate, the event belonged to
a provider, the reorder changed nothing, or the reward was already earned. A
duplicate attachment refusal returns `persisted: true` because storage was never
at fault.

`ok: false` is a refusal: nothing changed, and no success notice, record handed
back, or optimistic row may accompany it. `ok: true, persisted: false` is a
change that exists only in this tab, because the storage write threw; it is lost
on refresh and is not a refusal. A surface that announces a save must check both
`ok` and `persisted`, because `ok` alone is true when the storage write failed.
The guard is `if (!result.ok || !result.persisted) return;` before the notice.
`PreviewStorageWarning` owns that message. It carries
four distinct cases: an incompatible saved format, storage unavailable on read, a
stale-tab refusal, and a storage write that could not save. The last two are
different conditions and must not share a message. It is mounted in the shell on
every route, because preview mutations are reachable from canonical screens.

Do not add a second global store without a measured need. The server, the URL,
and component state cover the cases that exist, and a store is a permanent
reconciliation cost paid to avoid a temporary prop.

## Reads

- Reads happen in server components. Compose the view model during render.
- Fetch in parallel with `Promise.all`, bounded. No waterfall across components.
- Never call this app's own HTTP endpoints from the server. Call the domain query.
- Never `useEffect` a fetch the server already did. That is a bug, not a pattern.
- Stream a slow section behind `<Suspense>` rather than delaying the page.

## Writes

- First-party mutations are server actions in a sibling `actions.ts`.
- A server action returns a typed result, not a thrown error, for expected
  failures. Throw only for programmer error.
- After a successful action, invalidate the specific tag. Not everything.
- Optimistic updates are allowed only where the server response is fast and the
  rollback is visible. A drag that fails must visibly snap back.

## Client components

- `"use client"` belongs at a leaf, on the smallest component that needs
  interaction.
- `"use client"` at the top of a page is a smell. It means the whole subtree
  shipped to the browser to open a menu.
- A client component receives typed props. It does not fetch, and it does not
  import a domain's query.

### Calling `/api/v1` from a client island

Use `requestJson` from `src/lib/client-request.ts`. Never call `fetch` directly —
the raw version drifts on what a network failure, a 401 and a 500 each say — except
for streaming (`src/components/chat/use-chat-stream.ts`) and multipart upload
progress over XHR (`src/components/documents/upload-dropzone.tsx`).

It returns `{ ok: true, data }` or `{ ok: false, failure }`, and `failure.kind`
is one of:

| Kind | Meaning | What the surface does |
|---|---|---|
| `unauthenticated` | No session | Name the sign-in and keep the work |
| `forbidden` | Role cannot do this | Say so; do not retry |
| `not_found` | Record is gone | Offer a refresh to the current list |
| `conflict` | Another write won | Ask for a refresh before reapplying |
| `validation` | Fields rejected | Point at the field |
| `rate_limited` | Too many requests | Wait, then retry |
| `server` | Server answered with a failure | Retry; say it is not the person's fault |
| `network` | Never reached the server | Hedge: the request did not reach the server, so check the record before sending it again |
| `aborted` | The caller cancelled | Hedge: the request was cancelled, so check the record before sending it again |
| `malformed` | Answered, body unreadable | Retry, then reload |

`failure.title` is safe copy for the surface. `failure.code` carries the server's
stable problem code where it sent one, for a caller that must branch on the exact
cause. Never render a raw body, stack trace or provider payload.

A caller that passes an `AbortSignal` treats `aborted` as "do nothing", not as an
error. A polling loop must stop on `unauthenticated`, `forbidden` and `not_found`
rather than retrying, and must bound `rate_limited` to consecutive attempts.

## Forms

- Labels above inputs. Error text below. Never placeholder-as-label.
- Validate on the client for speed, on the server for truth. Both, always.
- Disable the submit button while pending, and show what is happening.
- Never lose a user's input on error. Repopulate the form with what they typed.

## Surfaces and states

Every data surface ships the full cycle, designed rather than defaulted:

| State | Requirement |
|---|---|
| Loading | A skeleton matching the final layout's shape. Never a spinner. |
| Empty | Composed, and it says how to populate. An invitation to act. |
| Filtered empty | Distinguishes "nothing exists" from "nothing matches". |
| Partial | Incomplete results are visibly partial. |
| Stale | Shows when data was last observed. |
| Error | States what happened and the fix. Never apologises. |
| Offline | Says what is unavailable and what still works. |
| Permission denied | Names what is missing. |
| Success | Confirms in the same words as the action. |

Missing any of these is an incomplete surface, not a follow-up ticket.

## Capture

Capture is the one interaction that must never be modal or slow.

- One keystroke opens it. One field. Enter submits.
- It never waits for classification. It returns immediately with the item in the
  inbox.
- It works from anywhere in the product.
- Paste a URL, drop a file, type text, forward an email — all the same entry.

## The stone reveal

- Plays once. Never loops.
- Never blocks. Close it and keep working.
- Honours `prefers-reduced-motion` and the in-app reduce-motion setting; the
  reduced variant shows the stone without motion.
- The stone remains findable afterwards in the area's collection.

## Accessibility

- WCAG 2.2 AA. Complete keyboard operation.
- Visible focus from the global `:focus-visible` rule, never a component override.
- Keyboard alternative for every drag interaction.
- Focus returns to the trigger when an overlay closes.
- Live regions restrained: timers and streaming announce state changes, not every tick.
- Targets at least 24px.

## Performance

- Initial route JS under 180 KB gzip.
- LCP under 2.5 s p75. INP under 200 ms p75.
- Virtualise lists above 200 rows.
- Paginate every server collection.
- One composition boundary for the home surface.

Measure before optimising. A guess about what is slow is usually wrong.

## Anti-patterns

- A `useEffect` fetching data the server already had.
- A client store holding records.
- `"use client"` on a page.
- State that Postgres already holds, duplicated in React.
- Rendering an empty list over a failed load.
- A spinner where a skeleton belongs.
- Placeholder text used as a label.
- An optimistic update with no visible rollback.
