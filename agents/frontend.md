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
