"use client";

import { useId } from "react";
import { cn } from "cn";

/*
 * Hand-rolled SVG bars. No chart library is installed, and the only shape this
 * product needs is a small daily column set where every bar carries its own
 * readable value. Colour never carries the meaning: the number is in the row,
 * the accessible name is on the figure, and the table beneath repeats it.
 */

export type ChartPoint = { label: string; value: number; caption?: string };

export function BarChart({ points, unit, emptyLabel, className }: { points: ChartPoint[]; unit: string; emptyLabel: string; className?: string }) {
  const titleId = useId();
  const peak = Math.max(1, ...points.map((point) => point.value));
  const total = points.reduce((sum, point) => sum + point.value, 0);
  if (!points.length) return <p className="text-[13px] text-muted-foreground">{emptyLabel}</p>;

  return (
    <figure className={cn("space-y-3", className)}>
      <figcaption id={titleId} className="text-xs text-muted-foreground">
        {total.toLocaleString()} {unit} recorded across {points.length} {points.length === 1 ? "day" : "days"}. Peak {peak.toLocaleString()} {unit}.
      </figcaption>
      <div className="flex items-end gap-1" role="img" aria-labelledby={titleId}>
        {points.map((point) => (
          <div key={point.label} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <span className="readout text-[10px] text-muted-foreground">{point.value || ""}</span>
            <div className="flex h-24 w-full items-end rounded-sm bg-muted" title={`${point.label}: ${point.value} ${unit}`}>
              <div className="w-full rounded-sm bg-primary/70" style={{ height: `${point.value ? Math.max(4, (point.value / peak) * 100) : 0}%` }} />
            </div>
            <span className="readout text-[10px] text-muted-foreground">{point.label.slice(5)}</span>
          </div>
        ))}
      </div>
      <table className="w-full text-[13px]">
        <caption className="sr-only">{unit} recorded per day</caption>
        <thead><tr className="text-left text-xs text-muted-foreground"><th scope="col" className="py-1 font-medium">Day</th><th scope="col" className="py-1 font-medium">{unit.charAt(0).toUpperCase() + unit.slice(1)}</th><th scope="col" className="py-1 font-medium">Sessions</th></tr></thead>
        <tbody>
          {points.map((point) => <tr key={point.label} className="border-t border-border"><th scope="row" className="py-1 text-left font-normal">{point.label}</th><td className="readout py-1">{point.value}</td><td className="readout py-1 text-muted-foreground">{point.caption || "0"}</td></tr>)}
        </tbody>
      </table>
    </figure>
  );
}

/*
 * A compact progress meter for a goal that is not a chart. It carries the
 * numbers as text, so it is legible without the bar and without colour.
 */
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 text-[13px]"><span className="font-medium">{label}</span><span className="readout text-muted-foreground">{value} of {max}</span></div>
      <div className="h-2 overflow-hidden rounded-sm bg-muted" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}><div className="h-full bg-primary/70" style={{ width: `${percent}%` }} /></div>
    </div>
  );
}
