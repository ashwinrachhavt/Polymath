import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEvents } from "@/domains/audit/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * D09 OAuth scaffolding invariants: attempts are single-use and time-boxed,
 * the state token is the only handle, and completion flips the account active
 * exactly once. No provider calls anywhere in this flow.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let connect: typeof import("@/domains/integrations/connect");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  await handle.client.unsafe(readFileSync("src/db/migrations/0031_seed_integration_catalog.sql", "utf8"));
  connect = await import("@/domains/integrations/connect");
});

afterAll(async () => {
  await handle?.client.end();
});

async function seed(slug: string) {
  const { userId, workspaceId } = await seedWorkspace(db, `${slug}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

suite("connection attempts", () => {
  it("begin -> attach -> complete flips the account active exactly once", async () => {
    const auth = await seed("oauth-happy");
    const happyCa = `ca_${crypto.randomUUID()}`;
    const { account, attempt } = await connect.beginConnection(auth, { provider: "gmail", alias: "work-gmail" });
    expect(account.status).toBe("connecting");
    expect(attempt.stateToken).toBeTruthy();

    const linked = await connect.attachProviderLink(auth, {
      attemptId: attempt.id,
      redirectUrl: "https://hosted.composio.dev/auth/abc",
    });
    expect(linked.providerRedirectUrl).toContain("composio");

    const done = await connect.completeConnection(auth, {
      stateToken: attempt.stateToken,
      providerConnectedAccountId: happyCa,
      scopesSummary: ["gmail.readonly", "gmail.send"],
    });
    expect(done.alreadyCompleted).toBe(false);
    expect(done.account.status).toBe("active");
    expect(done.account.composioConnectedAccountId).toBe(happyCa);
    expect(done.account.lastHealthyAt).toBeTruthy();

    // Replay with the same token is a no-op, not a second flip.
    const replay = await connect.completeConnection(auth, {
      stateToken: attempt.stateToken,
      providerConnectedAccountId: happyCa,
    });
    expect(replay.alreadyCompleted).toBe(true);

    const audits = await db.select().from(auditEvents).where(eq(auditEvents.workspaceId, auth.workspaceId));
    const actions = audits.filter((row) => row.subjectId === account.id).map((row) => row.action);
    expect(actions).toContain("integration.connection_started");
    expect(actions).toContain("integration.connection_completed");
  });

  it("unknown tokens fail, revoked aliases cannot reconnect, attach holds while pending", async () => {
    const auth = await seed("oauth-edges");
    await expect(
      connect.completeConnection(auth, { stateToken: crypto.randomUUID(), providerConnectedAccountId: "ca_nope" }),
    ).rejects.toMatchObject({ code: "conflict" });

    const commands = await import("@/domains/integrations/commands");
    const { account } = await connect.beginConnection(auth, { provider: "gmail", alias: "old-gmail" });
    await commands.setAccountStatus(auth, { accountId: account.id, expectedVersion: account.version, status: "revoked" });
    await expect(
      connect.beginConnection(auth, { provider: "gmail", alias: "old-gmail" }),
    ).rejects.toMatchObject({ code: "conflict" });

    const { attempt } = await connect.beginConnection(auth, { provider: "slack", alias: "team-slack" });
    await connect.completeConnection(auth, { stateToken: attempt.stateToken, providerConnectedAccountId: `ca_${crypto.randomUUID()}` });
    await expect(
      connect.attachProviderLink(auth, { attemptId: attempt.id, redirectUrl: "https://late.example" }),
    ).rejects.toMatchObject({ code: "stale_write" });
  });

  it("expired attempts cannot complete", async () => {
    const auth = await seed("oauth-expiry");
    const { attempt } = await connect.beginConnection(auth, { provider: "notion", alias: "wiki" });
    // Age the attempt past its TTL directly - the flow's clock is the row.
    await handle!.client.unsafe(
      `update connection_attempts set expires_at = now() - interval '1 minute' where id = '${attempt.id}'`,
    );
    await expect(
      connect.completeConnection(auth, { stateToken: attempt.stateToken, providerConnectedAccountId: "ca_x" }),
    ).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("expired") });
    // and the account stays connecting, never half-active
    const queries = await import("@/domains/integrations/queries");
    const cards = await queries.listConnectors(auth);
    const notion = cards.find((card) => card.provider === "notion");
    expect(notion?.accounts.find((a) => a.id === attempt.externalAccountId)?.status).toBe("connecting");
  });
});
