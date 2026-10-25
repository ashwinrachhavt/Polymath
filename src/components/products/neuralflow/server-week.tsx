"use client";

import { useEffect, useState } from "react";
import { loadKnowledgeDebtAction, loadWeeklyReviewAction } from "@/app/(workspace)/apps/neuralflow/reports-actions";
import type { KnowledgeDebt, KnowledgeDebtSection } from "@/domains/knowledge/debt";
import type { WeeklyReview } from "@/domains/work/reports";
import { Panel } from "@/components/workspace/ui";

/* D15: this week from server rows (completion timestamps, finished focus sessions). */
function DebtList({ label, section }: { label: string; section: KnowledgeDebtSection }) {
  if (section.total === 0) return null;
  const count = section.total === -1 ? `10+` : `${section.total}`;
  return (
    <div>
      <p className="text-[13px] font-medium">{label}: {count}</p>
      <ul className="mt-1 space-y-0.5 text-[13px] text-muted-foreground">
        {section.items.map((item) => <li key={item.id}>{item.title}{item.detail ? ` · ${item.detail}` : ""}</li>)}
      </ul>
    </div>
  );
}

/* ASH-295: the debt half of the weekly review - where the library is quietly decaying. */
export function KnowledgeDebtPanel() {
  const [debt, setDebt] = useState<KnowledgeDebt | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void loadKnowledgeDebtAction().then((r) => (r.ok ? setDebt(r.debt) : setError(r.error))).catch(() => setError("Could not load the knowledge debt report."));
  }, []);
  if (error) return <p role="alert" className="text-[13px] text-destructive">{error}</p>;
  if (!debt) return <p role="status" className="text-[13px] text-muted-foreground">Checking the library for knowledge debt…</p>;
  const clean = debt.zeroLinkNotes.total === 0 && debt.unsupportedClaims.total === 0 && debt.tasksWithoutRationale.total === 0 && debt.neverOpenedDocuments.total === 0;
  return (
    <Panel title="Knowledge debt" description="Notes nothing links to, claims with no evidence, open tasks with no why, sources captured and never opened. The weekly review's to-tend list.">
      {clean ? <p className="text-[13px]">No knowledge debt on any watched signal.</p> : (
        <div className="space-y-3">
          <DebtList label="Zero-link notes" section={debt.zeroLinkNotes} />
          <DebtList label="Claims without evidence" section={debt.unsupportedClaims} />
          <DebtList label="Open tasks with no description" section={debt.tasksWithoutRationale} />
          <DebtList label="Sources never opened" section={debt.neverOpenedDocuments} />
        </div>
      )}
    </Panel>
  );
}

export function ServerWeek() {
  const [review, setReview] = useState<WeeklyReview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void loadWeeklyReviewAction({}).then((r) => (r.ok ? setReview(r.review) : setError(r.error))).catch(() => setError("Could not load the weekly review."));
  }, []);
  if (error) return <p role="alert" className="text-[13px] text-destructive">{error}</p>;
  if (!review) return <p role="status" className="text-[13px] text-muted-foreground">Loading this week from your account…</p>;
  return (
    <Panel title="This week, from your account" description={`${review.start} to ${review.end} (${review.timezone}). Counted from real completion timestamps and finished focus sessions.`}>
      <p className="text-[13px]">{review.totals.completedTasks} tasks completed, {review.totals.focusMinutes} focus minutes in {review.totals.focusSessions} sessions, active-day streak {review.streak}.</p>
      <table className="mt-3 w-full text-[13px]"><thead><tr className="text-left text-muted-foreground"><th>Day</th><th>Tasks completed</th><th>Focus minutes</th></tr></thead>
        <tbody>{review.days.map((d) => <tr key={d.date}><td>{d.date}</td><td>{d.completedTasks}</td><td>{d.focusMinutes}</td></tr>)}</tbody></table>
    </Panel>
  );
}
