import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
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
  // B04 (ASH-141): the notebook merged onto the canonical artifact rows at
  // /alfred/notebook; the preview screen hands off instead of holding a
  // second, browser-local copy of the same notes.
  if (screen === "notebook") redirect(initialId ? `/alfred/notebook?id=${encodeURIComponent(initialId)}` : "/alfred/notebook");
  // D18 (ASH-144): the source library merged onto canonical documents at
  // /alfred/library; the preview screen's browser-local sources hand off the
  // same way the notebook's notes did.
  if (screen === "library") redirect("/alfred/library");
  // Files: the document engine as a file manager, a canonical route like the library.
  if (screen === "files") redirect("/alfred/files");
  return <AlfredScreen key={`${screen}-${initialId || ""}`} screen={screen} initialId={initialId}/>;
}

export default function AlfredProductPage({ params, searchParams }: { params: Promise<{ screen: string }>; searchParams: SearchParams }) {
  return <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Opening record selection…</p>}><SelectedScreen params={params} searchParams={searchParams}/></Suspense>;
}
