import { notFound } from "next/navigation";
import AlfredScreen from "@/components/products/alfred/alfred-screen";
import { products } from "@/lib/products";

export default async function AlfredProductPage({ params, searchParams }: { params: Promise<{ screen: string }>; searchParams: Promise<{ id?: string | string[] }> }) {
  const [{ screen }, query] = await Promise.all([params, searchParams]);
  const product = products.find((item) => item.id === "alfred");
  if (!product?.destinations.some((destination) => destination.slug === screen)) notFound();
  const initialId = Array.isArray(query.id) ? query.id[0] : query.id;
  return <AlfredScreen key={`${screen}-${initialId || ""}`} screen={screen} initialId={initialId} />;
}
