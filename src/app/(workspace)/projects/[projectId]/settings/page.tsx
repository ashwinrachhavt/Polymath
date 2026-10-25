import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthContext } from "@/lib/auth";
import { getProjectDetail } from "@/domains/knowledge/projects";
import { listAutomations, listMemories, listProjectAccounts } from "@/domains/knowledge/project-settings";
import { listConnectors } from "@/domains/integrations/queries";
import { listSources } from "@/domains/knowledge/source-readiness";
import { ProjectSettingsForm } from "../../project-settings-form";

export const metadata = { title: "Project settings · Polymath" };

/*
 * Project settings (Perplexity parity): General (name, description,
 * instructions), Sources, Automations, Memory, Integrations/Connectors.
 * Members and Skills are shown but deferred - a workspace has one owner today.
 */

export async function SettingsSurface({ projectId }: { projectId: string }) {
  await connection();
  const auth = await getAuthContext();
  const project = await getProjectDetail(auth, projectId);
  if (!project) {
    return <div className="page-content text-[13px] text-muted-foreground">This project does not exist.</div>;
  }
  const [automations, memories, accounts, connectors, sources] = await Promise.all([
    listAutomations(auth, projectId),
    listMemories(auth, projectId),
    listProjectAccounts(auth, projectId),
    listConnectors(auth),
    project.documents.length > 0
      ? listSources(auth, { documentIds: project.documents.map((d) => d.id), limit: 100 })
      : Promise.resolve([]),
  ]);

  return (
    <>
      <div className="border-b border-border px-6 py-3">
        <p className="text-[13px] text-muted-foreground">
          <Link href="/projects" className="hover:underline">Projects</Link>
          <span className="px-1.5">›</span>
          <Link href={`/projects/${projectId}`} className="hover:underline">{project.title}</Link>
          <span className="px-1.5">›</span>
          <span className="text-foreground">Settings</span>
        </p>
      </div>
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <ProjectSettingsForm
          projectId={projectId}
          project={{ title: project.title, description: project.description ?? project.descriptionSeed, instructions: project.instructions, emoji: project.emoji }}
          sources={sources.map((s) => ({ documentId: s.documentId, title: s.title, readiness: s.readiness }))}
          automations={automations.map((a) => ({ id: a.id, prompt: a.prompt, schedule: a.schedule, enabled: a.enabled }))}
          memories={memories.map((m) => ({ id: m.id, content: m.content }))}
          connectors={connectors.flatMap((c) =>
            c.accounts.map((account) => ({
              id: account.id,
              label: `${c.displayName}${account.alias ? ` — ${account.alias}` : ""}`,
              enabled: accounts.some((row) => row.gatewayAccountId === account.id && row.enabled),
            })),
          )}
        />
      </div>
    </>
  );
}

export default async function ProjectSettingsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return (
    <Suspense fallback={<Skeleton className="m-6 h-64 w-full" />}>
      <SettingsSurface projectId={projectId} />
    </Suspense>
  );
}
