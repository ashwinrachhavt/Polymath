import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { externalAccounts } from "@/domains/integrations/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * resolveConnectedAccount — which mailbox the agent reads through.
 *
 * Value card
 * protects: the account a connected read picks: an explicit alias must name a
 *   usable account, and with no alias only a single healthy account is
 *   inferred. Ambiguity is refused rather than guessed, and another
 *   workspace's account is never visible.
 * fails_when: an alias resolves to an account in another workspace, a
 *   "connecting" or id-less account is treated as usable, two accounts silently
 *   pick the alphabetically first (the agent would read the wrong mailbox and
 *   say so confidently), or one account in another workspace makes a
 *   single-account workspace look ambiguous.
 * why_new: the function is new and untested; connected_read.ts delegates every
 *   account decision to it, so a regression here changes whose data an agent
 *   reads without any test failing.
 * seam: the exported query against real Postgres (tenancy and the status/alias
 *   rules are database facts, so a mock would only prove the mock).
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };

vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));

import { resolveConnectedAccount } from "@/domains/integrations/queries";

let a: { userId: string; workspaceId: string };
let b: { userId: string; workspaceId: string };
let aWork: string;
let bPersonal: string;
const ctx = (w: { userId: string; workspaceId: string }) => ({ ...w, role: "owner" as const });

async function account(
  workspaceId: string,
  values: { alias: string; provider?: string; status?: "active" | "connecting" | "expired"; composioId?: string | null },
) {
  // Composio ids are globally unique (external_accounts_composio_key), so each
  // seeded account gets its own; the caller asserts on the returned id.
  const composioConnectedAccountId =
    values.composioId === undefined ? `ca_${crypto.randomUUID()}` : values.composioId;
  await holder.db!.insert(externalAccounts).values({
    workspaceId,
    provider: values.provider ?? "gmail",
    alias: values.alias,
    status: values.status ?? "active",
    composioConnectedAccountId,
  });
  return composioConnectedAccountId ?? "";
}

beforeAll(async () => {
  holder.db = handle?.db;
  a = await seedWorkspace(handle!.db, `rca-${crypto.randomUUID()}`);
  b = await seedWorkspace(handle!.db, `rca-${crypto.randomUUID()}`);
  // A single healthy account for the happy path; another workspace's account
  // must never influence it.
  aWork = await account(a.workspaceId, { alias: "work-gmail" });
  bPersonal = await account(b.workspaceId, { alias: "personal-gmail" });
  await account(b.workspaceId, { alias: "work-gmail" });
});
afterAll(async () => { await handle?.client.end(); });

suite("resolveConnectedAccount (real Postgres)", () => {
  it("resolves an explicit alias, infers a sole account, and refuses ambiguity or a foreign alias", async () => {
    // Explicit alias in the caller's workspace.
    expect(await resolveConnectedAccount(ctx(a), "gmail", "work-gmail")).toEqual({
      ok: true,
      connectedAccountId: aWork,
      alias: "work-gmail",
    });

    // Another workspace's identically named account (seeded above) is not
    // visible to `a`.
    expect(await resolveConnectedAccount(ctx(a), "gmail", "work-gmail")).toMatchObject({
      connectedAccountId: aWork,
    });
    // ...and `b` still resolves its own two accounts as ambiguous.
    expect(await resolveConnectedAccount(ctx(b), "gmail")).toMatchObject({ ok: false, code: "ambiguous" });
    // Naming one in `b` works, so the ambiguity is only about inference.
    expect(await resolveConnectedAccount(ctx(b), "gmail", "personal-gmail")).toMatchObject({
      ok: true,
      connectedAccountId: bPersonal,
    });

    // A wrong alias is not connected, and says the provider and alias it tried.
    const missing = await resolveConnectedAccount(ctx(a), "gmail", "home-gmail");
    expect(missing).toMatchObject({ ok: false, code: "not_connected" });
    expect(missing.ok === false && missing.message).toContain("home-gmail");

    // With no alias and exactly one usable account, that account is inferred.
    const c = await seedWorkspace(handle!.db, `rca-${crypto.randomUUID()}`);
    const only = await account(c.workspaceId, { alias: "only", provider: "notion" });
    expect(await resolveConnectedAccount(ctx(c), "notion")).toEqual({
      ok: true,
      connectedAccountId: only,
      alias: "only",
    });

    // No account at all is a distinct outcome from ambiguity.
    expect(await resolveConnectedAccount(ctx(c), "gmail")).toMatchObject({ ok: false, code: "not_connected" });

    // An account that never finished connecting, or holds no Composio id, is
    // not a credential: treating one as usable would let an agent "read"
    // through an account with no token behind it.
    const d = await seedWorkspace(handle!.db, `rca-${crypto.randomUUID()}`);
    await account(d.workspaceId, { alias: "connecting", status: "connecting" });
    await account(d.workspaceId, { alias: "expired", status: "expired" });
    await account(d.workspaceId, { alias: "no-id", composioId: null });
    expect(await resolveConnectedAccount(ctx(d), "gmail")).toMatchObject({ ok: false, code: "not_connected" });
    expect(await resolveConnectedAccount(ctx(d), "gmail", "connecting")).toMatchObject({ ok: false, code: "not_connected" });
    expect(await resolveConnectedAccount(ctx(d), "gmail", "no-id")).toMatchObject({ ok: false, code: "not_connected" });

    // Adding one healthy account makes exactly that one the inference.
    const live = await account(d.workspaceId, { alias: "live" });
    expect(await resolveConnectedAccount(ctx(d), "gmail")).toEqual({
      ok: true,
      connectedAccountId: live,
      alias: "live",
    });
  });
});
