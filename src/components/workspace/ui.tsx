"use client";

import { cn } from "cn";
import { Search, Unplug } from "lucide-react";
import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";

export function Screen({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return <div className="suite-screen"><header className="screen-heading"><div className="min-w-0 flex-1"><h1 className="screen-title">{title}</h1>{description && <p className="screen-description">{description}</p>}</div>{actions && <div className="screen-actions">{actions}</div>}</header><div className="flex flex-col gap-6">{children}</div></div>;
}
export function Panel({ title, description, actions, children, className }: { title?: string; description?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={cn("panel min-w-0 rounded-xl p-4", className)}>{(title || actions) && <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div className="min-w-0">{title && <h2 className="text-[13px] font-medium">{title}</h2>}{description && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>}</div>{actions}</div>}{children}</section>;
}
export function Status({ children }: { children: ReactNode }) { return <span className="inline-flex min-h-6 items-center rounded-sm border border-border bg-muted/60 px-2 text-[11px] font-medium text-foreground">{children}</span>; }
export function Empty({ title, description, action }: { title: string; description?: string; action?: ReactNode }) { return <div className="panel-empty flex flex-col items-start gap-2 rounded-lg p-5"><p className="text-[13px] font-medium">{title}</p>{description && <p className="max-w-xl text-[13px] leading-relaxed text-muted-foreground">{description}</p>}{action && <div className="mt-2">{action}</div>}</div>; }
export function SearchField({ value, onChange, placeholder = "Search" }: { value: string; onChange: (value: string) => void; placeholder?: string }) { return <div className="relative w-full max-w-sm"><Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"/><Input aria-label={placeholder} className="h-9 pl-9 text-[13px]" type="search" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} /></div>; }
export function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="flex flex-col gap-1.5 text-[13px]"><span className="font-medium">{label}</span>{children}</label>; }
export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) { return <div className="panel min-w-0 rounded-xl p-4"><p className="text-xs text-muted-foreground">{label}</p><div className="readout mt-2 text-2xl">{value}</div>{hint && <p className="mt-2 text-xs text-muted-foreground">{hint}</p>}</div>; }
/**
 * The mockup's stat strip: one bordered panel of label/value/hint cells.
 * The default cell stacks the label, a large value, and an optional hint
 * (day, spending). `inline` puts the value on the label's baseline row for
 * the dense pipeline variant, and `cellClassName` supplies the per-index
 * border classes those cells need; the wrapper grid comes from `className`.
 * Extracted from the day, spending, and pipeline surfaces, which had drifted
 * into three copies.
 */
export function StatStrip({ items, className, inline, cellClassName }: {
  items: Array<{ label: string; value: ReactNode; hint?: ReactNode }>;
  className?: string;
  /** Value rides the label's baseline row (the pipeline strip's layout). */
  inline?: boolean;
  /** Per-index cell classes, e.g. the pipeline strip's responsive borders. */
  cellClassName?: (index: number) => string;
}) {
  return (
    <div className={cn("panel mb-6 grid overflow-hidden rounded-xl", className)}>
      {items.map((item, index) => (
        <div key={item.label} className={cn("flex flex-col gap-1 border-border max-sm:border-b", cellClassName?.(index) ?? "p-5 sm:not-last:border-r")}>
          {inline ? (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <span className="stat-label">{item.label}</span>
                <span className="readout text-[12px] text-muted-foreground">{item.value}</span>
              </div>
              {item.hint != null && <p className="text-[11px] leading-snug text-muted-foreground">{item.hint}</p>}
            </>
          ) : (
            <>
              <span className="stat-label">{item.label}</span>
              <span className="text-2xl font-semibold tabular-nums">{item.value}</span>
              {item.hint != null && <span className="text-[12px] text-muted-foreground">{item.hint}</span>}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
export function Unavailable({ feature, children }: { feature: string; children?: ReactNode }) { return <div className="flex items-start gap-3 rounded-lg border border-dashed border-border bg-muted/30 p-4"><Unplug aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground"/><div className="text-[13px]"><p className="font-medium">{feature} is not connected</p><div className="mt-1 max-w-2xl leading-relaxed text-muted-foreground">{children || "This is an interactive UI preview. Production credentials and domain commands must be connected before this feature can run."}</div></div></div>; }
