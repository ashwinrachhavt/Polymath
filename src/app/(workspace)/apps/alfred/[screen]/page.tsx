import { Suspense } from "react";
import { notFound } from "next/navigation";
import AlfredScreen from "@/components/products/alfred/alfred-screen";
import { products } from "@/lib/products";

type SearchParams = Promise<{ id?: string | string[] }>;

async function SelectedScreen({ screen, searchParams }: { screen: string; searchParams: SearchParams }) {
  const query = await searchParams;
  const initialId = Array.isArray(query.id) ? query.id[0] : query.id;
  return <AlfredScreen key={`${screen}-${initialId || ""}`} screen={screen} initialId={initialId}/>;
}

export default async function AlfredProductPage({ params, searchParams }: { params: Promise<{ screen: string }>; searchParams: SearchParams }) {
  const { screen } = await params;
  const product = products.find((item) => item.id === "alfred");
  if (!product?.destinations.some((destination) => destination.slug === screen)) notFound();
  return <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Opening record selection…</p>}><SelectedScreen screen={screen} searchParams={searchParams}/></Suspense>;
}
