import postgres from "postgres";

/*
 * Seed a run the product cannot create on demand. A `waiting_approval` row is
 * only reachable after a model asks for a proposal, which the e2e harness has
 * no model for, so the state is written directly. Same database, same schema
 * the server reads.
 *
 * Every seeded row is registered for cleanup: the suite shares this database
 * with the developer's own data, and an e2e run that leaves runs behind fills
 * the Recent list and slows every later journey.
 *
 * Returns null when no database is configured: the caller skips, the way the
 * other data-dependent journeys do.
 */

const seeded: string[] = [];

function connection(): string | null {
  // The dev server reads .env itself; the test process does not, so a local
  // run without an exported DATABASE_URL would silently skip. Load the same
  // file the server loaded, without overriding CI's exported value.
  if (!process.env.DATABASE_URL) {
    try {
      process.loadEnvFile();
    } catch {
      // No .env: stay unseeded and let the caller skip.
    }
  }
  return process.env.DATABASE_URL ?? null;
}

export async function seedRun(input: {
  objective: string;
  state: "waiting_approval" | "waiting_input" | "succeeded";
}): Promise<{ id: string } | null> {
  const url = connection();
  if (!url) return null;

  const client = postgres(url, { max: 1 });
  try {
    // The page has already provisioned the dev owner on a prior visit.
    const [owner] = await client<{ workspace_id: string }[]>`
      select m.workspace_id
      from memberships m
      join users u on u.id = m.user_id
      where u.clerk_user_id = 'dev-user' and m.status = 'active'
      limit 1
    `;
    if (!owner) return null;

    const [profile] = await client<{ id: string }[]>`
      insert into agent_profiles (workspace_id, name, is_default)
      values (${owner.workspace_id}, 'polymath', true)
      on conflict (workspace_id, name) do update set updated_at = now()
      returning id
    `;

    const [run] = await client<{ id: string }[]>`
      insert into agent_runs (workspace_id, agent_profile_id, objective, state, policy_snapshot)
      values (${owner.workspace_id}, ${profile.id}, ${input.objective}, ${input.state}, '{}'::jsonb)
      returning id
    `;
    seeded.push(run.id);
    return { id: run.id };
  } finally {
    await client.end();
  }
}

/** Delete every run this process seeded. Call from a spec's afterAll. */
export async function removeSeededRuns(): Promise<void> {
  if (seeded.length === 0) return;
  const url = connection();
  if (!url) return;
  const client = postgres(url, { max: 1 });
  try {
    await client`delete from agent_runs where id = any(${seeded}::uuid[])`;
  } finally {
    await client.end();
    seeded.length = 0;
  }
}
