import { Suspense } from "react";
import { notFound } from "next/navigation";
import AlfredScreen from "@/components/products/alfred/alfred-screen";
import { products } from "@/lib/products";

type SearchParams = Promise<{ id?: string | string[] }>;

/*
 * Both params and searchParams are awaited inside the boundary: Next 16 warns
 * when URL data is read outside Suspense because it blocks instant
 * navigation. An unknown screen still renders the not-found boundary.
 */
async function SelectedScreen({ params, searchParams }: { params: Promise<{ screen: string }>; searchParams: SearchParams }) {
  const { screen } = await params;
  const product = products.find((item) => item.id === "alfred");
  if (!product?.destinations.some((destination) => destination.slug === screen)) notFound();
  const query = await searchParams;
  const initialId = Array.isArray(query.id) ? query.id[0] : query.id;
  return <AlfredScreen key={`${screen}-${initialId || ""}`} screen={screen} initialId={initialId}/>;
}

export default function AlfredProductPage({ params, searchParams }: { params: Promise<{ screen: string }>; searchParams: SearchParams }) {
  return <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Opening record selection…</p>}><SelectedScreen params={params} searchParams={searchParams}/></Suspense>;
}
