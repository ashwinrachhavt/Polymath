import postgres from "postgres";

/*
 * Seed proposals the product cannot create on demand in e2e: an agent
 * proposal is only reachable after a model proposes one, and classification
 * proposals are async by design. Same database, same schema the server
 * reads; every seeded row is registered for cleanup.
 */

const seededProposals: string[] = [];
const seededCaptures: string[] = [];

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

async function workspaceIdOf(client: postgres.Sql): Promise<string | null> {
  const [owner] = await client<{ workspace_id: string }[]>`
    select m.workspace_id
    from memberships m
    join users u on u.id = m.user_id
    where u.clerk_user_id = 'dev-user' and m.status = 'active'
    limit 1
  `;
  return owner?.workspace_id ?? null;
}

export async function seedAgentProposal(input: { title: string; effect: string; riskClass: "prepare" | "external_write" | "sensitive_write" }): Promise<{ id: string } | null> {
  const url = connection();
  if (!url) return null;
  const client = postgres(url, { max: 1 });
  try {
    const workspaceId = await workspaceIdOf(client);
    if (!workspaceId) return null;
    const [proposal] = await client<{ id: string }[]>`
      insert into action_proposals (workspace_id, capability, risk_class, title, expected_effect, dedupe_key)
      values (${workspaceId}, 'gmail.send', ${input.riskClass}, ${input.title}, ${input.effect}, ${crypto.randomUUID()})
      returning id
    `;
    await client`
      insert into action_revisions (workspace_id, proposal_id, revision_number, payload)
      values (${workspaceId}, ${proposal.id}, 1, ${JSON.stringify({ to: "priya@example.com" })}::jsonb)
    `;
    seededProposals.push(proposal.id);
    return { id: proposal.id };
  } finally {
    await client.end();
  }
}

export async function seedCaptureProposal(input: { text: string; kind: "task" | "note" | "contact" }): Promise<{ id: string } | null> {
  const url = connection();
  if (!url) return null;
  const client = postgres(url, { max: 1 });
  try {
    const workspaceId = await workspaceIdOf(client);
    if (!workspaceId) return null;
    const [capture] = await client<{ id: string }[]>`
      insert into captures (workspace_id, kind, text)
      values (${workspaceId}, 'text', ${input.text})
      returning id
    `;
    const [proposal] = await client<{ id: string }[]>`
      insert into capture_proposals (workspace_id, capture_id, kind, payload, rationale, confidence)
      values (${workspaceId}, ${capture.id}, ${input.kind}, '{}'::jsonb, ${`${input.kind} 0.91`}, '0.91')
      returning id
    `;
    seededCaptures.push(capture.id);
    return { id: proposal.id };
  } finally {
    await client.end();
  }
}

/** Delete every proposal and capture this process seeded. Call from a spec's afterAll. */
export async function removeSeededProposals(): Promise<void> {
  const url = connection();
  if (!url) return;
  const client = postgres(url, { max: 1 });
  try {
    if (seededProposals.length) await client`delete from action_proposals where id = any(${seededProposals}::uuid[])`;
    if (seededCaptures.length) await client`delete from captures where id = any(${seededCaptures}::uuid[])`;
  } finally {
    await client.end();
    seededProposals.length = 0;
    seededCaptures.length = 0;
  }
}
