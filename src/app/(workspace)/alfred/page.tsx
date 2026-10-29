import { Suspense } from "react";
import { io } from "next/cache";
import { redirect } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { getAuthContext } from "@/lib/auth";
import { isWorkspaceOnboarded } from "@/domains/agents/onboarding";
import { getProfileModelPolicy, listRecentRuns } from "@/domains/agents/queries";
import { availableModels, resolveModelId } from "@/domains/agents/models";
import { listSkills } from "@/domains/skills/queries";
import { displayTitle } from "@/lib/display-text";
import { stripMentionContext } from "@/components/chat/mention-context";
import { eveBridgeUnavailableReason } from "@/domains/agents/eve-driver";
import type { PickableSkill } from "./skills/slash-skill-menu";
import { groupHistory, type HistoryRow } from "./history";
import { HomeSurface } from "./home-surface";

export const metadata = { title: "Polymath" };

/*
 * Polymath is home: one composer, then the conversations that already exist.
 * The rail names the destination, so the page opens with the question rather
 * than a title restating it (agents/design.md: no oversized H1s, the greeting
 * is the whole of the header here).
 *
 * A fresh workspace shows the greeting and the composer and nothing else. An
 * empty history block would be chrome promising conversations the person has
 * not had yet; the composer is already the invitation.
 */

export async function AlfredSurface() {
  // Per-request data: auth resolution upserts identity and stamps now().
  await io();
  if (!process.env.DATABASE_URL?.trim()) {
    return (
      <div className="page-content flex flex-1 flex-col gap-10 pt-16">
        <div className="mx-auto w-full max-w-3xl">
          <EmptyState
            title="Agent storage is not configured"
            description="Set DATABASE_URL and apply the database migrations to view runs. Agent execution also needs an Eve runtime and model credentials (EVE_BASE_URL and OPENAI_API_KEY). Set EVE_BRIDGE_SECRET (32+ characters, shared with the Eve agent) to sign runs to Eve."
          />
        </div>
      </div>
    );
  }

  const auth = await getAuthContext();
  // First run goes to the interview: the workspace's supervisor agent is the
  // person's own representation, shaped by what onboarding learns. A workspace
  // that skipped it meets a placeholder agent, so the gate sends it there once.
  if (!(await isWorkspaceOnboarded(auth.workspaceId))) {
    redirect("/onboarding");
  }
  // The history read and the model policy are independent: issue them together
  // so the page costs one round trip per query rather than one per query in
  // sequence.
  const [runs, skillRows, modelPolicy] = await Promise.all([
    // Every conversation on this surface is a run, so runs are the history.
    // Fifty is a bounded read, not the whole table, and it is deep enough that
    // the grouped list still reaches "Older" for a regular user.
    listRecentRuns(auth.workspaceId, 50),
    // Only enabled skills can be pinned; the engine refuses anything else.
    listSkills(auth, { enabled: true }),
    getProfileModelPolicy(auth.workspaceId, "alfred"),
  ]);
  const skills: PickableSkill[] = skillRows.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
  }));
  const unavailable = eveBridgeUnavailableReason();
  // Only models whose provider key is present: offering one that cannot run
  // would freeze a model into a run that then fails on its first step.
  const models = availableModels();
  const stored = (modelPolicy as { primary?: unknown } | null)?.primary;
  const currentModel = resolveModelId(stored);

  const rows: HistoryRow[] = runs.map((run) => ({
    id: run.id,
    title: displayTitle(stripMentionContext(run.objective)) || "Untitled conversation",
    href: `/alfred/${run.id}`,
    at: run.createdAt,
  }));

  return (
    <HomeSurface
      history={groupHistory(rows)}
      skills={skills}
      models={models}
      currentModel={currentModel}
      notice={unavailable}
    />
  );
}

/*
 * A Suspense boundary is required, not decorative: `cacheComponents` refuses to
 * prerender a route that awaits `io()` outside one, and the workspace group's
 * loading.tsx shell does not count. The fallback matches the shell so a
 * navigation does not flash a second skeleton.
 */
export default function AlfredPage() {
  return (
    <Suspense fallback={<AlfredSkeleton />}>
      <AlfredSurface />
    </Suspense>
  );
}

function AlfredSkeleton() {
  return (
    <div role="status" aria-label="Loading Polymath" className="page-content flex flex-1 flex-col gap-10 pt-16">
      <Skeleton className="mx-auto h-7 w-80 max-w-full" />
      <Skeleton className="mx-auto h-24 w-full max-w-3xl" />
    </div>
  );
}
