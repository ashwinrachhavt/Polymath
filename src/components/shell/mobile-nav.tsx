"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { cn } from "cn";
import { productForPath, productHref } from "@/lib/products";
export function MobileNav() { const path=usePathname(); const product=productForPath(path); return <nav aria-label="Mobile destinations" className="sticky bottom-0 z-30 flex border-t border-border bg-background md:hidden">{product.destinations.slice(0,3).map((d) => <Link key={d.slug} href={productHref(product,d.slug)} className={cn("flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-[11px]",path === productHref(product,d.slug) ? "text-primary" : "text-muted-foreground")}><d.icon aria-hidden className="size-4"/>{d.label}</Link>)}<Link href="/more" className="flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground"><Menu aria-hidden className="size-4"/>All screens</Link></nav>; }
