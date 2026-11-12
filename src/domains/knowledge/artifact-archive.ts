import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { recordAudit } from "@/domains/audit/record";
import type { AuthContext } from "@/domains/identity/resolve";
import { withTransaction } from "@/lib/db-transaction";
import { artifacts } from "./schema";

/*
 * Delete for ideas and generated artifacts, as a reversible archive. The row
 * and its versions stay (links, citations and runs keep their referent); every
 * list already filters `archivedAt is null`, so archiving removes it from
 * Ideas, Artifacts and pickers at once. Restore clears the stamp, which is
 * what the delete toast's Undo calls.
 *
 * Status is left alone on purpose: archive is a visibility switch, not a
 * lifecycle step, so restore can return the row exactly as it was.
 */

export class ArtifactArchiveError extends Error {
  constructor(
    readonly code: "not_found",
    message: string,
  ) {
    super(message);
    this.name = "ArtifactArchiveError";
  }
}

export async function archiveArtifact(auth: AuthContext, input: { artifactId: string }): Promise<void> {
  await withTransaction(async (tx) => {
    const [row] = await tx
      .update(artifacts)
      .set({
        archivedAt: new Date(),
        updatedAt: new Date(),
        updatedBy: auth.userId,
        version: sql`${artifacts.version} + 1`,
      })
      .where(
        and(
          eq(artifacts.id, input.artifactId),
          eq(artifacts.workspaceId, auth.workspaceId),
          isNull(artifacts.archivedAt),
        ),
      )
      .returning({ id: artifacts.id, title: artifacts.title, kind: artifacts.kind });
    if (!row) throw new ArtifactArchiveError("not_found", "That item is already gone. Reload to see the current list.");
    await recordAudit(
      auth,
      {
        action: "artifact.archived",
        subjectType: "artifact",
        subjectId: row.id,
        summary: `Archived ${row.kind}: ${row.title}`,
      },
      tx,
    );
  });
}

export async function restoreArtifact(auth: AuthContext, input: { artifactId: string }): Promise<void> {
  await withTransaction(async (tx) => {
    const [row] = await tx
      .update(artifacts)
      .set({
        archivedAt: null,
        updatedAt: new Date(),
        updatedBy: auth.userId,
        version: sql`${artifacts.version} + 1`,
      })
      .where(
        and(
          eq(artifacts.id, input.artifactId),
          eq(artifacts.workspaceId, auth.workspaceId),
          isNotNull(artifacts.archivedAt),
        ),
      )
      .returning({ id: artifacts.id, title: artifacts.title, kind: artifacts.kind });
    if (!row) throw new ArtifactArchiveError("not_found", "There is nothing to restore.");
    await recordAudit(
      auth,
      {
        action: "artifact.restored",
        subjectType: "artifact",
        subjectId: row.id,
        summary: `Restored ${row.kind}: ${row.title}`,
      },
      tx,
    );
  });
}
