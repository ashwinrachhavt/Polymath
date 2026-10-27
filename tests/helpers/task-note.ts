import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import { artifactVersions, artifacts } from "@/domains/knowledge/schema";
import { tasks } from "@/domains/work/schema";

type Db = ReturnType<typeof drizzle>;
type TaskInsert = Omit<typeof tasks.$inferInsert, "id" | "workspaceId" | "noteId">;

/**
 * A task inserted by hand has to carry its note (one note substrate, 0260):
 * `tasks.note_id` is NOT NULL and every read joins `artifacts` for the title.
 * This writes the note, its version 1 and the extension row the way
 * `createTaskNote` does in production, so a fixture is shaped like a real task
 * without exercising the writer the suite is testing.
 *
 * The body is markdown ({format, text}), matching createTaskNote. A missing or
 * whitespace-only body keeps the empty doc createNoteInTx writes for a fresh
 * note in both projections, so "no description" reads the same whether the
 * fixture meant it or left it out.
 *
 * Returns the task row, the shape `db.insert(tasks).values(...).returning()`
 * gave callers before the prose moved onto the note.
 */
export async function seedTaskWithNote(
  db: Db,
  row: { workspaceId: string; title: string; body?: string | null } & Partial<TaskInsert>,
): Promise<typeof tasks.$inferSelect> {
  const { workspaceId, title, body, ...task } = row;
  const text = body?.trim() ? body : null;

  const [note] = await db
    .insert(artifacts)
    .values({
      workspaceId,
      kind: "note",
      title,
      template: "issue",
      createdBy: task.createdBy ?? null,
      updatedBy: task.updatedBy ?? null,
    })
    .returning({ id: artifacts.id });
  const [version] = await db
    .insert(artifactVersions)
    .values({
      workspaceId,
      artifactId: note.id,
      versionNumber: 1,
      content: text ? { format: "markdown", text } : { type: "doc", content: [] },
      plainText: text,
      reason: "created",
      createdBy: task.createdBy ?? null,
    })
    .returning({ id: artifactVersions.id });
  await db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, note.id));

  const [created] = await db
    .insert(tasks)
    .values({ ...task, workspaceId, noteId: note.id })
    .returning();
  return created;
}
