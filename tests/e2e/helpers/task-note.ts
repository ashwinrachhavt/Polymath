import type postgres from "postgres";

/*
 * The note a seeded task stands on.
 *
 * Since the one-note substrate every work read inner-joins `artifacts` through
 * `tasks.note_id`, so a task inserted without its note is invisible to the app.
 * The seed therefore writes all three rows the production writer writes: the
 * artifact, its first version, and the pointer - the body is markdown
 * ({format, text}) because that is what the Notes surface renders, and an
 * empty doc would open blank.
 *
 * Raw SQL, like every other e2e seeder: no drizzle, ids from gen_random_uuid().
 * Returns the artifact id so the caller can register it for cleanup.
 */
export async function insertTaskNote(
  client: postgres.Sql,
  input: { workspaceId: string; title: string; userId?: string | null },
): Promise<string> {
  const userId = input.userId ?? null;
  const [note] = await client<{ id: string }[]>`
    insert into artifacts (workspace_id, kind, title, template, created_by, updated_by)
    values (${input.workspaceId}, 'note', ${input.title}, 'issue', ${userId}, ${userId})
    returning id`;
  const [version] = await client<{ id: string }[]>`
    insert into artifact_versions (workspace_id, artifact_id, version_number, content, reason, created_by)
    values (${input.workspaceId}, ${note.id}, 1,
      ${JSON.stringify({ format: "markdown", text: input.title })}::jsonb, 'created', ${userId})
    returning id`;
  await client`update artifacts set current_version_id = ${version.id} where id = ${note.id}`;
  return note.id;
}
