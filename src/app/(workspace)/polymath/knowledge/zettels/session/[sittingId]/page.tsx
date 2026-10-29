import { notFound } from "next/navigation";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { getSitting, listSittingCards } from "@/domains/knowledge/sittings";
import { WorkspaceShell } from "@/components/polymath/zettels/workspace-shell";

export const metadata = { title: "Sitting · Ideas" };

/*
 * The sitting workspace (§14): server-hydrated sitting + its cards, then the
 * client shell owns the writing surface, the ambient panel and the rail.
 * A sitting in another workspace is the same 404 as a missing one (§16.9).
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
  return (
    <WorkspaceShell
      workspaceId={auth.workspaceId}
      sitting={{
        id: sitting.id,
        topic: sitting.topic,
        tags: (sitting.tags as string[]) ?? [],
        startedAt: sitting.startedAt.toISOString(),
        endedAt: sitting.endedAt?.toISOString() ?? null,
      }}
      initialCards={cards.map((c) => ({ artifactId: c.artifactId, role: c.roleInSitting, position: c.position }))}
    />
  );
}
