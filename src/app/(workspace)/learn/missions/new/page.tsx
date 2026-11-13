import { connection } from "next/server";
import type { Metadata } from "next";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { searchCaptures } from "@/domains/capture/queries";
import { searchLearningDocuments } from "@/domains/learning/queries";
import type { LearningSourceOption } from "../../make-actions";
import { BackToLearn } from "../../back-to-learn";
import { MissionForm } from "./mission-form";

export const metadata: Metadata = { title: "New Mission · Polymath" };

/**
 * One screen for starting a Mission: the outcome, an optional date, an
 * optional role, and the sources to build it from. It opens with the newest
 * sources already picked so the common case is one sentence and a button.
 */
export default async function NewMissionPage() {
  await connection();
  const auth = await getAuthContext();
  requireRole(auth, "member");
  const [documents, captures] = await Promise.all([
    searchLearningDocuments(auth, { limit: 8 }),
    searchCaptures(auth, { filter: "unprocessed", limit: 8, offset: 0 }),
  ]);
  const initialSources: LearningSourceOption[] = [
    ...documents
      .filter((doc) => doc.ready)
      .map((doc) => ({ type: "document" as const, id: doc.id, title: doc.title, ready: doc.ready })),
    ...captures.items
      .filter((row) => row.hasText)
      .map((row) => ({
        type: "capture" as const,
        id: row.id,
        version: row.version,
        title: row.title?.trim() || row.preview?.trim().split("\n")[0] || row.url || "Untitled capture",
      })),
  ].slice(0, 8);

  return (
    <main className="page-content mx-auto w-full max-w-3xl">
      <div className="mb-4 flex items-center gap-2">
        <BackToLearn />
        <h1 className="min-w-0 text-2xl font-medium">New Mission</h1>
      </div>
      <MissionForm initialSources={initialSources} />
    </main>
  );
}
