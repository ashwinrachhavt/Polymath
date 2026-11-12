import { connection } from "next/server";
import { notFound } from "next/navigation";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { projectDocumentIds } from "@/domains/knowledge/projects";
import { getChallenge } from "@/domains/learning/challenges";
import { PRACTICE_NAMES, PracticeSession } from "../practice-session";

export const metadata = { title: "Practice · Polymath" };

export default async function NotebookPracticePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const { projectId } = await params;
  const query = await searchParams;
  const challengeId = typeof query.challenge === "string" ? query.challenge : "";
  if (!/^[0-9a-f-]{36}$/i.test(challengeId)) notFound();
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const notebookSources = await projectDocumentIds(auth, projectId);
  if (!notebookSources) notFound();
  const challenge = await getChallenge(auth, projectId, challengeId);
  if (!challenge) notFound();
  return (
    <div className="page-content">
      <div className="mb-5">
        <a
          href={"/projects/" + projectId + "/notebook"}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Back to Notebook
        </a>
        <h1 className="mt-2 text-xl font-medium">{PRACTICE_NAMES[challenge.format]}</h1>
      </div>
      <PracticeSession projectId={projectId} challenge={challenge} />
    </div>
  );
}
