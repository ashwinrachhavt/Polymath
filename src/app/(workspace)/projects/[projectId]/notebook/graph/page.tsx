import { connection } from "next/server";
import { notFound } from "next/navigation";
import { GraphCanvasLazy } from "@/app/(workspace)/polymath/graph/graph-canvas-lazy";
import { listCardGraph } from "@/domains/knowledge/relations";
import { projectDocumentIds } from "@/domains/knowledge/projects";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { NotebookGraphRecall } from "../graph-recall";

export const metadata = { title: "Idea graph · Polymath" };

export default async function NotebookGraphPage({ params }: { params: Promise<{ projectId: string }> }) {
  await connection();
  const { projectId } = await params;
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const documentIds = await projectDocumentIds(auth, projectId);
  if (!documentIds) notFound();
  const graph = await listCardGraph(auth, { documentIds });
  return (
    <div className="page-content space-y-5">
      <header>
        <a
          href={"/projects/" + projectId + "/notebook"}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Back to Notebook
        </a>
        <h1 className="mt-2 text-xl font-medium">Idea graph</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Select ideas in the React Flow graph to connect verified relationships or synthesize a new Zettel. Then
          reconstruct saved links from memory below.
        </p>
      </header>
      {graph.nodes.length > 0 ? (
        <GraphCanvasLazy nodes={graph.nodes} edges={graph.edges} />
      ) : (
        <div className="rounded-xl border border-border p-5 text-sm text-muted-foreground">
          No source-linked Zettels are available in this Notebook yet.
        </div>
      )}
      <NotebookGraphRecall projectId={projectId} nodes={graph.nodes} edges={graph.edges} />
    </div>
  );
}
