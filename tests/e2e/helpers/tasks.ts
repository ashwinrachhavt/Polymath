import postgres from "postgres";

/*
 * Seed a task the composer journey can find. Same contract as the other
 * e2e seeders: the real schema, the shared dev workspace, every row
 * registered for cleanup, null (skip) when no database is configured.
 */

const seeded: string[] = [];

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
    const [task] = await client<{ id: string }[]>`
      insert into tasks (workspace_id, title, status, description)
      values (${owner.workspace_id}, ${input.title}, ${input.status ?? "ready"}, ${input.description ?? null})
      returning id
    `;
    seeded.push(task.id);
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
  if (!url || !seeded.length) return;
  const client = postgres(url, { max: 1 });
  try {
    await client`delete from tasks where id = any(${seeded}::uuid[])`;
    seeded.length = 0;
  } finally {
    await client.end();
  }
}
