# superagent/effects

The durable queue of external work the engine asked for, and the reply lane that carries the engine's messages to channels. Ported from the prototype's effects queue and outbox discipline, over the audit domain's proven machinery — this module composes what `src/domains/audit` already proves rather than reimplementing it.

## What lives here

| File | Role |
|---|---|
| `later.ts` | The `Later` throw: an honest defer that counts no failure. |
| `backoff.ts` | Per-kind retry curves. Everything but `reply` doubles 2s → 60s; `reply` goes 5s → 300s. Full jitter; the draw is injectable for tests. |
| `queue.ts` | The `work_effects` mechanics over the raw postgres client: claim, complete, fail, defer, sweep. |
| `receipts.ts` | The `work_outbox_receipts` lane: conversation-scoped claims, ordered send, sent/dropped, sweep, and the `reply` effect's conversation-drain handler. |
| `drain.ts` | `runEffectsPass` and `runSuperagentDispatch` — the drain passes. |
| `handlers.ts` | The registry: which consumer handles each kind. |

## The two lanes

**Effects (work commands).** A command runs inside `store.repositories.atomic`; the engine calls its ports synchronously; the host implementations enqueue — `store.effects.enqueue({ kind, key, payload? })` — and the flush transaction commits the domain state and the effect row together (spec invariant: one writer, one transaction). The row is at most one per pending `(workspace, kind, key)`: the partial unique index coalesces bursts, and the first enqueue of a pair wins. Every `work_effects` write outside that insert is lease-fenced:

- **claim** — due, unleased rows under `for update skip locked`, optional workspace filter for the inline drain.
- **complete** — status `done`, fenced by the lease token.
- **fail** — `attempts` and `consecutive_failures` grow, the row waits out its kind's backoff, and it stays **pending**: the queue never dead-letters. The generated `needs_attention` column turns true at three consecutive failures — the panel's health entry.
- **defer** — a `Later` throw or a handlerless kind parks until `retryAt` with counters untouched. This is the deploy-order-safety valve: a producer may land before its consumer.
- **sweep** — releases leases whose worker died between claim and completion. A release, never a failure.

**Receipts (the reply lane).** `store.outbox.send` queues a receipt (primary key = send-once at enqueue) and schedules one coalesced `reply` effect per conversation. The reply handler claims that conversation's pending receipts and sends them in `seq` order through the host's `ReceiptSender` — the chat Source's `ChatStreamSink` in production. Claims carry leases and a prefix guard: a pass takes only a conversation's unleased head-first prefix, so two passes can never split a conversation and send out of order. A send that throws stops the conversation and lets the leases expire; the reply effect's own failure counters then grow and the 5s → 300s curve schedules the next look, with the health entry after three. `'gone'` drops — that conversation can never receive it.

## Drain triggers

The same three the audit outbox uses:

1. **Inline after commit** — the host calls `runSuperagentDispatch(client, effectHandlers({ rawClient, sender }), { workerId, workspaceId })` right after a successful `flush()`.
2. **The outbox dispatch endpoint** — `/api/internal/outbox` runs the superagent dispatch after the audit pass.
3. **Cron recovery** — `/api/internal/cron` runs the same call; the sweepers release what died mid-flight.

`runReceiptsPass` stays exported for the direct lane (the cron recovery net once the chat host registers its sender); the reply effects own the normal send path.

## What does not live here

Handler *semantics* for the executor's kinds (`assessment`, `launch`, `delivery`) belong to the executor wave; they attach in `handlers.ts`. The `ChatStreamSink` implementation (the run-events-backed sender) belongs to the chat cutover wave. The repositories port never reads this module — the engine stays deterministic and database-free.
