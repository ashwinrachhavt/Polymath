import postgres from "postgres";
import { insertTaskNote } from "./task-note";

/*
 * Seed a task the composer journey can find. Same contract as the other
 * e2e seeders: the real schema, the shared dev workspace, every row
 * registered for cleanup, null (skip) when no database is configured.
 *
 * A task stands on a note (one note substrate), and every work read inner-joins
 * that note, so the seed writes the note, its first markdown version and the
 * task's note_id in the same pass. A task row alone is invisible to the app.
 */

const seeded: string[] = [];
/** The notes the seeded tasks stand on; deleted after their tasks release the FK. */
const seededNotes: string[] = [];

function connection(): string | null {
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile();
    } catch {
      // No .env: stay unseeded and let the caller skip.
    }
  }
  return process.env.DATABASE_URL ?? null;
}

export async function seedTask(input: { title: string; status?: string; description?: string }): Promise<{ id: string } | null> {
  const url = connection();
  if (!url) return null;
  const client = postgres(url, { max: 1 });
  try {
    const [owner] = await client<{ workspace_id: string }[]>`
      select m.workspace_id
      from memberships m
      join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active'
      limit 1
    `;
    if (!owner) return null;
    const noteId = await insertTaskNote(client, { workspaceId: owner.workspace_id, title: input.title });
    const [task] = await client<{ id: string }[]>`
      insert into tasks (workspace_id, note_id, title, status)
      values (${owner.workspace_id}, ${noteId}, ${input.title}, ${input.status ?? "ready"})
      returning id
    `;
    seeded.push(task.id);
    seededNotes.push(noteId);
    return { id: task.id };
  } finally {
    await client.end();
  }
}

/** The stored description column, exactly as the database holds it (null when unset). */
export async function readTaskDescription(id: string): Promise<{ description: string | null } | null> {
  const url = connection();
  if (!url) return null;
  const client = postgres(url, { max: 1 });
  try {
    const [row] = await client<{ description: string | null }[]>`select description from tasks where id = ${id}::uuid`;
    return row ? { description: row.description } : null;
  } finally {
    await client.end();
  }
}

export async function cleanupSeededTasks(): Promise<void> {
  const url = connection();
  if (!url || (!seeded.length && !seededNotes.length)) return;
  const client = postgres(url, { max: 1 });
  try {
    // Tasks first: their note_id reference has no cascade, so the note cannot
    // go until the row pointing at it is gone.
    await client`delete from tasks where id = any(${seeded}::uuid[])`;
    await client`delete from artifacts where id = any(${seededNotes}::uuid[])`;
    seeded.length = 0;
    seededNotes.length = 0;
  } finally {
    await client.end();
  }
}
