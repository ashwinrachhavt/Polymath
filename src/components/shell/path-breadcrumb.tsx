"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { productForPath, productHref } from "@/lib/products";
export function PathBreadcrumb() { const path = usePathname(); const product = productForPath(path); const destination = product.destinations.find((d) => path === productHref(product,d.slug)); return <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-[11px] text-muted-foreground"><Link href={productHref(product)} className="hover:text-foreground">{product.name}</Link><span aria-hidden>/</span><span aria-current="page">{destination?.label || "Workspace"}</span></nav>; }
