"use client";

import { useState } from "react";
import { AlertCircle, Check, Loader2, ShieldQuestion } from "lucide-react";
import { cn } from "cn";

/*
 * The confirmation card, for a run that has stopped and is waiting on a person.
 *
 * Two cases share one shape because they are the same moment from the reader's
 * side — the agent did not decide this alone:
 *   - a durable question: the run needs missing input to continue
 *   - a pending proposal: the run wants to change something outside the
 *     workspace, and nothing happens until it is approved
 *
 * Neither is auto-accepted. A card that resolved itself would break the one
 * promise this surface makes (agents propose, policy disposes), so every path
 * here ends in an explicit press.
 */

export type InterruptKind = "question" | "approval";

export type InterruptCard = {
  id: string;
  kind: InterruptKind;
  title: string;
  /** The specific thing being asked or approved; one or two sentences. */
  body: string;
  /** Fixed choices, when the agent offered them. */
  options?: string[];
  /** Where approving or rejecting actually happens, for an approval. */
  href?: string;
};

export function Confirmation({
  card,
  onAnswer,
  onResolve,
}: {
  card: InterruptCard;
  onAnswer?: (answer: string) => Promise<{ ok: boolean; message?: string }>;
  onResolve?: (decision: "approved" | "rejected") => Promise<{ ok: boolean; message?: string }>;
}) {
  const [answer, setAnswer] = useState("");
  const [pending, setPending] = useState<null | "answer" | "approved" | "rejected">(null);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState<null | "answered" | "approved" | "rejected">(null);

  async function run(kind: null | "answer" | "approved" | "rejected", action: () => Promise<{ ok: boolean; message?: string }>) {
    setPending(kind);
    setError(null);
    const result = await action();
    setPending(null);
    if (!result.ok) {
      setError(result.message ?? "That did not go through. Try again.");
      return;
    }
    setSettled(kind === "answer" ? "answered" : kind === "approved" ? "approved" : "rejected");
  }

  const Icon = card.kind === "question" ? ShieldQuestion : AlertCircle;
  const settledLabel =
    settled === "approved" ? "Approved" : settled === "rejected" ? "Rejected" : settled === "answered" ? "Answered" : null;

  return (
    <div
      className={cn(
        "border-border bg-card rounded-lg border px-3.5 py-3",
        settled === "rejected" && "opacity-70",
      )}
      role="group"
      aria-label={card.kind === "question" ? "The agent needs an answer" : "The agent needs approval"}
    >
      <p className="flex items-center gap-2 text-[13px] font-medium">
        <Icon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{card.title}</span>
        {settledLabel ? (
          <span className="text-muted-foreground shrink-0 text-[11px]">{settledLabel}</span>
        ) : null}
      </p>
      <p className="text-muted-foreground mt-1 text-[13px] leading-5">{card.body}</p>

      {settled ? null : card.kind === "question" ? (
        <div className="mt-2.5 flex flex-col gap-2">
          {card.options && card.options.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {card.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  disabled={pending !== null}
                  onClick={() => {
                    setAnswer(option);
                    void run("answer", () => onAnswer?.(option) ?? Promise.resolve({ ok: false, message: "This conversation cannot take an answer." }));
                  }}
                  className="border-border hover:bg-muted focus-visible:ring-ring inline-flex h-7 items-center rounded-md border px-2.5 text-[13px] outline-none transition-colors focus-visible:ring-2 disabled:opacity-50"
                >
                  {option}
                </button>
              ))}
            </div>
          ) : (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (!answer.trim()) return;
                void run("answer", () => onAnswer?.(answer.trim()) ?? Promise.resolve({ ok: false, message: "This conversation cannot take an answer." }));
              }}
            >
              <input
                aria-label="Your answer"
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                placeholder="Answer to continue"
                className="border-input bg-background focus-visible:ring-ring h-8 min-w-0 flex-1 rounded-md border px-2.5 text-[13px] outline-none focus-visible:ring-2"
              />
              <button
                type="submit"
                disabled={!answer.trim() || pending !== null}
                className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-[13px] outline-none transition-colors focus-visible:ring-2 disabled:opacity-50"
              >
                {pending === "answer" ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null}
                Send
              </button>
            </form>
          )}
        </div>
      ) : (
        <div className="mt-2.5 flex items-center gap-1.5">
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => void run("rejected", () => onResolve?.("rejected") ?? Promise.resolve({ ok: false, message: "This proposal is decided in Reviews." }))}
            className="border-border hover:bg-muted focus-visible:ring-ring inline-flex h-8 items-center rounded-md border px-2.5 text-[13px] outline-none transition-colors focus-visible:ring-2 disabled:opacity-50"
          >
            Reject
          </button>
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => void run("approved", () => onResolve?.("approved") ?? Promise.resolve({ ok: false, message: "This proposal is decided in Reviews." }))}
            className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-[13px] outline-none transition-colors focus-visible:ring-2 disabled:opacity-50"
          >
            {pending === "approved" ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Check aria-hidden className="size-3.5" />}
            Approve
          </button>
          {card.href ? (
            <a href={card.href} className="text-muted-foreground hover:text-foreground ml-1 text-[12px] underline-offset-2 hover:underline">
              Review in full
            </a>
          ) : null}
        </div>
      )}

      {error ? (
        <p role="alert" className="text-destructive mt-2 text-[12px]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
