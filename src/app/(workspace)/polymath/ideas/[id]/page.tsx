import { redirect } from "next/navigation";

/*
 * The idea card is a modal over the Ideas collection (`/polymath/ideas?idea=<id>`),
 * not a page of its own. Every entry point that still links here — vault
 * duplicate warnings, the graph panel, chat record links — lands on the
 * collection with the card's modal open.
 */

export const metadata = { title: "Idea · Polymath" };

export default async function IdeaDetailRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/polymath/ideas?idea=${encodeURIComponent(id)}`);
}
