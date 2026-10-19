"use client";

import { useRouter } from "next/navigation";
import { useOptimistic, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Check } from "@/components/products/command-center/controls";
import { Field, Panel, Status } from "@/components/workspace/ui";
import { decideProposalAction, reviseProposalAction } from "./actions";

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
  accountAlias: string | null;
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
  expired: boolean;
  latestRevision: { id: string; revisionNumber: number; payload: unknown; preview: unknown } | null;
  proposedBy: string | null;
  reviews: Array<{ id: string; decision: string; note: string | null; createdAt: string }>;
};

function formatTs(iso: string): string {
  // UTC everywhere: server and client must render the same string.
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
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
  decide,
}: {
  item: QueueCardData;
  error: string | null;
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
    </Panel>
  );
}

export function ReviewsQueue({ items }: { items: QueueCardData[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
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
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {optimisticItems.map((item) => (
        <ProposalCard key={`${item.id}-${item.version}`} item={item} error={errors[item.id] ?? null} decide={decide} />
      ))}
    </div>
  );
}
