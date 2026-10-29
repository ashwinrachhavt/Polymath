"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Panel } from "@/components/workspace/ui";
import type { ShutdownPreview, ShutdownResult } from "@/domains/daybook/shutdown";
import { applyShutdownAction } from "./actions";

type Choice = "unset" | "leave" | "finish" | "abandon";

/*
 * The day is already closed (server truth, from the preview) or an apply just
 * replayed it: show the saved confirmation with its log, never a fresh form
 * whose empty apply would pile up a duplicate log. A deliberate second close
 * stays possible behind an explicit "Close the day again".
 */
function ClosedPanel({ today, logNoteId, onReopen }: { today: string; logNoteId: string; onReopen?: () => void }) {
  return (
    <Panel title="Day closed" description={`The shutdown log for ${today} is already saved.`}>
      <p className="text-sm text-muted-foreground">This day is already closed. Reopen it only when something new needs closing.</p>
      <div className="mt-4 flex gap-2">
        <Button size="sm" variant="outline" asChild><Link href={`/polymath/notes?id=${encodeURIComponent(logNoteId)}`}>Open the log</Link></Button>
        {onReopen ? <Button size="sm" variant="ghost" onClick={onReopen}>Close the day again</Button> : null}
        <Button size="sm" variant="ghost" asChild><Link href="/command-center/inbox">Back to Inbox</Link></Button>
      </div>
    </Panel>
  );
}

export function ShutdownForm({ preview }: { preview: ShutdownPreview }) {
  const [pending, startTransition] = useTransition();
  // One key per ritual attempt: a retry after a dropped response replays, never repeats.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [choice, setChoice] = useState<Choice>("unset");
  const [outcome, setOutcome] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [park, setPark] = useState<Set<string>>(new Set());
  const [seed, setSeed] = useState<Set<string>>(new Set());
  const [wantEmail, setWantEmail] = useState(false);
  const [to, setTo] = useState("");
  const [alias, setAlias] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ShutdownResult | null>(null);
  const [reopened, setReopened] = useState(false);

  const live = preview.liveSession;
  const needsChoice = Boolean(live) && choice === "unset";

  function toggle(set: Set<string>, id: string, update: (next: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    update(next);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const session =
        live && choice !== "unset"
          ? choice === "finish"
            ? { action: "finish" as const, sessionId: live.id, expectedVersion: live.version, outcome: outcome.trim() || null, nextStep: nextStep.trim() || null }
            : choice === "abandon"
              ? { action: "abandon" as const, sessionId: live.id, expectedVersion: live.version }
              : { action: "leave" as const, sessionId: live.id, expectedVersion: live.version }
          : undefined;
      const result = await applyShutdownAction({
        idempotencyKey,
        session,
        park: preview.captures.filter((c) => park.has(c.id)).map((c) => ({ captureId: c.id, expectedVersion: c.version })),
        seedTaskIds: [...seed],
        email: wantEmail ? { to, accountAlias: alias.trim() || null } : null,
      });
      if (result.ok) setDone(result.result);
      else setError(result.error);
    });
  }

  if (done) {
    if (done.replayed) return <ClosedPanel today={done.today} logNoteId={done.logNoteId} />;
    return (
      <Panel title="Day closed" description={`Shutdown log saved for ${done.today}.`}>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {done.session ? <li>Focus session: {done.session.action}</li> : null}
          <li>{done.parked} capture{done.parked === 1 ? "" : "s"} parked</li>
          <li>{done.seeded} task{done.seeded === 1 ? "" : "s"} suggested for {done.tomorrow}</li>
          {done.email.status === "proposed" ? (
            <li>
              Summary email waiting for your approval in{" "}
              <Link href="/reviews" className="underline underline-offset-2">Reviews</Link>. Nothing was sent.
            </li>
          ) : null}
          {done.email.status === "skipped" ? <li>Email not proposed: {done.email.reason}</li> : null}
        </ul>
        <div className="mt-4 flex gap-2">
          <Button size="sm" variant="outline" asChild><Link href={`/polymath/notes?id=${encodeURIComponent(done.logNoteId)}`}>Open the log</Link></Button>
          <Button size="sm" variant="ghost" asChild><Link href="/command-center/inbox">Back to Inbox</Link></Button>
        </div>
      </Panel>
    );
  }

  if (preview.closedLog && !reopened) {
    return <ClosedPanel today={preview.today} logNoteId={preview.closedLog.id} onReopen={() => setReopened(true)} />;
  }

  return (
    <div className="space-y-6">
      <Panel title="Focus session" description="A live session is never closed for you. Choose what happens to it.">
        {live ? (
          <div className="space-y-3 text-sm">
            <p>{live.subject ?? "Untitled session"} ({live.state}, {Math.round(live.elapsedSeconds / 60)} min)</p>
            <div role="radiogroup" aria-label="What happens to the open session" className="flex flex-wrap gap-2">
              {(["finish", "abandon", "leave"] as const).map((value) => (
                <Button key={value} size="sm" variant={choice === value ? "default" : "outline"} role="radio" aria-checked={choice === value} onClick={() => setChoice(value)}>
                  {value === "finish" ? "Finish it" : value === "abandon" ? "Abandon it" : "Leave it running"}
                </Button>
              ))}
            </div>
            {choice === "finish" ? (
              <div className="space-y-2">
                <Textarea value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Outcome, in your own words (optional)" aria-label="Outcome" />
                <Input value={nextStep} onChange={(e) => setNextStep(e.target.value)} placeholder="Next step (optional)" aria-label="Next step" />
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No session is open.</p>
        )}
        {preview.plannedSessionCount > 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">{preview.plannedSessionCount} planned session{preview.plannedSessionCount === 1 ? "" : "s"} stay as they are.</p>
        ) : null}
      </Panel>

      <Panel title="Park captures" description="Set aside until you want them. Work already running may still finish while parked; unparking puts each one back in the queue.">
        {preview.captures.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing open in the inbox.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {preview.captures.map((c) => (
              <li key={c.id}>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={park.has(c.id)} onChange={() => toggle(park, c.id, setPark)} />
                  <span className="min-w-0 break-words">{c.label}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={`Lead ${preview.tomorrow} with`} description="A suggestion for tomorrow's list, not a commitment. You still accept outcomes yourself.">
        {preview.seedCandidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No unfinished or due tasks to carry over.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {preview.seedCandidates.map((t) => (
              <li key={t.taskId}>
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={seed.has(t.taskId)} onChange={() => toggle(seed, t.taskId, setSeed)} />
                  <span className="min-w-0 break-words">{t.title} <span className="text-muted-foreground">- {t.reason}</span></span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Summary email" description="Optional. This only files a proposal for you to approve; nothing is sent from here.">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={wantEmail} onChange={(e) => setWantEmail(e.target.checked)} />
          Propose a summary email
        </label>
        {wantEmail ? (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="Send to (required)" aria-label="Recipient" />
            <Input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="Gmail account alias (blank if you have one)" aria-label="Gmail account alias" />
          </div>
        ) : null}
      </Panel>

      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="flex items-center gap-3">
        <Button onClick={submit} disabled={pending || needsChoice || (wantEmail && !to.trim())}>
          {pending ? "Closing the day..." : "Close the day"}
        </Button>
        {needsChoice ? <span className="text-xs text-muted-foreground">Choose what happens to the open session first.</span> : null}
      </div>
    </div>
  );
}
