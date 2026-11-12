import { and, eq, ne } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction } from "@/lib/db-transaction";
import { MissionError } from "./missions";
import { missions } from "./schema";

/*
 * Deleting a Mission from Learn is an archive: the row, its plan and its mock
 * sessions stay, and the Learn list stops showing it. The status it had
 * before is returned so the caller can offer an undo that puts it back
 * exactly, a draft as a draft and a started Mission as started.
 */

export type LiveMissionStatus = "draft" | "active";

const notFound = () => new MissionError("mission_not_found", "That Mission is not available.");

export async function archiveMission(
  auth: AuthContext,
  input: { missionId: string },
): Promise<{ priorStatus: LiveMissionStatus }> {
  return withTransaction(async (tx) => {
    const [row] = await tx
      .select({ status: missions.status, goal: missions.goal })
      .from(missions)
      .where(
        and(
          eq(missions.id, input.missionId),
          eq(missions.workspaceId, auth.workspaceId),
          ne(missions.status, "archived"),
        ),
      )
      .for("update")
      .limit(1);
    if (!row || row.status === "archived") throw notFound();
    const priorStatus = row.status;
    await tx
      .update(missions)
      .set({ status: "archived", updatedBy: auth.userId, updatedAt: new Date() })
      .where(and(eq(missions.id, input.missionId), eq(missions.workspaceId, auth.workspaceId)));
    await recordAudit(
      auth,
      {
        action: "learning.mission_archived",
        subjectType: "mission",
        subjectId: input.missionId,
        summary: "Deleted a Mission",
        metadata: { priorStatus },
      },
      tx,
    );
    return { priorStatus };
  });
}

/** Undo for archiveMission. It matches only an archived row, so a second restore finds nothing. */
export async function restoreMission(
  auth: AuthContext,
  input: { missionId: string; status: LiveMissionStatus },
): Promise<void> {
  await withTransaction(async (tx) => {
    const [restored] = await tx
      .update(missions)
      .set({ status: input.status, updatedBy: auth.userId, updatedAt: new Date() })
      .where(
        and(
          eq(missions.id, input.missionId),
          eq(missions.workspaceId, auth.workspaceId),
          eq(missions.status, "archived"),
        ),
      )
      .returning({ id: missions.id });
    if (!restored) throw notFound();
    await recordAudit(
      auth,
      {
        action: "learning.mission_restored",
        subjectType: "mission",
        subjectId: input.missionId,
        summary: "Restored a deleted Mission",
        metadata: { status: input.status },
      },
      tx,
    );
  });
}
