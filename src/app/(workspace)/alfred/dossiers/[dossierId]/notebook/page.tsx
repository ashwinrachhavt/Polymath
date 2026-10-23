import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { getAuthContext } from "@/lib/auth";
import { db } from "@/lib/db";
import { artifactLinks, artifactVersions, artifacts } from "@/domains/knowledge/schema";
import { dossierDocumentIds, getDossierDetail, listAttachableDocuments, listDossierRuns } from "@/domains/knowledge/dossiers";
import { listSources } from "@/domains/knowledge/source-readiness";
import { parseStructuredContent } from "@/domains/knowledge/artifact-content";
import { draftsForRuns, getDraftDetail } from "@/domains/knowledge/studio";
import { artifactNextStep } from "@/domains/knowledge/continuation";
import { listLinkableRecords, resolveLinkTitles } from "../../links";
import { DraftWorkbench } from "../../draft-workbench";
import NotebookSurface, { type GeneratedArtifact } from "./notebook-surface";

export const metadata = { title: "Notebook · Polymath" };

/*
 * A notebook is a dossier (NotebookLM parity, S3). This route lives under
 * /alfred/dossiers/<id>/notebook rather than /alfred/notebook/<id> because
 * /alfred/notebook is the notes surface and one URL segment cannot mean two
 * objects.
 *
 * The notebook is the dossier's home: sources, the grounded conversation, and
 * Studio (generate, research, draft review). A ?draft= id opens the workbench
 * below the conversation; an id that is missing, foreign, or not a Studio
 * artifact just opens no workbench.
 */

async function NotebookData({
  dossierId,
  draftId,
}: {
  dossierId: string;
  draftId?: string;
}) {
  await connection();
  const auth = await getAuthContext();
  const dossier = await getDossierDetail(auth, dossierId);
  if (!dossier) notFound();

  const documentIds = (await dossierDocumentIds(auth, dossierId)) ?? [];
  const [sources, vault] = await Promise.all([
    documentIds.length > 0 ? listSources(auth, { documentIds, limit: 100 }) : [],
    listAttachableDocuments(auth),
  ]);

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

  const runs = await listDossierRuns(auth, dossierId);
  const runDrafts = await draftsForRuns(auth, runs.map((run) => run.id));
  const draftDetail = draftId ? await getDraftDetail(auth, draftId) : null;
  const [linkTitles, linkable] = draftDetail
    ? await Promise.all([resolveLinkTitles(auth, draftDetail.links), listLinkableRecords(auth)])
    : [{}, null];

  return (
    <>
      <PageHeader title={dossier.title} />
      <NotebookSurface
        notebook={{ dossierId: dossier.id, title: dossier.title }}
        sources={sources}
        artifacts={generated}
        vault={vault.map((doc) => ({ id: doc.id, title: doc.title }))}
        runs={runs.map((run) => ({ id: run.id, state: run.state, objective: run.objective }))}
        runDrafts={Object.fromEntries(runDrafts)}
      />
      {draftDetail && linkable ? (
        <section aria-label="Draft workbench" className="page-content mt-6">
          <DraftWorkbench
            suggestedNextStep={artifactNextStep(draftDetail.artifact.status)}
            artifact={draftDetail.artifact}
            text={draftDetail.text}
            sources={draftDetail.sources}
            links={draftDetail.links}
            linkTitles={linkTitles}
            linkable={linkable}
          />
        </section>
      ) : null}
    </>
  );
}

export default async function NotebookPage({
  params,
  searchParams,
}: {
  params: Promise<{ dossierId: string }>;
  searchParams: Promise<{ draft?: string }>;
}) {
  const [{ dossierId }, search] = await Promise.all([params, searchParams]);
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64 w-full" />}>
      <NotebookData dossierId={dossierId} draftId={search.draft} />
    </Suspense>
  );
}
