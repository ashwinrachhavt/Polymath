import { and, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { recordAudit } from "@/domains/audit/record";
import { artifacts } from "../knowledge/schema";
import { dayArtifactPins } from "./schema";

/*
 * Pin an artifact to a local day. The day is a view, so a pin is the whole
 * write: one row, idempotent by (workspace, user, local_date, artifact). The
 * composite FK on pinned_version_id makes a cross-artifact version pin a
 * database error, not an application bug to catch.
 */
export async function pinArtifactToDay(
  auth: AuthContext,
  input: { localDate: string; artifactId: string; pinnedVersionId?: string | null; position?: number },
): Promise<{ id: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.localDate)) {
    throw new Error(`Invalid local date: ${input.localDate}`);
  }

  // Restrict-scope check: the artifact must be this workspace's. The FK only
  // proves existence; tenancy is a query concern.
  const [artifact] = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!artifact) {
    throw new Error("Artifact not found in this workspace");
  }

  const inserted = await db
    .insert(dayArtifactPins)
    .values({
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      localDate: input.localDate,
      artifactId: input.artifactId,
      pinnedVersionId: input.pinnedVersionId ?? null,
      position: input.position ?? 0,
      createdBy: auth.userId,
    })
    .onConflictDoNothing({
      target: [
        dayArtifactPins.workspaceId,
        dayArtifactPins.userId,
        dayArtifactPins.localDate,
        dayArtifactPins.artifactId,
      ],
    })
    .returning({ id: dayArtifactPins.id });

  if (inserted[0]) {
    await recordAudit(auth, {
      action: "daybook.pin_added",
      subjectType: "artifact",
      subjectId: input.artifactId,
      summary: `Pinned to ${input.localDate}`,
      metadata: { localDate: input.localDate, pinnedVersionId: input.pinnedVersionId ?? null },
    });
    return { id: inserted[0].id };
  }

  // A duplicate pin resolves to the existing row: idempotent no-op, no second
  // audit row. Tenancy is already proven above.
  const [existing] = await db
    .select({ id: dayArtifactPins.id })
    .from(dayArtifactPins)
    .where(
      and(
        eq(dayArtifactPins.workspaceId, auth.workspaceId),
        eq(dayArtifactPins.userId, auth.userId),
        eq(dayArtifactPins.localDate, input.localDate),
        eq(dayArtifactPins.artifactId, input.artifactId),
      ),
    )
    .limit(1);
  return { id: existing?.id ?? "" };
}

export async function unpinArtifactFromDay(
  auth: AuthContext,
  input: { localDate: string; artifactId: string },
): Promise<void> {
  await db
    .delete(dayArtifactPins)
    .where(
      and(
        eq(dayArtifactPins.workspaceId, auth.workspaceId),
        eq(dayArtifactPins.userId, auth.userId),
        eq(dayArtifactPins.localDate, input.localDate),
        eq(dayArtifactPins.artifactId, input.artifactId),
      ),
    );
  await recordAudit(auth, {
    action: "daybook.pin_removed",
    subjectType: "artifact",
    subjectId: input.artifactId,
    summary: `Unpinned from ${input.localDate}`,
    metadata: { localDate: input.localDate },
  });
}
