"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  acceptDocumentObligation,
  acceptField,
  acceptZettelAction,
  proposeZettelsAction,
  rejectZettelAction,
  acceptPartyDecision,
  acceptClassificationAction,
  applyTitleAction,
  rejectClassificationAction,
  deferField,
  rejectDocumentObligation,
  rejectField,
} from "./actions";

/*
 * The workbench's decision controls. One shared error line per group: a
 * decision that was already made (double-submit, stale tab) says so and asks
 * for a reload — it never silently "succeeds".
 */

function useDecision() {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  async function run(key: string, action: () => Promise<unknown>) {
    setPending(key);
    setError(null);
    try {
      await action();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
    } finally {
      setPending(null);
    }
  }

  return { pending, error, errorId, run, setError };
}

function ErrorLine({ id, error }: { id: string; error: string | null }) {
  if (!error) return null;
  return (
    <p id={id} role="alert" className="text-destructive text-xs">
      {error}
    </p>
  );
}

/** Accept / Edit (type a correction) / Reject / Defer for one field proposal. */
export function FieldDecisions({
  proposalId,
  fieldName,
  readable,
}: {
  proposalId: string;
  fieldName: string;
  /** False when normalizedValue is null and the note explains why. */
  readable: boolean;
}) {
  const { pending, error, errorId, run } = useDecision();
  const [editing, setEditing] = useState(false);
  const [correction, setCorrection] = useState("");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="xs"
          disabled={pending !== null}
          aria-describedby={!readable && !editing ? errorId : undefined}
          onClick={() =>
            run(`accept-${proposalId}`, () => acceptField(proposalId, editing ? correction : undefined))
          }
        >
          {pending === `accept-${proposalId}` ? "Accepting…" : "Accept"}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          aria-expanded={editing}
          disabled={pending !== null}
          onClick={() => setEditing((value) => !value)}
        >
          Edit
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={pending !== null}
          onClick={() => run(`reject-${proposalId}`, () => rejectField(proposalId))}
        >
          {pending === `reject-${proposalId}` ? "Rejecting…" : "Reject"}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={pending !== null}
          onClick={() => run(`defer-${proposalId}`, () => deferField(proposalId))}
        >
          {pending === `defer-${proposalId}` ? "Deferring…" : "Decide later"}
        </Button>
      </div>
      {editing ? (
        <div className="flex items-center gap-1.5">
          <label htmlFor={`correction-${proposalId}`} className="sr-only">
            Corrected value for {fieldName}
          </label>
          <Input
            id={`correction-${proposalId}`}
            value={correction}
            onChange={(event) => setCorrection(event.target.value)}
            placeholder="Corrected value"
            className="h-7 max-w-64 text-xs"
          />
          <Button
            type="button"
            size="xs"
            disabled={pending !== null || correction.trim().length === 0}
            onClick={() => run(`accept-${proposalId}`, () => acceptField(proposalId, correction))}
          >
            Save value
          </Button>
        </div>
      ) : null}
      {!readable && !editing ? (
        <p id={errorId} className="text-muted-foreground text-xs">
          This value could not be read with confidence. Type the value to accept it.
        </p>
      ) : null}
      <ErrorLine id={errorId} error={error} />
    </div>
  );
}

/** The obligation decision: accept (with an optional due date) or reject. */
export function ObligationDecisions({ obligationId }: { obligationId: string }) {
  const { pending, error, errorId, run } = useDecision();
  const [dueAt, setDueAt] = useState("");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="xs"
          disabled={pending !== null}
          onClick={() => run(`accept-${obligationId}`, () => acceptDocumentObligation(obligationId, dueAt || undefined))}
        >
          {pending === `accept-${obligationId}` ? "Accepting…" : "Accept"}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={pending !== null}
          onClick={() => run(`reject-${obligationId}`, () => rejectDocumentObligation(obligationId))}
        >
          {pending === `reject-${obligationId}` ? "Rejecting…" : "Reject"}
        </Button>
      </div>
      <div className="flex items-center gap-1.5">
        <label htmlFor={`due-${obligationId}`} className="text-muted-foreground text-xs">
          Due
        </label>
        <Input
          id={`due-${obligationId}`}
          type="date"
          value={dueAt}
          onChange={(event) => setDueAt(event.target.value)}
          className="h-7 w-40 text-xs"
        />
      </div>
      <ErrorLine id={errorId} error={error} />
    </div>
  );
}

/** Party resolution: match an existing record, create one, or reject the extraction. */
export function PartyDecisions({
  partyId,
  displayName,
  partyKind,
  options,
}: {
  partyId: string;
  displayName: string;
  partyKind: "contact" | "company";
  options: { kind: "contact" | "company"; id: string; name: string; via: string }[];
}) {
  const { pending, error, errorId, run } = useDecision();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {options.map((option) => (
          <Button
            key={option.id}
            type="button"
            size="xs"
            variant="outline"
            disabled={pending !== null}
            onClick={() =>
              run(
                `match-${partyId}-${option.id}`,
                () =>
                  acceptPartyDecision(partyId, {
                    action: "match",
                    ...(option.kind === "contact" ? { contactId: option.id } : { companyId: option.id }),
                  }),
              )
            }
          >
            Match {option.name}
          </Button>
        ))}
        <Button
          type="button"
          size="xs"
          disabled={pending !== null}
          onClick={() =>
            run(
              `create-${partyId}`,
              () =>
                acceptPartyDecision(partyId, {
                  action: "create",
                  ...(partyKind === "contact" ? { contact: { fullName: displayName } } : { company: { name: displayName } }),
                }),
            )
          }
        >
          {pending === `create-${partyId}` ? "Creating…" : `Create new ${partyKind}`}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={pending !== null}
          onClick={() => run(`reject-${partyId}`, () => acceptPartyDecision(partyId, { action: "reject" }))}
        >
          {pending === `reject-${partyId}` ? "Rejecting…" : "Not this"}
        </Button>
      </div>
      <ErrorLine id={errorId} error={error} />
    </div>
  );
}

/** "Apply suggested title" — the one version-checked write on the panel. */
export function ApplyTitleButton({
  documentId,
  title,
  expectedVersion,
}: {
  documentId: string;
  title: string;
  expectedVersion: number;
}) {
  const { pending, error, errorId, run } = useDecision();

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={pending !== null}
        onClick={() => run("apply-title", () => applyTitleAction(documentId, title, expectedVersion))}
      >
        {pending === "apply-title" ? "Applying…" : `Apply suggested title: ${title}`}
      </Button>
      <ErrorLine id={errorId} error={error} />
    </div>
  );
}

/** Accept / Reject one proposed zettel. Reject writes nothing but the decision. */
export function ZettelDecisions({ proposalId }: { proposalId: string }) {
  const { pending, error, errorId, run } = useDecision();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button type="button" size="xs" disabled={pending !== null} onClick={() => run(`accept-${proposalId}`, () => acceptZettelAction(proposalId))}>
          {pending === `accept-${proposalId}` ? "Accepting…" : "Accept"}
        </Button>
        <Button type="button" size="xs" variant="outline" disabled={pending !== null} onClick={() => run(`reject-${proposalId}`, () => rejectZettelAction(proposalId))}>
          {pending === `reject-${proposalId}` ? "Rejecting…" : "Reject"}
        </Button>
      </div>
      <ErrorLine id={errorId} error={error} />
    </div>
  );
}

/** Ask for zettel proposals from this document. */
export function ProposeZettelsButton({ documentId }: { documentId: string }) {
  const { pending, error, errorId, run } = useDecision();
  return (
    <div className="flex flex-col gap-1">
      <Button type="button" size="xs" variant="outline" className="w-fit" disabled={pending !== null} onClick={() => run("propose", () => proposeZettelsAction(documentId))}>
        {pending === "propose" ? "Reading…" : "Propose zettels"}
      </Button>
      <ErrorLine id={errorId} error={error} />
    </div>
  );
}

/** Accept / Reject the proposed document type (B02). Accept sets the one doc-type signal obligations and naming read. */
export function ClassificationDecisions({
  proposalId,
  proposedType,
  confidence,
  signals,
  expectedVersion,
}: {
  proposalId: string;
  proposedType: string;
  confidence: string;
  signals: string[];
  expectedVersion: number;
}) {
  const { pending, error, errorId, run } = useDecision();

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">
        Classified as <span className="font-medium text-foreground">{proposedType}</span>
        {confidence ? ` (${confidence} confidence)` : ""}
        {signals.length > 0 ? ` - basis: ${signals.join(", ")}` : ""}. Accept to use it for obligations and titles.
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={pending !== null}
          onClick={() => run("accept-classification", () => acceptClassificationAction(proposalId, expectedVersion))}
        >
          {pending === "accept-classification" ? "Accepting…" : "Accept type"}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={pending !== null}
          onClick={() => run("reject-classification", () => rejectClassificationAction(proposalId, expectedVersion))}
        >
          {pending === "reject-classification" ? "Rejecting…" : "Not this type"}
        </Button>
      </div>
      <ErrorLine id={errorId} error={error} />
    </div>
  );
}
