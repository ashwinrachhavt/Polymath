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
import {
  buildProjectContextPrefix,
  listAutomations,
  listMemories,
  listProjectAccounts,
} from "@/domains/knowledge/project-settings";
import { listConnectors } from "@/domains/integrations/queries";
import { listSources, type SourceRow } from "@/domains/knowledge/source-readiness";
import { listProjectSessions, type ProjectSessionRow } from "@/domains/agents/project-sessions";
import { ProjectRightRail } from "../project-right-rail";
import { ScanAgentSessions } from "../scan-agent-sessions";
import { StartSession } from "../start-session";

export const metadata = { title: "Project · Polymath" };

/** How the page names each agent source — the agent's own product name. */
const AGENT_SOURCE_LABEL: Record<ProjectSessionRow["source"], string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

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
    return <div className="page-content text-body-dense text-muted-foreground">This project does not exist.</div>;
  }

  const [sessions, automations, memories, connectors, notebookAccounts, sources, agentSessions] = await Promise.all([
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
    // Sessions Claude Code / Codex wrote in this project's repo (Workbench D3):
    // matched by transcript cwd, only when the project names a local repo path.
    project.repoPath ? listProjectSessions(auth, project.repoPath) : Promise.resolve([] as ProjectSessionRow[]),
  ]);

  return (
    <>
      <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
        <p className="text-body-dense text-muted-foreground">
          <Link href="/projects" className="hover:underline">
            Projects
          </Link>
          <span className="px-1.5">›</span>
          <span className="text-foreground">{project.title}</span>
        </p>
        <Link
          href={`/projects/${projectId}/settings`}
          aria-label="Project settings"
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-body-dense hover:bg-muted"
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
            <h1 className="screen-title">
              {project.emoji ? `${project.emoji} ` : ""}
              {project.title}
            </h1>
          </div>
          <div className="mt-6">
            <StartSession
              projectId={projectId}
              projectTitle={project.title}
              contextPrefix={buildProjectContextPrefix(project, memories)}
            />
          </div>
          {/* An empty "Sessions" heading told the reader nothing the starter
              above had not already said. The list appears only once there are
              sessions to list. */}
          {sessions.length > 0 ? (
            <section aria-label="Sessions" className="mt-10">
              <h2 className="screen-title text-title">Sessions</h2>
              <ul className="mt-3 flex flex-col">
                {sessions.map((session) => (
                  <li key={session.id} className="flex items-center gap-3 rounded-md px-2 py-2.5 hover:bg-muted/50">
                    <Link
                      href={`/polymath/${session.id}`}
                      className="min-w-0 flex-1 truncate text-body hover:underline"
                    >
                      {session.title ?? "Untitled session"}
                    </Link>
                    <Lock aria-hidden className="size-3.5 text-muted-foreground" />
                    <span className="w-16 text-right text-xs text-muted-foreground">
                      {timeAgoShort(session.updatedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Agent sessions (Workbench D3): what Claude Code / Codex wrote in
              this project's repo, parsed locally from the user's own files.
              The section exists even before the first scan — a missing section
              would hide the feature; the empty states say what to do. */}
          <section aria-label="Agent sessions" className="mt-10">
            <h2 className="screen-title text-title">Agent sessions</h2>
            {project.repoPath ? (
              <>
                <p className="mt-2 text-body-dense text-muted-foreground">
                  What Claude Code or Codex did in <span className="font-mono">{project.repoPath}</span>, parsed locally
                  from your own files — nothing was sent to a model. Set the folder in{" "}
                  <Link href={`/projects/${projectId}/settings`} className="underline">
                    project settings
                  </Link>
                  .
                </p>
                <div className="mt-3">
                  <ScanAgentSessions />
                </div>
                {agentSessions.length > 0 ? (
                  <ul className="mt-4 flex flex-col">
                    {agentSessions.map((agentSession) => (
                      <li
                        key={agentSession.id}
                        className="flex items-baseline gap-3 rounded-md px-2 py-2.5 hover:bg-muted/50"
                      >
                        <span className="w-20 shrink-0 text-xs text-muted-foreground">
                          {AGENT_SOURCE_LABEL[agentSession.source]}
                        </span>
                        <Link
                          href={`/projects/${projectId}/agent-sessions/${agentSession.id}`}
                          className="min-w-0 flex-1 truncate text-body hover:underline"
                        >
                          {agentSession.aiTitle ?? agentSession.externalSessionId}
                        </Link>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {agentSession.fileCount} file{agentSession.fileCount === 1 ? "" : "s"} ·{" "}
                          {agentSession.commandCount} command{agentSession.commandCount === 1 ? "" : "s"}
                          {agentSession.failureCount > 0 ? ` · ${agentSession.failureCount} failed` : ""}
                        </span>
                        <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
                          {agentSession.lastActivityAt ? timeAgoShort(agentSession.lastActivityAt) : "—"}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-body-dense text-muted-foreground">
                    No agent sessions scanned for this folder yet.
                  </p>
                )}
              </>
            ) : (
              <p className="mt-2 text-body-dense text-muted-foreground">
                Add this project&apos;s local repo path in{" "}
                <Link href={`/projects/${projectId}/settings`} className="underline">
                  settings
                </Link>{" "}
                and scan to see what Claude Code or Codex did in it, parsed from your own files.
              </p>
            )}
          </section>
        </div>

        <ProjectRightRail
          projectId={projectId}
          instructions={project.instructions}
          description={project.description ?? project.descriptionSeed}
          sources={sources.map((s) => ({ documentId: s.documentId, title: s.title, readiness: s.readiness }))}
          automations={automations.map((a) => ({
            id: a.id,
            prompt: a.prompt,
            schedule: a.schedule,
            enabled: a.enabled,
          }))}
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

/*
 * The params promise is read inside the boundary, not above it. Awaiting it in
 * the page body put URL data outside Suspense, which opts the whole route out
 * of instant navigation: the shell could not paint until the params resolved.
 * Passing the promise down and awaiting it in the child keeps the fallback the
 * first thing a navigation paints.
 */
export default function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64 w-full" />}>
      <ProjectRoute params={params} />
    </Suspense>
  );
}

async function ProjectRoute({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ProjectSurface projectId={projectId} />;
}
