import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { io } from "next/cache";
import { z } from "zod";
import { Screen } from "@/components/workspace/ui";
import { listUnfinishedGenerationJobs } from "@/domains/jobs/queries";
import { getMission } from "@/domains/learning/missions";
import { MISSION_JOB_KIND, missionJobSubject } from "@/domains/learning/mission-jobs";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { MissionJobs } from "../mission-jobs";
import { MissionPlanEditor } from "./plan-editor";
import { ReadinessReport } from "./readiness-report";
import { MockInterview } from "./mock-interview";
import { getMissionReport } from "@/domains/learning/mission-mock";

export const metadata = { title: "Mission · Polymath" };

/*
 * One Mission. While it is a draft, this is the wait for its concepts and
 * then the plan to approve. Once it is active it leads to the unaided mock
 * and, once that is sat, the readiness report. States: loading while the
 * concepts are written, empty while a source is still being read, failed with
 * retry, and the plan itself.
 */
export default function MissionPage({ params }: { params: Promise<{ missionId: string }> }) {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-6 text-body-dense text-muted-foreground">
          Opening the Mission…
        </p>
      }
    >
      <MissionSurface params={params} />
    </Suspense>
  );
}

async function MissionSurface({ params }: { params: Promise<{ missionId: string }> }) {
  await io();
  const { missionId } = await params;
  if (!z.uuid().safeParse(missionId).success) notFound();
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const mission = await getMission(auth, missionId);
  if (!mission) notFound();

  const [jobs, report] = await Promise.all([
    listUnfinishedGenerationJobs(auth, { kindPrefix: MISSION_JOB_KIND, subject: missionJobSubject(mission.id) }),
    mission.status === "active" ? getMissionReport(auth, mission.id) : Promise.resolve(null),
  ]);
  const hasMutablePlan = mission.status === "draft";

  return (
    <Screen
      title={mission.goal}
      description={
        mission.dueOn
          ? `To be performed by ${new Date(mission.dueOn + "T00:00:00Z").toLocaleDateString(undefined, {
              year: "numeric",
              month: "long",
              day: "numeric",
              timeZone: "UTC",
            })}.`
          : "A Mission without a date: a draft you can work on at your own pace."
      }
    >
      <p className="text-body-dense text-muted-foreground">
        From {mission.sourceTitles.length === 1 ? "" : `${mission.sourceTitles.length} sources: `}
        {mission.sourceTitles.join(", ")}
      </p>

      <MissionJobs initialJobs={jobs} subject={missionJobSubject(mission.id)} />

      {hasMutablePlan ? (
        mission.concepts.length === 0 ? (
          <section className="panel rounded-xl p-4">
            <h2 className="font-medium">Finding the concepts</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {jobs.some((job) => job.status === "failed")
                ? "The concepts could not be made. Retry above, or start over with a clearer source."
                : "Reading your sources and picking the concepts worth owning. This page updates on its own."}
            </p>
            <Link href="/learn/missions/new" className="mt-3 inline-block text-sm underline underline-offset-4">
              Start over
            </Link>
          </section>
        ) : (
          <section className="panel rounded-xl p-4">
            <h2 className="font-medium">Concepts to own</h2>
            <p className="mt-1 mb-3 text-sm text-muted-foreground">
              Each comes from a passage in your sources. Keep the ones that matter and add any you know you need, then
              start.
            </p>
            <MissionPlanEditor mission={mission} />
          </section>
        )
      ) : (
        <>
          <section className="panel rounded-xl p-4">
            <h2 className="font-medium">Your plan</h2>
            <ul className="mt-2 flex flex-col gap-2">
              {mission.concepts.map((concept) => (
                <li key={concept.id} className="rounded-lg border border-border p-3">
                  <p className="font-medium break-words">{concept.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{concept.reason}</p>
                  {concept.sourceQuote ? (
                    <blockquote className="mt-2 border-l-2 border-border pl-3 text-xs text-muted-foreground">
                      “{concept.sourceQuote}”
                    </blockquote>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
          {report && report.attempts.length > 0 ? (
            <ReadinessReport mission={mission} report={report} />
          ) : (
            <MockInterview mission={mission} />
          )}{" "}
        </>
      )}
      <Link href="/learn" className="text-body-dense font-medium underline-offset-4 hover:underline">
        Back to Learn
      </Link>
    </Screen>
  );
}
