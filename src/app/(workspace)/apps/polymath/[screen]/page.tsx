import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import PolymathScreen from "@/components/products/polymath/polymath-screen";
import { products } from "@/lib/products";

type SearchParams = Promise<{ id?: string | string[]; canvasId?: string | string[] }>;

/*
 * Both params and searchParams are awaited inside the boundary: Next 16 warns
 * when URL data is read outside Suspense because it blocks instant
 * navigation. An unknown screen still renders the not-found boundary.
 */
async function SelectedScreen({
  params,
  searchParams,
}: {
  params: Promise<{ screen: string }>;
  searchParams: SearchParams;
}) {
  const { screen } = await params;
  const product = products.find((item) => item.id === "polymath");
  if (!product?.destinations.some((destination) => destination.slug === screen)) notFound();
  const query = await searchParams;
  const initialId = Array.isArray(query.id) ? query.id[0] : query.id;
  // B04 (ASH-141): the notebook merged onto the canonical artifact rows, now
  // at /polymath/notes; the preview screen hands off instead of holding a
  // second, browser-local copy of the same notes.
  if (screen === "notebook")
    redirect(initialId ? `/polymath/notes?id=${encodeURIComponent(initialId)}` : "/polymath/notes");
  // D18 (ASH-144): the source library and the Files explorer both merged into
  // the Vault; the preview screens hand off the same way the notebook's notes did.
  if (screen === "library" || screen === "files") redirect("/polymath/knowledge");
  // The canvas handshake: a canvasId names a canonical Postgres canvas, which
  // the preview screen cannot load (its drawings are browser-local). Hand off
  // to the canonical canvas route, the same way notebook/library hand off to
  // their canonical surfaces.
  const canvasId = Array.isArray(query.canvasId) ? query.canvasId[0] : query.canvasId;
  if (screen === "canvas" && canvasId) redirect(`/polymath/canvas/${encodeURIComponent(canvasId)}`);
  return <PolymathScreen key={`${screen}-${initialId || ""}`} screen={screen} initialId={initialId} />;
}

export default function PolymathProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ screen: string }>;
  searchParams: SearchParams;
}) {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-6 text-body-dense text-muted-foreground">
          Opening record selection…
        </p>
      }
    >
      <SelectedScreen params={params} searchParams={searchParams} />
    </Suspense>
  );
}
