import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers/test-workspace";

/*
 * ASH-121 AC05: the RLS evaluation, run as a probe against the real CI
 * database (Neon) instead of asserted from documentation. It records the
 * facts ADR 0002's "evaluate RLS" note needs:
 *
 *   1. what role the app actually connects as (superuser? BYPASSRLS?);
 *   2. whether this environment can create a separate runtime role;
 *   3. whether a tenant policy on current_setting('axiom.workspace_id')
 *      isolates rows under that role - and denies when the setting is absent;
 *   4. whether FORCE ROW LEVEL SECURITY binds a non-privileged table owner;
 *   5. what the application connection itself does under FORCE (recorded,
 *      asserted only for consistency with (1): a superuser / BYPASSRLS role
 *      ignores even FORCE RLS - that fact gates any adoption).
 *
 * Everything happens on throwaway tables and a role the suite cleans up; the
 * app schema is untouched. Findings are logged as they are learned so a late
 * failure cannot hide them, and the ADR records them. A skipped suite
 * (local, no scratch DB) evaluates nothing.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

const PROBE_TABLE = "axiom_rls_probe_rows";
const PROBE_OWNED_TABLE = "axiom_rls_probe_owned";
const PROBE_ROLE = "axiom_rls_probe";

type ProbeClient = NonNullable<typeof handle>["client"];

async function cleanup(client: ProbeClient) {
  // Order matters: a role with surviving grants (schema usage, table
  // privileges) cannot be dropped. DROP OWNED revokes those grants; it only
  // ever touches this throwaway role's property.
  await client.unsafe(`drop table if exists ${PROBE_TABLE} cascade`).catch(() => {});
  await client.unsafe(`drop table if exists ${PROBE_OWNED_TABLE} cascade`).catch(() => {});
  await client.unsafe(`drop owned by ${PROBE_ROLE}`).catch(() => {});
  await client.unsafe(`drop role if exists ${PROBE_ROLE}`).catch(() => {});
}

suite("RLS evaluation (ASH-121 AC05)", () => {
  let client: ProbeClient;
  const findings: Record<string, unknown> = {};
  const log = (label: string) => console.log(`RLS evaluation findings (${label}):`, JSON.stringify(findings));

  beforeAll(async () => {
    if (!handle) return;
    client = handle.client;
    await cleanup(client);
  });

  afterAll(async () => {
    if (!handle) return;
    await cleanup(client);
    console.log("RLS evaluation findings (final):", JSON.stringify(findings));
    await handle.client.end();
  });

  it("records the connection role and whether a runtime role can exist", async () => {
    const [who] = await client.unsafe<{ current_role: string; is_super: boolean; bypass_rls: boolean }[]>(
      `select current_role, rolsuper as is_super, rolbypassrls as bypass_rls from pg_roles where rolname = current_role`,
    );
    findings.appRole = who;
    expect(who.current_role).toBeTruthy();
    log("app role");

    findings.canCreateRuntimeRole = await client
      .unsafe(`create role ${PROBE_ROLE} nologin`)
      .then(() => true)
      .catch((error: unknown) => {
        findings.createRoleError = String(error);
        return false;
      });
    if (findings.canCreateRuntimeRole) {
      await client.unsafe(`grant usage on schema public to ${PROBE_ROLE}`);
    }
    log("runtime role");
  });

  it("isolates tenants under a current_setting policy and denies without the setting", async () => {
    if (!findings.canCreateRuntimeRole) return;

    await client.unsafe(`create table ${PROBE_TABLE} (id serial primary key, workspace_id text not null, note text)`);
    await client.unsafe(`insert into ${PROBE_TABLE} (workspace_id, note) values ('ws-a', 'alpha'), ('ws-b', 'beta')`);
    await client.unsafe(`alter table ${PROBE_TABLE} enable row level security`);
    await client.unsafe(
      `create policy tenant_isolation on ${PROBE_TABLE} using (workspace_id = current_setting('axiom.workspace_id', true))`,
    );
    await client.unsafe(`grant select on ${PROBE_TABLE} to ${PROBE_ROLE}`);

    // A reserved connection keeps SET ROLE on one connection; the pool would
    // hand each statement a different one.
    const conn = await client.reserve();
    try {
      await conn.unsafe(`set role ${PROBE_ROLE}`);
      await conn.unsafe(`set axiom.workspace_id = 'ws-a'`);
      const [scoped] = await conn.unsafe<{ n: number }[]>(`select count(*)::int as n from ${PROBE_TABLE}`);
      findings.probeRoleSeesOwnRows = scoped.n;
      expect(scoped.n).toBe(1);

      await conn.unsafe(`reset axiom.workspace_id`);
      const [unset] = await conn.unsafe<{ n: number }[]>(`select count(*)::int as n from ${PROBE_TABLE}`);
      findings.probeRoleWithoutSetting = unset.n;
      expect(unset.n).toBe(0); // no tenant claim, no rows: fail closed

      await conn.unsafe(`reset role`);
    } finally {
      conn.release();
    }
    log("tenant isolation");
  });

  it("records what FORCE ROW LEVEL SECURITY binds, and what it cannot", async () => {
    if (!findings.canCreateRuntimeRole) return;

    // First the deployment fact: what does the application connection (the
    // table owner here) see under FORCE? Asserted only for consistency with
    // the recorded role attributes - a superuser / BYPASSRLS role ignores
    // even FORCE RLS, anything else is bound as the owner and sees nothing
    // without a tenant claim.
    await client.unsafe(`alter table ${PROBE_TABLE} force row level security`);
    const [asOwnerUnset] = await client.unsafe<{ n: number }[]>(`select count(*)::int as n from ${PROBE_TABLE}`);
    findings.appConnectionUnderForce = asOwnerUnset.n;
    const appRole = (findings.appRole ?? {}) as { is_super?: boolean; bypass_rls?: boolean };
    findings.appConnectionBypassesRls = asOwnerUnset.n > 0;
    expect(asOwnerUnset.n).toBe(appRole.is_super || appRole.bypass_rls ? 2 : 0);

    // Then the FORCE semantics themselves, verified against a non-privileged
    // owner: the probe role owns this table, and FORCE must bind it too.
    await client.unsafe(
      `create table ${PROBE_OWNED_TABLE} (id serial primary key, workspace_id text not null, note text)`,
    );
    await client.unsafe(
      `insert into ${PROBE_OWNED_TABLE} (workspace_id, note) values ('ws-a', 'alpha'), ('ws-b', 'beta')`,
    );
    await client.unsafe(`alter table ${PROBE_OWNED_TABLE} enable row level security`);
    await client.unsafe(`alter table ${PROBE_OWNED_TABLE} force row level security`);
    await client.unsafe(
      `create policy tenant_isolation on ${PROBE_OWNED_TABLE} using (workspace_id = current_setting('axiom.workspace_id', true))`,
    );
    await client.unsafe(`alter table ${PROBE_OWNED_TABLE} owner to ${PROBE_ROLE}`);

    const conn = await client.reserve();
    try {
      await conn.unsafe(`set role ${PROBE_ROLE}`);
      const [unset] = await conn.unsafe<{ n: number }[]>(`select count(*)::int as n from ${PROBE_OWNED_TABLE}`);
      findings.probeOwnerUnderForceWithoutSetting = unset.n;
      expect(unset.n).toBe(0);

      await conn.unsafe(`set axiom.workspace_id = 'ws-b'`);
      const [scoped] = await conn.unsafe<{ n: number }[]>(`select count(*)::int as n from ${PROBE_OWNED_TABLE}`);
      findings.probeOwnerUnderForceWithSetting = scoped.n;
      expect(scoped.n).toBe(1);

      await conn.unsafe(`reset axiom.workspace_id`);
      await conn.unsafe(`reset role`);
    } finally {
      conn.release();
    }
    log("force row level security");
  });
});
