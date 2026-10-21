"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { answer, SUGGESTED_PROMPTS, type AssistEvent } from "@/domains/calendar/assist";
import { addBlockAction, approveProposalAction, rejectProposalAction } from "./calendar-actions";

export type PendingProposal = { id: string; version: number; revisionId: string; title: string; effect: string };

/*
 * The week view's toolbar: add a block, ask Calendar Assist, and approve what
 * agents have proposed. Assist answers come from the week's real events (no
 * model call). Agent proposals show as one-tap chips: nothing an agent
 * proposes touches the calendar until Approve is tapped.
 */
export function CalendarToolbar({ events, proposals }: { events: AssistEvent[]; proposals: PendingProposal[] }) {
  const [open, setOpen] = useState<"assist" | "add" | null>(null);
  const [prompt, setPrompt] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function ask(text: string) {
    if (!text.trim()) return;
    setPrompt(text);
    setReply(answer(text, { events, now: new Date(), utcOffsetMinutes: -new Date().getTimezoneOffset() }));
  }

  function decide(p: PendingProposal, approve: boolean) {
    setNote(null);
    startTransition(async () => {
      const input = { proposalId: p.id, expectedVersion: p.version, revisionId: p.revisionId };
      const result = approve ? await approveProposalAction(input) : await rejectProposalAction(input);
      if (!result.ok) return setNote(result.error);
      // An unknown outcome is not success: the change may have landed, and the
      // owner must not be told it did until reconciliation says so.
      if (approve && "status" in result && result.status === "unknown") {
        return setNote("Approved. The result is unknown; reconcile before retrying.");
      }
      setNote(approve ? "Approved and added to your calendar." : "Rejected.");
    });
  }

  function add(form: HTMLFormElement) {
    const data = new FormData(form);
    const day = String(data.get("day"));
    const start = new Date(`${day}T${data.get("start")}`);
    const end = new Date(`${day}T${data.get("end")}`);
    setNote(null);
    startTransition(async () => {
      const result = await addBlockAction({
        title: String(data.get("title") ?? ""),
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        idempotencyKey: crypto.randomUUID(),
      });
      if (result.ok) {
        form.reset();
        setOpen(null);
      } else setNote(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setOpen(open === "add" ? null : "add")}>+ Add block</Button>
        <Button size="sm" variant="outline" onClick={() => setOpen(open === "assist" ? null : "assist")}>AI Assistant</Button>
      </div>

      {proposals.length > 0 ? (
        <ul className="flex flex-col gap-1.5" aria-label="Agent proposals">
          {proposals.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-[13px]">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{p.title}</span>
                <span className="ml-2 text-xs text-muted-foreground">{p.effect}</span>
              </span>
              <Button size="sm" disabled={pending} onClick={() => decide(p, true)}>Approve</Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => decide(p, false)}>Reject</Button>
            </li>
          ))}
        </ul>
      ) : null}

      {open === "add" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add(e.currentTarget);
          }}
          className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3 text-[13px]"
        >
          <label className="flex flex-col gap-1">Title<input name="title" required maxLength={200} className="h-8 rounded-md border border-border bg-background px-2" /></label>
          <label className="flex flex-col gap-1">Day<input name="day" type="date" required className="h-8 rounded-md border border-border bg-background px-2" /></label>
          <label className="flex flex-col gap-1">From<input name="start" type="time" required defaultValue="09:00" className="h-8 rounded-md border border-border bg-background px-2" /></label>
          <label className="flex flex-col gap-1">To<input name="end" type="time" required defaultValue="10:00" className="h-8 rounded-md border border-border bg-background px-2" /></label>
          <Button size="sm" type="submit" disabled={pending}>Add</Button>
        </form>
      ) : null}

      {open === "assist" ? (
        <div className="rounded-lg border border-border p-3 text-[13px]" role="dialog" aria-label="Calendar AI Assistant">
          <p className="font-medium">Calendar AI Assistant</p>
          <p className="text-xs text-muted-foreground">Ask me about your schedule, find free time, or analyze your calendar.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {SUGGESTED_PROMPTS.map((s) => (
              <button key={s} type="button" onClick={() => ask(s)} className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-accent">
                {s}
              </button>
            ))}
          </div>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              ask(prompt);
            }}
          >
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Type your question or request..."
              aria-label="Ask Calendar Assist"
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2"
            />
            <Button size="sm" type="submit">Ask AI</Button>
          </form>
          {reply ? <pre className="mt-2 whitespace-pre-wrap font-sans text-[13px]">{reply}</pre> : null}
        </div>
      ) : null}
      {note ? <p role="status" className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}
