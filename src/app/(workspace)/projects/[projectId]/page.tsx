import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Folder, Lock, Settings } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthContext } from "@/lib/auth";
import { timeAgoShort } from "@/lib/time";
import { db } from "@/lib/db";
import { agentProfiles, threads } from "@/domains/agents/schema";
import { getProjectDetail } from "@/domains/knowledge/projects";
import { buildProjectContextPrefix, listAutomations, listMemories, listProjectAccounts } from "@/domains/knowledge/project-settings";
import { listConnectors } from "@/domains/integrations/queries";
import { listSources, type SourceRow } from "@/domains/knowledge/source-readiness";
import { ProjectRightRail } from "../project-right-rail";
import { StartSession } from "../start-session";

export const metadata = { title: "Project · Polymath" };

/*
 * The project screen (Perplexity Spaces parity): the session starter, the
 * project's sessions, and the right rail with instructions, sources,
 * automations, memory and connectors.
 */

export async function ProjectSurface({ projectId }: { projectId: string }) {
  await connection();
  const auth = await getAuthContext();
  const project = await getProjectDetail(auth, projectId);
  if (!project) {
    return <div className="page-content text-[13px] text-muted-foreground">This project does not exist.</div>;
  }

  const [sessions, automations, memories, connectors, notebookAccounts, sources] = await Promise.all([
    db
      .select({ id: threads.id, title: threads.title, updatedAt: threads.updatedAt, profileName: agentProfiles.name })
      .from(threads)
      .innerJoin(agentProfiles, eq(agentProfiles.id, threads.agentProfileId))
      .where(
        and(
          eq(threads.workspaceId, auth.workspaceId),
          isNull(threads.archivedAt),
          eq(threads.subjectType, "project"),
          eq(threads.subjectId, projectId),
        ),
      )
      .orderBy(desc(threads.updatedAt))
      .limit(50),
    listAutomations(auth, projectId),
    listMemories(auth, projectId),
    listConnectors(auth),
    listProjectAccounts(auth, projectId),
    project.documents.length > 0
      ? listSources(auth, { documentIds: project.documents.map((d) => d.id), limit: 100 })
      : Promise.resolve([] as SourceRow[]),
  ]);

  return (
    <>
      <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
        <p className="text-[13px] text-muted-foreground">
          <Link href="/projects" className="hover:underline">Projects</Link>
          <span className="px-1.5">›</span>
          <span className="text-foreground">{project.title}</span>
        </p>
        <Link
          href={`/projects/${projectId}/settings`}
          aria-label="Project settings"
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[13px] hover:bg-muted"
        >
          <Settings aria-hidden className="size-4" /> Settings
        </Link>
      </div>
      <div className="grid gap-8 px-6 py-8 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span aria-hidden className="flex size-11 items-center justify-center rounded-xl bg-muted">
              <Folder className="size-5 text-muted-foreground" />
            </span>
            <h1 className="screen-title">{project.emoji ? `${project.emoji} ` : ""}{project.title}</h1>
          </div>
          <div className="mt-6">
            <StartSession
              projectId={projectId}
              projectTitle={project.title}
              contextPrefix={buildProjectContextPrefix(project, memories)}
            />
          </div>
          <section aria-label="Sessions" className="mt-10">
            <h2 className="screen-title text-[20px]">Sessions</h2>
            {sessions.length === 0 ? (
              <p className="mt-3 text-[13px] text-muted-foreground">
                No sessions yet. Start one above and it will use this project&apos;s instructions and sources.
              </p>
            ) : (
              <ul className="mt-3 flex flex-col">
                {sessions.map((session) => (
                  <li key={session.id} className="flex items-center gap-3 rounded-md px-2 py-2.5 hover:bg-muted/50">
                    <Link href={`/alfred/${session.id}`} className="min-w-0 flex-1 truncate text-[15px] hover:underline">
                      {session.title ?? "Untitled session"}
                    </Link>
                    <Lock aria-hidden className="size-3.5 text-muted-foreground" />
                    <span className="w-16 text-right text-xs text-muted-foreground">{timeAgoShort(session.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <ProjectRightRail
          projectId={projectId}
          instructions={project.instructions}
          description={project.description ?? project.descriptionSeed}
          sources={sources.map((s) => ({ documentId: s.documentId, title: s.title, readiness: s.readiness }))}
          automations={automations.map((a) => ({ id: a.id, prompt: a.prompt, schedule: a.schedule, enabled: a.enabled }))}
          memories={memories.map((m) => ({ id: m.id, content: m.content }))}
          connectors={connectors.flatMap((c) =>
            c.accounts.map((account) => ({
              id: account.id,
              displayName: c.displayName,
              alias: account.alias ?? null,
              enabled: notebookAccounts.some((row) => row.gatewayAccountId === account.id && row.enabled),
            })),
          )}
        />
      </div>
    </>
  );
}

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64 w-full" />}>
      <ProjectSurface projectId={projectId} />
    </Suspense>
  );
}
