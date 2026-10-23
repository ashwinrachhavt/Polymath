import postgres from "postgres";

/*
 * The dev owner's workspace, provisioned the way resolveAuthContext would -
 * except already onboarded. The first-run gate (alfred home -> /onboarding
 * while workspaces.onboarded_at is null) is correct for people; the journey
 * suite exercises the product past that gate, so the setup stamps the marker
 * instead of walking the interview in every spec. Provisioning here, before
 * the first request, beats stamping after: the lazy create in
 * resolveAuthContext finds this membership and never makes a second,
 * un-stamped workspace. No DATABASE_URL means the caller manages the server
 * and its data; nothing here applies.
 */
export default async function globalSetup() {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const client = postgres(url, { max: 1 });
  try {
    await client.begin(async (tx) => {
      const [user] = await tx`
        insert into users (clerk_user_id) values ('dev-user')
        on conflict (clerk_user_id) do update set updated_at = now()
        returning id`;
      const [workspace] = await tx`
        insert into workspaces (name, slug, is_personal, onboarded_at)
        values ('Personal', ${`personal-${user.id}`}, true, now())
        on conflict (slug) do update
          set onboarded_at = coalesce(workspaces.onboarded_at, now())
        returning id`;
      await tx`
        insert into memberships (workspace_id, user_id, role, status)
        values (${workspace.id}, ${user.id}, 'owner', 'active')
        on conflict (workspace_id, user_id) do nothing`;
    });
  } finally {
    await client.end();
  }
}
