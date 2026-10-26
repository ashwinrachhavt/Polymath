"use client";

import { useRouter } from "next/navigation";
import { useOptimistic, useRef, useState, useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Check } from "@/components/products/command-center/controls";
import { Field, Panel, Status } from "@/components/workspace/ui";
import type { EffectOutcome } from "@/domains/actions/executor";
import { decideProposalAction, reviseProposalAction } from "./actions";
import { holdDecidedCard, mergeHeldDecidedCards, type HeldCards } from "./held-cards";
import { outcomeLine } from "./outcome-line";
import { NotionDiff } from "./notion-diff";

/*
 * The queue's client island. Decisions are optimistic: the card flips to the
 * new status immediately, and the server action's revalidate replaces the
 * optimistic state with the committed one. A failure refreshes from the
 * server (rolling the card back) and surfaces the error on the card - a
 * version or revision conflict means someone changed the proposal since it
 * rendered.
 *
 * Idempotency keys are minted per (proposal, rendered version): a retried
 * click replays the same key and the stored receipt answers it, while a
 * conflict bumps the version, which mints a fresh key for the fresh intent.
 */

export type QueueCardData = {
  id: string;
  version: number;
  title: string;
  capability: string;
  riskClass: string;
  status: string;
  expectedEffect: string;
  /*
   * True when no executor exists for the capability (ASH-284): approving
   * records the decision and nothing runs, and the card must say so in both
   * the pending and decided views - never imply an external change happened.
   * The copy is keyed on the capability: generic wording by default, with
   * GitHub's specifics only where they are true.
   */
  decisionOnly: boolean;
  accountAlias: string | null;
  /** The proposing path's intent key; the follow-up pair groups on it (ASH-288). */
  dedupeKey?: string | null;
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  /*
   * The persisted newest-attempt outcome (and the provider-returned design
   * link, when one exists) so a reload tells the same truth the decide
   * response did. Null outcome: no attempt was ever claimed.
   */
  outcome: EffectOutcome | null;
  designUrl: string | null;
  expired: boolean;
  /** Display-only injection annotations from the proposing path (ASH-281). */
  flags: unknown;
  latestRevision: { id: string; revisionNumber: number; payload: unknown; preview: unknown } | null;
  proposedBy: string | null;
  reviews: Array<{ id: string; decision: string; note: string | null; createdAt: string }>;
};

function formatTs(iso: string): string {
  // UTC everywhere: server and client must render the same string.
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/*
 * The send summary a reviewer decides on, read from the BOUND revision -
 * never a live account lookup, so the card shows exactly what the approval
 * binds. The sender label is the identity pinned when the revision was
 * written (the account's registered display name, falling back to its
 * alias); a revision without one cannot send, and says so instead of
 * implying a sender.
 */
function SendSummary({ capability, revision }: { capability: string; revision: QueueCardData["latestRevision"] }) {
  if ((capability !== "gmail.send" && capability !== "send_mail") || !revision) return null;
  const payload = (revision.payload ?? {}) as Record<string, unknown>;
  const pin = payload.accountPin as { resolved?: unknown; sender?: unknown; alias?: unknown } | undefined;
  const pinnedSender =
    pin && pin.resolved === true
      ? typeof pin.sender === "string"
        ? pin.sender
        : typeof pin.alias === "string"
          ? pin.alias
          : null
      : typeof payload.sender === "string"
        ? payload.sender
        : null;
  const to = typeof payload.to === "string" ? payload.to : null;
  const subject = typeof payload.subject === "string" ? payload.subject : null;
  return (
    <dl className="mb-3 grid gap-1 text-[13px]">
      <div className="flex gap-2">
        <dt className="w-14 shrink-0 text-muted-foreground">From</dt>
        <dd>
          {pinnedSender ?? "No sending account is bound to this revision - approving cannot send it. Revise it after connecting the account."}
        </dd>
      </div>
      {to ? (
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 text-muted-foreground">To</dt>
          <dd>{to}</dd>
        </div>
      ) : null}
      {subject ? (
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 text-muted-foreground">Subject</dt>
          <dd>{subject}</dd>
        </div>
      ) : null}
      {pinnedSender ? (
        <p className="text-xs text-muted-foreground">
          {capability === "send_mail"
            ? "Approving does not send. The approved draft waits for Send now on the contact page."
            : "Approving sends this exact message once."}
        </p>
      ) : null}
    </dl>
  );
}

/*
 * What the Writer surfaced with the draft (ASH-281). Flags are requests the
 * untrusted thread text tried to make - quoted verbatim, never acted on -
 * and citations are the library passages the draft leans on. Both are read
 * from the bound revision's preview and the proposal's flags column: what
 * the reviewer sees is what the approval binds.
 */
function DraftGrounding({ flags, revision }: { flags: unknown; revision: QueueCardData["latestRevision"] }) {
  const flagList = Array.isArray(flags)
    ? (flags as Array<{ kind?: unknown; messageId?: unknown; excerpt?: unknown }>).filter(
        (flag) => typeof flag?.excerpt === "string",
      )
    : [];
  const preview = (revision?.preview ?? {}) as { citations?: unknown };
  const citations = Array.isArray(preview.citations)
    ? (preview.citations as Array<{ title?: unknown; text?: unknown }>).filter((c) => typeof c?.title === "string")
    : [];
  if (flagList.length === 0 && citations.length === 0) return null;
  return (
    <div className="mb-3 grid gap-2 text-[13px]">
      {flagList.length > 0 ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
          <p className="mb-1 text-xs font-medium">
            The thread asked for something - quoted here, never acted on:
          </p>
          <ul className="grid gap-1 text-xs text-muted-foreground">
            {flagList.map((flag, i) => (
              <li key={i}>&ldquo;{flag.excerpt as string}&rdquo;</li>
            ))}
          </ul>
        </div>
      ) : null}
      {citations.length > 0 ? (
        <div className="rounded-md border border-border bg-muted/40 p-3">
          <p className="mb-1 text-xs font-medium">Grounded in the library:</p>
          <ul className="grid gap-1 text-xs text-muted-foreground">
            {citations.map((citation, i) => (
              <li key={i}>
                [{i + 1}] {citation.title as string}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

const riskLabel: Record<string, string> = {
  read: "Read",
  prepare: "Prepare",
  external_write: "External write",
  sensitive_write: "Sensitive write",
  prohibited: "Prohibited",
};

type DecideInput = { proposalId: string; decision: "approved" | "rejected"; note: string };

function ProposalCard({
  item,
  error,
  outcome,
  decide,
}: {
  item: QueueCardData;
  error: string | null;
  outcome: EffectOutcome | null;
  decide: (input: DecideInput) => void;
}) {
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const [payloadText, setPayloadText] = useState(() =>
    item.latestRevision ? JSON.stringify(item.latestRevision.payload, null, 2) : "",
  );
  const [confirmedSensitive, setConfirmedSensitive] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [revising, startRevision] = useTransition();
  const revisionKey = useRef<string | null>(null);
  const pending = item.status === "pending";
  const sensitive = item.riskClass === "sensitive_write";
  const expired = item.expired;

  function onSaveRevision() {
    setRevisionError(null);
    if (!revisionKey.current) revisionKey.current = crypto.randomUUID();
    const idempotencyKey = revisionKey.current;
    startRevision(async () => {
      const result = await reviseProposalAction({
        idempotencyKey,
        proposalId: item.id,
        expectedVersion: item.version,
        payloadText,
      });
      if (!result.ok) {
        setRevisionError(result.error);
        return;
      }
      setEditing(false);
      revisionKey.current = null;
    });
  }

  return (
    <Panel
      title={item.title}
      description={item.expectedEffect}
      actions={
        <span className="flex items-center gap-2">
          <Status>{item.status === "pending" ? "Pending" : item.status}</Status>
          <Status>{riskLabel[item.riskClass] ?? item.riskClass}</Status>
        </span>
      }
    >
      <p className="mb-3 text-xs text-muted-foreground">
        {item.capability}
        {item.accountAlias ? ` · ${item.accountAlias}` : ""}
        {item.proposedBy ? ` · proposed by ${item.proposedBy}` : ""}
        {" · "}
        {formatTs(item.createdAt)}
        {item.latestRevision ? ` · revision ${item.latestRevision.revisionNumber}` : " · no payload revision"}
        {item.expiresAt ? ` · expires ${formatTs(item.expiresAt)}` : ""}
      </p>

      {item.decisionOnly ? (
        <p className="mb-3 text-xs text-muted-foreground">
          {item.capability === "github.issue.triage"
            ? "Approving records the decision only. Nothing changes on GitHub - labels, assignees, and close state stay exactly as they are until you apply them there."
            : "Approving records the decision only. This proposal has no executor, so nothing outside Polymath changes when you approve."}
        </p>
      ) : null}
      <SendSummary capability={item.capability} revision={item.latestRevision} />
      <DraftGrounding flags={item.flags} revision={item.latestRevision} />
      <NotionDiff capability={item.capability} revision={item.latestRevision} />

      {item.latestRevision ? (
        <details className="mb-4 text-[13px]">
          <summary className="cursor-pointer">Inspect the exact payload</summary>
          <pre className="mt-3 max-h-72 overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 font-mono text-xs">
            {JSON.stringify(item.latestRevision.payload, null, 2)}
          </pre>
          {item.latestRevision.preview ? (
            <pre className="mt-2 max-h-48 overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 font-mono text-xs">
              {JSON.stringify(item.latestRevision.preview, null, 2)}
            </pre>
          ) : null}
        </details>
      ) : null}

      {pending ? (
        <div className="grid gap-3">
          <Field label="Decision note (optional)">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} className="min-h-16" />
          </Field>
          {sensitive ? (
            <Check
              label="I inspected the exact payload. This is a sensitive write."
              checked={confirmedSensitive}
              onChange={setConfirmedSensitive}
            />
          ) : null}
          {expired ? <p className="text-xs text-muted-foreground">Past its expiry; the executor would refuse it.</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={item.latestRevision === null || (sensitive && !confirmedSensitive)}
              onClick={() => decide({ proposalId: item.id, decision: "approved", note })}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => decide({ proposalId: item.id, decision: "rejected", note })}
            >
              Reject
            </Button>
            <Button size="sm" variant="ghost" disabled={!item.latestRevision} onClick={() => setEditing(!editing)}>
              {editing ? "Close editor" : "Edit payload"}
            </Button>
          </div>
          {editing && item.latestRevision ? (
            <div className="grid gap-2 border-t border-border pt-3">
              <Field label={`New payload revision (current: ${item.latestRevision.revisionNumber})`}>
                <Textarea
                  className="min-h-56 font-mono text-xs"
                  value={payloadText}
                  maxLength={100000}
                  onChange={(e) => setPayloadText(e.target.value)}
                />
              </Field>
              <p className="text-xs text-muted-foreground">
                Saving appends an immutable revision and invalidates decisions rendered against the old one.
              </p>
              <div>
                <Button size="sm" variant="outline" disabled={revising} onClick={onSaveRevision}>
                  {revising ? "Saving revision…" : "Save new revision"}
                </Button>
              </div>
              {revisionError ? (
                <p role="alert" className="text-xs text-destructive">
                  {revisionError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="text-[13px]">
          <p className="text-xs text-muted-foreground">Decided {item.decidedAt ? formatTs(item.decidedAt) : "—"}</p>
          {item.reviews.length > 0 ? (
            <ul className="mt-2 grid gap-1.5">
              {item.reviews.map((review) => (
                <li key={review.id} className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{review.decision}</span>
                  {review.note ? ` - ${review.note}` : ""} · {formatTs(review.createdAt)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {outcome ? (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          {outcomeLine(item.capability, outcome)}
          {outcome.status === "sent" && item.capability === "canva.design.import" && item.designUrl ? (
            <>
              {" "}
              <a href={item.designUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                Open the design in Canva
              </a>
            </>
          ) : null}
        </p>
      ) : null}
    </Panel>
  );
}

export function ReviewsQueue({ items, emptyState }: { items: QueueCardData[]; emptyState: ReactNode }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  /*
   * Snapshots of decided cards held past the revalidate that drops them
   * from the filtered server list - the refusal alert or import outcome
   * must not unmount in the same beat it arrives. State, not a ref: the
   * merge below reads it during render. See held-cards.ts.
   */
  const [heldCards, setHeldCards] = useState<HeldCards>({});
  // A decide response fills the gap until the next server render: the
  // attempt commits before the response returns, so any rendered persisted
  // outcome is the same truth or newer (e.g. reconciled by the sweep after
  // the reviewer decided). Persisted therefore wins whenever it exists, and
  // a stale decide response can never mask a reconciled terminal truth.
  const [decideOutcomes, setDecideOutcomes] = useState<Record<string, EffectOutcome>>({});
  /*
   * Post-action decided truth, keyed by proposal revision so a re-proposed
   * card (new version) is never masked. useOptimistic reverts to the server
   * items when the action settles; without this overlay a decided card would
   * flicker back to actionable - and, on a committed refusal, the refresh
   * would unmount the card and take the refusal alert with it. The overlay
   * holds the decided view + the alert until the next real server render,
   * where the persisted row says the same thing.
   */
  const [decidedCards, setDecidedCards] = useState<Record<string, "approved" | "rejected">>({});
  const decisionKeys = useRef<Record<string, { key: string; version: number }>>({});
  const [optimisticItems, applyDecision] = useOptimistic(items, (current: QueueCardData[], event: DecideInput) =>
    current.map((item) =>
      item.id === event.proposalId ? { ...item, status: event.decision, decidedAt: new Date().toISOString() } : item,
    ),
  );

  function keyFor(item: QueueCardData): string {
    const stored = decisionKeys.current[item.id];
    if (!stored || stored.version !== item.version) {
      decisionKeys.current[item.id] = { key: crypto.randomUUID(), version: item.version };
    }
    return decisionKeys.current[item.id].key;
  }

  function decide(input: DecideInput) {
    const item = items.find((candidate) => candidate.id === input.proposalId);
    if (!item?.latestRevision) {
      setErrors((prev) => ({ ...prev, [input.proposalId]: "This proposal has no payload revision to approve." }));
      return;
    }
    const idempotencyKey = keyFor(item);
    const { version } = item;
    const revisionId = item.latestRevision.id;
    setErrors((prev) => {
      const next = { ...prev };
      delete next[input.proposalId];
      return next;
    });
    startTransition(async () => {
      applyDecision(input);
      const result = await decideProposalAction({
        idempotencyKey,
        proposalId: input.proposalId,
        expectedVersion: version,
        revisionId,
        decision: input.decision,
        note: input.note.trim() || undefined,
      });
      if (!result.ok) {
        setErrors((prev) => ({ ...prev, [input.proposalId]: result.error }));
        if (result.decided) {
          // The approval/rejection committed; only the effect refused. Keep
          // the decided card and its refusal visible - the approval stands -
          // and hold it past the revalidate that drops it from this filter.
          setHeldCards((prev) => {
            const next = { ...prev };
            holdDecidedCard(next, item, input.decision);
            return next;
          });
          setDecidedCards((prev) => ({ ...prev, [`${input.proposalId}:${version}`]: input.decision }));
        } else {
          // The decision itself never landed; resync to the server truth.
          router.refresh();
        }
        return;
      }
      setDecidedCards((prev) => ({ ...prev, [`${input.proposalId}:${version}`]: input.decision }));
      if (result.outcome) {
        // An effect outcome is post-decision feedback: hold the card past
        // the revalidate. A decision-only success carries nothing to show
        // and drains from the pending queue, by design.
        setHeldCards((prev) => {
          const next = { ...prev };
          holdDecidedCard(next, item, input.decision);
          return next;
        });
        setDecideOutcomes((prev) => ({ ...prev, [input.proposalId]: result.outcome! }));
      }
    });
  }

  /*
   * The follow-up pair renders as one group (ASH-288): the email and the
   * reminder were proposed together, so the reviewer judges them together -
   * while each card keeps its own approve/reject. Grouping keys off the
   * shared dedupe suffix (the session id), never off adjacency or timing.
   */
  const followUpGroup = /^(?:calendar:)?followup-(?:email|reminder):(.+)$/;
  type Row = { kind: "single"; item: QueueCardData } | { kind: "group"; key: string; items: QueueCardData[] };
  const rows: Row[] = [];
  const groups = new Map<string, Extract<Row, { kind: "group" }>>();
  const merged = mergeHeldDecidedCards(
    optimisticItems.map((raw) => {
      const decided = decidedCards[`${raw.id}:${raw.version}`];
      return decided ? { ...raw, status: decided, decidedAt: raw.decidedAt ?? new Date().toISOString() } : raw;
    }),
    heldCards,
  );
  for (const item of merged) {
    const match = item.dedupeKey ? followUpGroup.exec(item.dedupeKey) : null;
    if (!match) {
      rows.push({ kind: "single", item });
      continue;
    }
    const key = match[1];
    let group = groups.get(key);
    if (!group) {
      group = { kind: "group", key, items: [] };
      groups.set(key, group);
      rows.push(group);
    }
    group.items.push(item);
  }

  const card = (item: QueueCardData) => (
    <ProposalCard
      key={`${item.id}-${item.version}`}
      item={item}
      error={errors[item.id] ?? null}
      outcome={item.outcome ?? decideOutcomes[item.id] ?? null}
      decide={decide}
    />
  );

  if (rows.length === 0) return <>{emptyState}</>;

  return (
    <div className="flex flex-col gap-4">
      {rows.map((row) =>
        row.kind === "single" ? (
          card(row.item)
        ) : row.items.length === 1 ? (
          card(row.items[0])
        ) : (
          <section
            key={`followup-${row.key}`}
            aria-label="Follow-up pair"
            className="border-border flex flex-col gap-3 rounded-md border border-dashed p-3"
          >
            <p className="text-muted-foreground text-[12px]">
              One finished session proposed this pair. Each half is approved or rejected on its own.
            </p>
            {row.items.map(card)}
          </section>
        ),
      )}
    </div>
  );
}
