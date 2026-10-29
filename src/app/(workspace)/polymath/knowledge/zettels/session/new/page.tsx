import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { createSitting } from "@/domains/knowledge/sittings";

export const metadata = { title: "New sitting · Ideas" };

/*
 * §14.1: the New-sitting route opens the workspace directly - a sitting is
 * created on arrival (topic optional, "name it later") and the writer lands
 * in the editor with the cursor blinking. §7: seeding from the inbox flow
 * passes ?source=<documentId>; there is no separate seed action.
 */
export default async function NewSittingPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; topic?: string }>;
}) {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const params = await searchParams;
  const sitting = await createSitting(auth, {
    topic: params.topic?.trim() || undefined,
    sourceContext: params.source ? `document:${params.source}` : undefined,
  });
  redirect(`/polymath/knowledge/zettels/session/${sitting.id}`);
}
