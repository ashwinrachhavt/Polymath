import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { IdeaEditor } from "@/components/polymath/zettels/idea-editor";

export const metadata = { title: "New idea · Ideas" };

/*
 * §14.11: the "New idea" direct flow - the sitting-less editor for a single
 * authored card. The draft persists under the workspace+`idea:new` key; no
 * sitting is created.
 */
export default async function NewIdeaPage() {
  const auth = await getAuthContext();
  requireRole(auth, "member");
  return <IdeaEditor workspaceId={auth.workspaceId} />;
}
