import { io } from "next/cache";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuthContext } from "@/lib/auth";
import {
  findLatestOnboardingRun,
  isWorkspaceOnboarded,
  getOnboardingSession,
  readOnboardingProfileVersion,
  readOnboardingRun,
} from "@/domains/agents/onboarding";
import { readWizardState } from "@/domains/agents/onboarding-assist";
import { OnboardingWizard } from "./onboarding-wizard";
import { resolveReloadSurface } from "./reload-surface";

export const metadata = { title: "Meet your agent · Polymath" };

// Every branch renders its surface in the same centered wrapper; named once
// so the page reads as a decision, not as a stack of identical divs.
const surfaceWrap = (node: React.ReactNode) => (
  <div className="page-content flex flex-1 items-center justify-center pt-16">{node}</div>
);

/*
 * First-run onboarding: a four-step wizard — role, tools and priorities, the
 * person's own words with one quiet assist, then an editable review — and
 * the commit path every onboarding shape shares (completeOnboarding). There
 * is no run anywhere in the flow itself: the questions are forms, the assist
 * is one awaited action, and nothing polls or streams.
 *
 * The page is the reload anchor. It re-derives where the flow stands from
 * the database on every load — a mid-wizard reload resumes at its persisted
 * step and draft, a finished run's brief opens the review step, a failed
 * legacy run lands on the wizard with what its thread could salvage (never
 * an auto-start, F5) — so no client state is ever load-bearing. A legacy
 * in-flight interview run resolves through the same decision: its brief (if
 * the final turn landed) opens review; otherwise the wizard restarts with
 * the salvage as prefilled fields, and completeOnboarding's sweep retires
 * the dead run row when the wizard commits.
 */
async function OnboardingSurface() {
  await io();
  const auth = await getAuthContext();
  if (await isWorkspaceOnboarded(auth.workspaceId)) {
    redirect("/polymath");
  }

  const latest = await findLatestOnboardingRun(auth.workspaceId);
  const surface = resolveReloadSurface(
    latest,
    latest ? await readOnboardingRun(auth, latest.id) : null,
    readWizardState(await getOnboardingSession(auth.workspaceId)),
  );
  if (surface.kind === "review") {
    // A run's validated brief, with the profile version its card races on.
    return surfaceWrap(
      <OnboardingWizard step="review" draft={{ ...surface.brief }} profileVersion={surface.profileVersion} />,
    );
  }
  return surfaceWrap(
    <OnboardingWizard
      step={surface.step}
      draft={surface.draft}
      prefill={surface.prefill}
      notice={surface.notice}
      profileVersion={await readOnboardingProfileVersion(auth.workspaceId)}
    />,
  );
}

/*
 * `connection()` and the auth resolve must sit inside a Suspense boundary
 * under cacheComponents, or navigation treats them as uncached data.
 */
export default function OnboardingPage() {
  return (
    <Suspense fallback={<OnboardingSkeleton />}>
      <OnboardingSurface />
    </Suspense>
  );
}

/*
 * Shape-matched to step one — title, description line, chip row, field,
 * continue — so the fallback resolves into the wizard instead of into a
 * jump (the knowledge page's skeleton is the pattern).
 */
function OnboardingSkeleton() {
  return (
    <div role="status" aria-label="Loading onboarding" className="mx-auto flex w-full max-w-xl flex-col gap-6 pt-16">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-4 w-full max-w-md" />
      <div className="flex flex-wrap gap-1.5">
        <Skeleton className="h-7 w-20 rounded-full" />
        <Skeleton className="h-7 w-24 rounded-full" />
        <Skeleton className="h-7 w-16 rounded-full" />
        <Skeleton className="h-7 w-28 rounded-full" />
      </div>
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-8 w-24" />
    </div>
  );
}
