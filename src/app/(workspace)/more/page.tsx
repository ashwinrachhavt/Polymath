import Link from "next/link";
import { products, productHref } from "@/lib/products";

export const metadata = { title: "All screens · Axiom" };
export default function MorePage() { return <div className="suite-screen"><h1 className="text-xl font-medium">All screens</h1><p className="mt-2 text-[13px] text-muted-foreground">Every product shares the same workspace, capture and reviews.</p><div className="mt-6 grid gap-6 lg:grid-cols-3">{products.map((p) => <section key={p.id} className="panel rounded-xl p-4"><h2 className="flex items-center gap-2 text-sm font-medium"><span className="product-mark" data-product={p.id}><p.icon aria-hidden className="size-4"/></span>{p.name}</h2><ul className="mt-4 flex flex-col gap-1">{p.destinations.map((d) => <li key={d.slug}><Link href={productHref(p,d.slug)} className="suite-nav-link"><d.icon aria-hidden className="size-4"/>{d.label}</Link></li>)}</ul></section>)}</div></div>; }
