"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { cn } from "cn";
import { ChevronsLeft, ChevronsRight, ShieldCheck, Link2 } from "lucide-react";
import { products, productForPath, productHref } from "@/lib/products";
import { FocusDock } from "./focus-dock";

export function NavRail() {
  const pathname = usePathname();
  const active = productForPath(pathname);
  const [collapsed, setCollapsed] = useState(false);
  const groups = [...new Set(active.destinations.map((d) => d.group))];
  return <aside className={cn("suite-rail hidden shrink-0 border-r border-border bg-sidebar md:flex", collapsed ? "w-[68px]" : "w-[248px]")}><div className="sticky top-[60px] flex h-[calc(100dvh-60px)] w-full flex-col"><nav aria-label="Products" className="flex items-center justify-around gap-2 border-b border-border px-3 py-3">{products.map((p) => <Link key={p.id} href={productHref(p)} aria-label={p.name} title={p.name} aria-current={p.id === active.id ? "true" : undefined} className={cn("product-mark transition-opacity",p.id !== active.id && "opacity-50 hover:opacity-100")} data-product={p.id}><p.icon aria-hidden className="size-4"/></Link>)}</nav><nav aria-label="Destinations" className="flex-1 overflow-y-auto px-3 py-4">{groups.map((group) => <div key={group} className="mb-5">{!collapsed && <p className="mb-2 px-2 text-[11px] text-muted-foreground">{group}</p>}<div className="flex flex-col gap-1">{active.destinations.filter((d) => d.group === group).map((d) => { const href = productHref(active,d.slug); const current = pathname === href || (pathname === `/apps/${active.id}` && d.slug === active.home); return <Link key={d.slug} href={href} title={collapsed ? d.label : undefined} aria-label={collapsed ? d.label : undefined} aria-current={current ? "page" : undefined} className={cn("suite-nav-link",current && "suite-nav-active")} data-product={active.id}><d.icon aria-hidden className="size-4 shrink-0"/>{!collapsed && <span className="truncate">{d.label}</span>}</Link>; })}</div></div>)}</nav><div className="flex flex-col gap-3 border-t border-border p-3">{!collapsed && <><FocusDock/><div className="flex items-center gap-2 px-2 text-[11px] text-muted-foreground"><ShieldCheck aria-hidden className="size-3.5"/> External actions locked</div></>}<button type="button" aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} onClick={() => setCollapsed(!collapsed)} className="flex min-h-8 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted">{collapsed ? <ChevronsRight aria-hidden className="size-4"/> : <><ChevronsLeft aria-hidden className="size-4"/><span>Collapse navigation</span><Link2 aria-hidden className="ml-auto size-3"/></>}</button></div></div></aside>;
}
