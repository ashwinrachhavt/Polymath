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
 *   4. whether FORCE ROW LEVEL SECURITY binds the table owner too.
 *
 * Everything happens on a throwaway table and role the suite cleans up; the
 * app schema is untouched. The findings are logged per CI run and the ADR
 * records them. A skipped suite (local, no scratch DB) evaluates nothing.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

const PROBE_TABLE = "axiom_rls_probe_rows";
const PROBE_ROLE = "axiom_rls_probe";

suite("RLS evaluation (ASH-121 AC05)", () => {
  let client: NonNullable<typeof handle>["client"];
  const findings: Record<string, unknown> = {};

  beforeAll(async () => {
    if (!handle) return;
    client = handle.client;
    await client.unsafe(`drop table if exists ${PROBE_TABLE} cascade`);
    await client.unsafe(`drop role if exists ${PROBE_ROLE}`);
  });

  afterAll(async () => {
    if (!handle) return;
    await client.unsafe(`drop table if exists ${PROBE_TABLE} cascade`);
    await client.unsafe(`drop role if exists ${PROBE_ROLE}`);
    console.log("RLS evaluation findings:", JSON.stringify(findings));
    await handle.client.end();
  });

  it("records the connection role and whether a runtime role can exist", async () => {
    const [who] = await client.unsafe<{ current_role: string; is_super: boolean; bypass_rls: boolean }[]>(
      `select current_role, rolsuper as is_super, rolbypassrls as bypass_rls from pg_roles where rolname = current_role`,
    );
    findings.appRole = who;
    expect(who.current_role).toBeTruthy();

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
  });

  it("FORCE ROW LEVEL SECURITY binds the table owner as well", async () => {
    if (!findings.canCreateRuntimeRole) return;

    await client.unsafe(`alter table ${PROBE_TABLE} force row level security`);
    // The app connection itself (the table owner) is now subject to the policy.
    const [asOwnerUnset] = await client.unsafe<{ n: number }[]>(`select count(*)::int as n from ${PROBE_TABLE}`);
    findings.ownerUnderForceWithoutSetting = asOwnerUnset.n;
    expect(asOwnerUnset.n).toBe(0);

    const conn = await client.reserve();
    try {
      await conn.unsafe(`set axiom.workspace_id = 'ws-b'`);
      const [asOwnerScoped] = await conn.unsafe<{ n: number }[]>(`select count(*)::int as n from ${PROBE_TABLE}`);
      findings.ownerUnderForceWithSetting = asOwnerScoped.n;
      expect(asOwnerScoped.n).toBe(1);
      await conn.unsafe(`reset axiom.workspace_id`);
    } finally {
      conn.release();
    }
    await client.unsafe(`alter table ${PROBE_TABLE} no force row level security`);
  });
});
