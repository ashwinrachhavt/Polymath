"use client";

import { useEffect, useState } from "react";
import { loadWeeklyReviewAction } from "@/app/(workspace)/apps/neuralflow/reports-actions";
import type { WeeklyReview } from "@/domains/work/reports";
import { Panel } from "@/components/workspace/ui";

/* D15: this week from server rows (completion timestamps, finished focus sessions). */
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
