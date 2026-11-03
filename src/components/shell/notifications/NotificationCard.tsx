"use client";

import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { timeAgoShort } from "@/lib/time";

/*
 * One triage card, the atom of the notifications sheet rebuild (spec
 * art_psA7CtqO section 2). Purely presentational: every card receives its data
 * and its callbacks as props, fetches nothing, and reads no global state, so
 * the feed work can evolve behind it and the panel composes it verbatim.
 *
 * The root is a listbox option styled by .command-result (globals.css), which
 * paints the hover and aria-selected states the panel's j/k navigation drives.
 * That class is unlayered CSS, so the inner wrapper, not utilities on the
 * root, owns the card's column layout.
 */

/**
 * The run_state enum's values, restated locally. A state added to the enum
 * fails to typecheck against this union at the feed's mapping site until the
 * pill map below answers for it, which keeps drift loud without coupling a
 * presentational component to the database schema.
 */
export type RunState =
  "queued" | "running" | "waiting_input" | "waiting_approval" | "succeeded" | "failed" | "cancelled";

type NotificationCardBase = {
  /** The option's DOM id, so the panel can point aria-activedescendant at it. */
  id: string;
  /** When the item happened; the ribbon shows it relative. */
  askedAt: Date;
  selected?: boolean;
};

export type NotificationCardProps = NotificationCardBase &
  (
    | {
        kind: "question";
        questionText: string;
        /** The specific missing input the agent supplied alongside the prompt. */
        context?: string | null;
        /** Submits the one-line answer; the run resumes (PR3 wires the action). */
        onReply: (answer: string) => void;
        onDismiss: () => void;
        onOpen: () => void;
      }
    | {
        kind: "decision";
        decisionType: "action" | "capture";
        title: string;
        detail: string | null;
        expired: boolean;
        /** Intent, not verdict vocabulary: the panel maps to approved/accepted. */
        onDecide: (decision: "approve" | "reject") => void;
        onOpen: () => void;
      }
    | {
        kind: "run";
        runState: RunState;
        /** The objective label from the feed, used when no summary exists. */
        title: string;
        /** The agent's own one-line account; the heading prefers it. */
        summary: string | null;
        /** The redacted failure detail; only failed runs carry one today. */
        detail?: string | null;
        onOpen: () => void;
      }
  );

type PillTone = "pill-neutral" | "pill-violet" | "pill-working" | "pill-success" | "pill-danger";

const RUN_STATE_PILLS: Record<RunState, { label: string; tone: PillTone }> = {
  queued: { label: "Queued", tone: "pill-neutral" },
  running: { label: "Running", tone: "pill-working" },
  waiting_input: { label: "Waiting on you", tone: "pill-violet" },
  waiting_approval: { label: "Waiting on your approval", tone: "pill-violet" },
  succeeded: { label: "Finished", tone: "pill-success" },
  failed: { label: "Failed", tone: "pill-danger" },
  cancelled: { label: "Cancelled", tone: "pill-neutral" },
};

const RUN_TERMINAL_STATES: ReadonlySet<RunState> = new Set(["succeeded", "failed", "cancelled"]);

function statePill(props: NotificationCardProps): { label: string; tone: PillTone } {
  switch (props.kind) {
    case "question":
      return { label: "Needs you", tone: "pill-violet" };
    case "decision":
      return props.expired
        ? { label: "Expired", tone: "pill-neutral" }
        : { label: "Waiting on you", tone: "pill-violet" };
    case "run":
      return RUN_STATE_PILLS[props.runState];
    default: {
      const _exhaustive: never = props;
      return _exhaustive;
    }
  }
}

/** The three pill sources the spec names: the agent speaks and proposes, captures come from the inbox, runs are runs. */
function sourceLabel(props: NotificationCardProps): string {
  switch (props.kind) {
    case "question":
      return "Agent";
    case "decision":
      return props.decisionType === "capture" ? "Capture" : "Agent";
    case "run":
      return "Run";
    default: {
      const _exhaustive: never = props;
      return _exhaustive;
    }
  }
}

function heading(props: NotificationCardProps): string {
  switch (props.kind) {
    case "question":
      return props.questionText;
    case "decision":
      return props.title;
    case "run":
      return props.summary ?? props.title;
    default: {
      const _exhaustive: never = props;
      return _exhaustive;
    }
  }
}

function detail(props: NotificationCardProps): string | null {
  if (props.kind === "decision") return props.detail;
  if (props.kind === "question") return props.context ?? null;
  if (props.kind === "run") return props.detail ?? null;
  return null;
}

/**
 * PR3 focuses the selected question's reply with the r key by this id
 * (`${id}-reply`), so the contract is deterministic without a ref registry.
 */
function replyInputId(id: string): string {
  return `${id}-reply`;
}

function OpenOverflowButton({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <Button type="button" variant="ghost" size="sm" className="ml-auto text-muted-foreground" onClick={onOpen}>
      {label}
      <ArrowUpRight aria-hidden className="size-3.5" />
    </Button>
  );
}

function QuestionActionBar({
  id,
  onReply,
  onDismiss,
  onOpen,
}: Pick<Extract<NotificationCardProps, { kind: "question" }>, "id" | "onReply" | "onDismiss" | "onOpen">) {
  const [draft, setDraft] = useState("");
  const answer = draft.trim();

  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!answer) return;
        onReply(answer);
        setDraft("");
      }}
    >
      <Input
        id={replyInputId(id)}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Type a reply"
        aria-label="Reply to the agent"
        className="h-7 text-body-dense"
      />
      <Button type="submit" size="sm" disabled={!answer}>
        Reply
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
      <OpenOverflowButton label="Open run" onOpen={onOpen} />
    </form>
  );
}

function DecisionActionBar({
  expired,
  onDecide,
  onOpen,
}: Pick<Extract<NotificationCardProps, { kind: "decision" }>, "expired" | "onDecide" | "onOpen">) {
  return (
    <div className="flex items-center gap-1.5">
      <Button type="button" size="sm" disabled={expired} onClick={() => onDecide("approve")}>
        Approve
      </Button>
      <Button type="button" variant="outline" size="sm" disabled={expired} onClick={() => onDecide("reject")}>
        Reject
      </Button>
      {expired ? <span className="text-data text-muted-foreground">Expired; open it to re-propose.</span> : null}
      <OpenOverflowButton label="Open context" onOpen={onOpen} />
    </div>
  );
}

function RunActionBar({ runState, onOpen }: { runState: RunState; onOpen: () => void }) {
  if (RUN_TERMINAL_STATES.has(runState)) return <OpenOverflowButton label="Open" onOpen={onOpen} />;

  return (
    <div className="flex items-center gap-1.5">
      {/* The spec's pulse dot, in .pill-violet's own colours (light and dark). */}
      <span
        aria-hidden
        className="size-2 shrink-0 animate-pulse rounded-full bg-[oklch(0.62_0.11_300)] dark:bg-[oklch(0.72_0.10_300)]"
      />
      <OpenOverflowButton label="Open" onOpen={onOpen} />
    </div>
  );
}

function actionBar(props: NotificationCardProps) {
  switch (props.kind) {
    case "question":
      return (
        <QuestionActionBar id={props.id} onReply={props.onReply} onDismiss={props.onDismiss} onOpen={props.onOpen} />
      );
    case "decision":
      return <DecisionActionBar expired={props.expired} onDecide={props.onDecide} onOpen={props.onOpen} />;
    case "run":
      return <RunActionBar runState={props.runState} onOpen={props.onOpen} />;
    default: {
      const _exhaustive: never = props;
      return _exhaustive;
    }
  }
}

export function NotificationCard(props: NotificationCardProps) {
  const pill = statePill(props);
  const detailText = detail(props);

  return (
    <div id={props.id} role="option" aria-selected={Boolean(props.selected)} className="command-result">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <span className="pill pill-violet">{sourceLabel(props)}</span>
          <span className={cn("pill", pill.tone)}>{pill.label}</span>
          <time
            dateTime={props.askedAt.toISOString()}
            className="readout ml-auto shrink-0 text-data text-muted-foreground"
          >
            {timeAgoShort(props.askedAt)}
          </time>
        </div>
        <h4 className="line-clamp-1 text-body-dense font-medium leading-snug text-foreground">{heading(props)}</h4>
        {detailText ? (
          <p className="line-clamp-2 text-label leading-relaxed text-muted-foreground">{detailText}</p>
        ) : null}
        {actionBar(props)}
      </div>
    </div>
  );
}
