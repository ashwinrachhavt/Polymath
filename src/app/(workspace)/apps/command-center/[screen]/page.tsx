import { Suspense } from "react";
import { notFound } from "next/navigation";
import CommandCenterScreen from "@/components/products/command-center/screen-dispatch";
import { products } from "@/lib/products";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function SelectedScreen({ screen, searchParams }: { screen: string; searchParams: SearchParams }) {
  const query = await searchParams;
  const recordId = typeof query.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(query.id) ? query.id : undefined;
  const invalidRecordId = query.id !== undefined && !recordId;
  return <CommandCenterScreen key={`${screen}:${recordId || ""}:${invalidRecordId}`} screen={screen} recordId={recordId} invalidRecordId={invalidRecordId}/>;
}

export default async function Page({ params, searchParams }: { params: Promise<{ screen: string }>; searchParams: SearchParams }) {
  const { screen } = await params;
  const product = products.find((record) => record.id === "command-center");
  if (!product?.destinations.some((destination) => destination.slug === screen)) notFound();
  if (!["contacts", "companies", "opportunities"].includes(screen)) return <CommandCenterScreen screen={screen}/>;
  return <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Opening record selection…</p>}><SelectedScreen screen={screen} searchParams={searchParams}/></Suspense>;
}
