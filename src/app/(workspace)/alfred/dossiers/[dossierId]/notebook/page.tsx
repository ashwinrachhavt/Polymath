import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { getAuthContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { artifactLinks, artifactVersions, artifacts } from "@/domains/knowledge/schema";
import { dossierDocumentIds, getDossierDetail } from "@/domains/knowledge/dossiers";
import { listSources } from "@/domains/knowledge/source-readiness";
import { parseStructuredContent } from "@/domains/knowledge/artifact-content";
import NotebookSurface, { type GeneratedArtifact } from "./notebook-surface";

export const metadata = { title: "Notebook · Polymath" };

/*
 * A notebook is a dossier (NotebookLM parity, S3). This route lives under
 * /alfred/dossiers/<id>/notebook rather than /alfred/notebook/<id> because
 * /alfred/notebook is the notes surface and one URL segment cannot mean two
 * objects.
 *
 * Everything here is read-only. Generation stays on the Dossiers page; the
 * learning outputs stay in /alfred/learning. This surface shows what the
 * notebook holds.
 */

async function NotebookData({ dossierId }: { dossierId: string }) {
  await connection();
  const auth = await getAuthContext();
  const dossier = await getDossierDetail(auth, dossierId);
  if (!dossier) notFound();

  const documentIds = (await dossierDocumentIds(auth, dossierId)) ?? [];
  const sources = documentIds.length > 0 ? await listSources(auth, { documentIds, limit: 100 }) : [];

  // Artifacts pinned to this notebook's documents, with their stored structure.
  const links = documentIds.length > 0
    ? await db
        .selectDistinct({ artifactId: artifactLinks.artifactId })
        .from(artifactLinks)
        .where(and(
          eq(artifactLinks.workspaceId, auth.workspaceId),
          eq(artifactLinks.targetType, "document"),
          inArray(artifactLinks.targetId, documentIds),
        ))
    : [];
  const rows = links.length > 0
    ? await db
        .select({
          id: artifacts.id,
          title: artifacts.title,
          kind: artifacts.kind,
          status: artifacts.status,
          versionContent: artifactVersions.content,
        })
        .from(artifacts)
        .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
        .where(and(
          eq(artifacts.workspaceId, auth.workspaceId),
          inArray(artifacts.id, links.map((l) => l.artifactId)),
          isNull(artifacts.archivedAt),
        ))
        .orderBy(desc(artifacts.createdAt))
        .limit(20)
    : [];

  const generated: GeneratedArtifact[] = rows.map((row) => ({
    artifactId: row.id,
    title: row.title,
    kind: row.kind,
    status: row.status,
    // Only deck and infographic rows have structure; a report returns null and
    // renders as a title, which is the honest shape for this pane.
    structured: parseStructuredContent(row.kind, row.versionContent),
  }));

  return (
    <>
      <PageHeader title={dossier.title} />
      <NotebookSurface
        notebook={{ dossierId: dossier.id, title: dossier.title }}
        sources={sources}
        artifacts={generated}
      />
    </>
  );
}

export default async function NotebookPage({ params }: { params: Promise<{ dossierId: string }> }) {
  const { dossierId } = await params;
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64 w-full" />}>
      <NotebookData dossierId={dossierId} />
    </Suspense>
  );
}
