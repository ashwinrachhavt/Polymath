import { connection } from "next/server";
import { notFound } from "next/navigation";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { projectDocumentIds } from "@/domains/knowledge/projects";
import { getExplainItSession } from "@/domains/learning/explain-it";
import { ExplainItSession } from "../explain-session";

export const metadata = { title: "Explain It · Polymath" };

export default async function NotebookExplainPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const { projectId } = await params;
  const query = await searchParams;
  const sessionId = typeof query.session === "string" ? query.session : "";
  if (!sessionId) notFound();
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const notebookSources = await projectDocumentIds(auth, projectId);
  if (!notebookSources) notFound();
  const session = await getExplainItSession(auth, projectId, sessionId);
  if (!session) notFound();
  return (
    <div className="page-content">
      <div className="mb-5">
        <a
          href={"/projects/" + projectId + "/notebook"}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Back to Notebook
        </a>
        <h1 className="mt-2 text-xl font-medium">Explain It</h1>
      </div>
      <ExplainItSession projectId={projectId} session={session} />
    </div>
  );
}
