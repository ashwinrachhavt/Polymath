"use client";

import { cn } from "cn";
import { Search, Unplug } from "lucide-react";
import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";

export function Screen({ title, description, actions, children }: { title: string; description: string; actions?: ReactNode; children: ReactNode }) {
  return <div className="suite-screen"><header className="flex flex-wrap items-start justify-between gap-4 pb-6"><div><h1 className="font-display text-[26px] font-normal tracking-normal">{title}</h1><p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">{description}</p></div>{actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}</header><div className="flex flex-col gap-6">{children}</div></div>;
}
export function Panel({ title, description, actions, children, className }: { title?: string; description?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={cn("panel rounded-xl p-4", className)}>{(title || actions) && <div className="mb-4 flex items-start justify-between gap-3"><div>{title && <h2 className="text-[13px] font-medium">{title}</h2>}{description && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>}</div>{actions}</div>}{children}</section>;
}
export function Status({ children }: { children: ReactNode }) { return <span className="inline-flex min-h-6 items-center rounded-sm border border-border bg-muted/60 px-2 text-[11px] font-medium text-foreground">{children}</span>; }
export function Empty({ title, description, action }: { title: string; description: string; action?: ReactNode }) { return <div className="panel-empty flex flex-col items-start gap-2 rounded-lg p-5"><p className="text-[13px] font-medium">{title}</p><p className="max-w-xl text-[13px] leading-relaxed text-muted-foreground">{description}</p>{action && <div className="mt-2">{action}</div>}</div>; }
export function SearchField({ value, onChange, placeholder = "Search" }: { value: string; onChange: (value: string) => void; placeholder?: string }) { return <div className="relative w-full max-w-sm"><Search aria-hidden className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground"/><Input aria-label={placeholder} className="h-9 pl-9 text-[13px]" type="search" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} /></div>; }
export function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="flex flex-col gap-1.5 text-[13px]"><span className="font-medium">{label}</span>{children}</label>; }
export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) { return <div className="panel rounded-xl p-4"><p className="text-xs text-muted-foreground">{label}</p><div className="readout mt-2 text-2xl">{value}</div>{hint && <p className="mt-2 text-xs text-muted-foreground">{hint}</p>}</div>; }
export function Unavailable({ feature, children }: { feature: string; children?: ReactNode }) { return <div className="flex items-start gap-3 rounded-lg border border-dashed border-border bg-muted/30 p-4"><Unplug aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground"/><div className="text-[13px]"><p className="font-medium">{feature} is not connected</p><div className="mt-1 max-w-2xl leading-relaxed text-muted-foreground">{children || "This is an interactive UI preview. Production credentials and domain commands must be connected before this feature can run."}</div></div></div>; }
