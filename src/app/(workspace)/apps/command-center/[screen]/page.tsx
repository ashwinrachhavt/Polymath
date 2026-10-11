import { Suspense } from "react";
import { notFound } from "next/navigation";
import CommandCenterScreen from "@/components/products/command-center/screen-dispatch";
import { products } from "@/lib/products";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/*
 * Both params and searchParams are awaited inside the boundary: Next 16 warns
 * when URL data is read outside Suspense because it blocks instant
 * navigation. Validation (and notFound for an unknown screen) also runs
 * inside, which still renders the not-found boundary.
 */
async function SelectedScreen({ params, searchParams }: { params: Promise<{ screen: string }>; searchParams: SearchParams }) {
  const { screen } = await params;
  const product = products.find((record) => record.id === "command-center");
  if (!product?.destinations.some((destination) => destination.slug === screen)) notFound();
  const query = await searchParams;
  // A repeated id is ambiguous, not first-wins: it is rejected like an
  // invalid one so a deep link can never silently pick a record.
  const raw = query.id;
  const rawId = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : raw.join(",")) : raw;
  const ambiguous = Array.isArray(raw) && raw.length > 1;
  const recordId = !ambiguous && rawId && /^[a-zA-Z0-9_-]{1,100}$/.test(rawId) ? rawId : undefined;
  const invalidRecordId = ambiguous || (rawId !== undefined && !recordId);
  return <CommandCenterScreen key={`${screen}:${recordId || ""}:${invalidRecordId}`} screen={screen} recordId={recordId} invalidRecordId={invalidRecordId}/>;
}

export default function Page({ params, searchParams }: { params: Promise<{ screen: string }>; searchParams: SearchParams }) {
  return <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Opening record selection…</p>}><SelectedScreen params={params} searchParams={searchParams}/></Suspense>;
}
