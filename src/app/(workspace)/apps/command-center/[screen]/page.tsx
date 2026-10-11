import { Suspense } from "react";
import { notFound } from "next/navigation";
import CommandCenterScreen from "@/components/products/command-center/screen-dispatch";
import { products } from "@/lib/products";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/*
 * The screen is validated before the boundary so an unknown one still 404s
 * instead of rendering inside the fallback. Reading the query string is the
 * only thing that suspends, and it happens in a server component: a client
 * component cannot await a promise that has no cache entry.
 */
async function SelectedScreen({ screen, searchParams }: { screen: string; searchParams: SearchParams }) {
  const query = await searchParams;
  const rawId = typeof query.id === "string" ? query.id : undefined;
  const recordId = rawId && /^[a-zA-Z0-9_-]{1,100}$/.test(rawId) ? rawId : undefined;
  const invalidRecordId = rawId !== undefined && !recordId;
  return <CommandCenterScreen key={`${screen}:${recordId || ""}:${invalidRecordId}`} screen={screen} recordId={recordId} invalidRecordId={invalidRecordId}/>;
}

export default async function Page({ params, searchParams }: { params: Promise<{ screen: string }>; searchParams: SearchParams }) {
  const { screen } = await params;
  const product = products.find((record) => record.id === "command-center");
  if (!product?.destinations.some((destination) => destination.slug === screen)) notFound();
  return <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Opening record selection…</p>}><SelectedScreen screen={screen} searchParams={searchParams}/></Suspense>;
}
