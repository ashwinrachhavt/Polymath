import { notFound } from "next/navigation";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { getSitting, getSittingWritingCard, listSittingCards } from "@/domains/knowledge/sittings";
import { WorkspaceShell } from "@/components/polymath/zettels/workspace-shell";
import { getDocumentTitle } from "@/domains/knowledge/documents";

export const metadata = { title: "Sitting · Ideas" };

/*
 * The sitting workspace (§14): server-hydrated sitting + its cards, then the
 * client shell owns the writing surface, the ambient panel and the rail.
 * A sitting in another workspace is the same 404 as a missing one (§16.9).
 * No lifecycle (Gate 2026-10-29): the workspace is always writable.
 */
export default async function SittingPage({
  params,
}: {
  params: Promise<{ sittingId: string }>;
}) {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const { sittingId } = await params;
  const sitting = await getSitting(auth, sittingId);
  if (!sitting) notFound();
  const cards = await listSittingCards(auth, sitting.id);
  // Reopen hydration: the surface binds to the sitting's saved card instead
  // of opening blank and duplicating it.
  const writingCard = await getSittingWritingCard(auth, sitting.id);
  // §14.10: a sitting seeded from the inbox carries sourceContext
  // "document:<id>"; the header shows a "From: {title}" chip linking back.
  let source: { title: string; href: string } | null = null;
  if (sitting.sourceContext?.startsWith("document:")) {
    const documentId = sitting.sourceContext.slice("document:".length);
    const title = await getDocumentTitle(auth, documentId);
    if (title) source = { title, href: `/polymath/knowledge?doc=${encodeURIComponent(documentId)}` };
  }
  return (
    <WorkspaceShell
      workspaceId={auth.workspaceId}
      source={source}
      sitting={{
        id: sitting.id,
        topic: sitting.topic,
        tags: (sitting.tags as string[]) ?? [],
        startedAt: sitting.startedAt.toISOString(),
      }}
      initialCards={cards.map((c) => ({ artifactId: c.artifactId, role: c.roleInSitting, position: c.position }))}
      initialWritingCard={
        writingCard
          ? {
              artifactId: writingCard.artifactId,
              versionNumber: writingCard.versionNumber,
              plainText: writingCard.plainText ?? "",
              content: writingCard.content,
              updatedAt: writingCard.updatedAt.toISOString(),
            }
          : null
      }
    />
  );
}
