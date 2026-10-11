"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Check, ChevronDown } from "lucide-react";
import { products, productForPath, productHref } from "@/lib/products";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useState } from "react";

export function AppSwitcher() {
  const [open, setOpen] = useState(false);
  const active = productForPath(usePathname());
  const Icon = active.icon;
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><button type="button" aria-label="Switch product" className="flex min-h-10 min-w-0 items-center gap-3 rounded-lg px-2 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"><span className="product-mark" data-product={active.id}><Icon aria-hidden className="size-4"/></span><span className="hidden min-w-0 sm:block"><span className="block text-[13px] font-medium">{active.name}</span><span className="block text-[10px] text-muted-foreground">Axiom workspace</span></span><ChevronDown aria-hidden className="size-3 text-muted-foreground"/></button></DialogTrigger><DialogContent className="sm:max-w-xl"><DialogTitle>Your Axiom suite</DialogTitle><DialogDescription>Three products. One workspace, shared tasks, knowledge and reviews.</DialogDescription><div className="grid gap-3 sm:grid-cols-3">{products.map((p) => <Link key={p.id} href={productHref(p)} onClick={() => setOpen(false)} className="panel flex min-h-40 flex-col items-start gap-3 rounded-xl p-4 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"><span className="product-mark size-10" data-product={p.id}><p.icon aria-hidden className="size-5"/></span><span className="text-[13px] font-medium">{p.name}</span><span className="text-xs leading-relaxed text-muted-foreground">{p.description}</span>{p.id === active.id && <span className="flex items-center gap-1 text-xs"><Check aria-hidden className="size-3"/> Current product</span>}</Link>)}</div><p className="text-xs text-muted-foreground">Switching products changes your lens, not your records.</p></DialogContent></Dialog>;
}
