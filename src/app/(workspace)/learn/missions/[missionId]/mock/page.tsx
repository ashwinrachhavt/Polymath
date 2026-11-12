import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { io } from "next/cache";
import { z } from "zod";
import { Screen } from "@/components/workspace/ui";
import { getMockSession, resumeOrStartMock } from "@/domains/learning/mission-mock";
import { getMission } from "@/domains/learning/missions";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { MockInterviewSession } from "../mock-session";

export const metadata = { title: "Mock interview · Polymath" };

/*
 * The unaided sitting. Opening this page for an active Mission with no
 * sitting yet starts one; the questions are written on the first visit and a
 * reload picks up the same sitting. The answers and the report are the same
 * page's data, so there is no client-side fetch to go stale.
 */
export default function MissionMockPage({
  params,
  searchParams,
}: {
  params: Promise<{ missionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense
      fallback={
        <p role="status" className="p-6 text-body-dense text-muted-foreground">
          Opening the mock interview…
        </p>
      }
    >
      <MockSurface params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function MockSurface({
  params,
  searchParams,
}: {
  params: Promise<{ missionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await io();
  const { missionId } = await params;
  const query = await searchParams;
  if (!z.uuid().safeParse(missionId).success) notFound();
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const mission = await getMission(auth, missionId);
  if (!mission) notFound();

  // Resume the sitting in progress, or open the one already taken; only an
  // explicit Retake asks for a new one. A reload never asks the same person
  // the same questions again, and never loses an answer.
  const { sessionId } = await resumeOrStartMock(auth, missionId, { retake: query.retake === "1" });
  const session = await getMockSession(auth, sessionId);
  if (!session) notFound();

  return (
    <Screen title="Mock interview" description={`${mission.goal} — answered from memory, one question at a time.`}>
      <MockInterviewSession mission={mission} session={session} />
      <Link
        href={`/learn/missions/${mission.id}`}
        className="text-body-dense font-medium underline-offset-4 hover:underline"
      >
        Back to the Mission
      </Link>
    </Screen>
  );
}
