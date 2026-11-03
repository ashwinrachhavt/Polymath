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
 *
 * A second provisioned dev user backs the invitation journey: its session is
 * selected per browser context by the polymath_dev_user cookie (lib/auth.ts,
 * dev fallback only), and its stored email is what the keyless harness's
 * sessionVerifiedEmail stands in for the Clerk claim with.
 */
export default async function globalSetup() {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const client = postgres(url, { max: 1 });
  try {
    await client.begin(async (tx) => {
      for (const [clerkUserId, email] of [
        ["dev-user", "owner@polymath.test"],
        ["dev-user-2", "member@polymath.test"],
      ] as const) {
        const [user] = await tx`
          insert into users (clerk_user_id, email) values (${clerkUserId}, ${email})
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
      }
    });
  } finally {
    await client.end();
  }
}
