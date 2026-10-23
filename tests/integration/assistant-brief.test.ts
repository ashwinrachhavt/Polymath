import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentProfiles } from "@/domains/agents/schema";
import { auditEvents } from "@/domains/audit/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The assistant's learned brief (spec "It learns your taste") against a real
 * workspace: the default profile's name/description/instructions are reviewed
 * and changed through one compare-and-set write - stale views conflict,
 * overlong input is validation, empty retires to null, every save audits,
 * and no workspace can touch another's profile.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({ get db() { return holder.db; } }));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

import { updateDefaultProfileBrief } from "@/domains/agents/commands";
import { getDefaultProfile } from "@/domains/agents/queries";

beforeAll(() => { holder.db = handle?.db; });
afterAll(async () => { await handle?.client.end(); });

const workspace = async () => ({ ...await seedWorkspace(holder.db!, `brief-${crypto.randomUUID()}`), role: "owner" as const });
type Auth = Awaited<ReturnType<typeof workspace>>;

async function seedDefaultProfile(auth: Auth, name = "Polymath") {
  const [profile] = await holder.db!
    .insert(agentProfiles)
    .values({ workspaceId: auth.workspaceId, name, description: "Your agent.", instructions: "Learned during onboarding.", isDefault: true, createdBy: auth.userId, updatedBy: auth.userId })
    .returning();
  return profile;
}

suite("assistant brief (real Postgres)", () => {
  it("reviews, edits and audits the learned brief, bumping the version", async () => {
    const auth = await workspace();
    const seeded = await seedDefaultProfile(auth);
    expect(await getDefaultProfile(auth)).toMatchObject({ name: "Polymath", version: 1 });

    const saved = await updateDefaultProfileBrief(auth, { name: "Sage", description: "My writing partner.", instructions: "Plain words, short sentences.", expectedVersion: seeded.version });
    expect(saved).toMatchObject({ ok: true, profile: { name: "Sage", description: "My writing partner.", instructions: "Plain words, short sentences.", version: 2 } });

    const audit = await holder.db!.select().from(auditEvents).where(and(eq(auditEvents.workspaceId, auth.workspaceId), eq(auditEvents.action, "agent_profile.brief_saved")));
    expect(audit).toHaveLength(1);
    expect(audit[0].summary).toContain('"Sage"');
  });

  it("a stale view conflicts and changes nothing", async () => {
    const auth = await workspace();
    const seeded = await seedDefaultProfile(auth);
    const first = await updateDefaultProfileBrief(auth, { name: "First", expectedVersion: seeded.version });
    expect(first.ok).toBe(true);
    const stale = await updateDefaultProfileBrief(auth, { name: "Second", expectedVersion: seeded.version });
    expect(stale).toEqual({ ok: false, kind: "conflict" });
    expect(await getDefaultProfile(auth)).toMatchObject({ name: "First", version: 2 });
  });

  it("validates before writing: a name is required and caps hold", async () => {
    const auth = await workspace();
    const seeded = await seedDefaultProfile(auth);
    expect(await updateDefaultProfileBrief(auth, { name: "  ", expectedVersion: seeded.version })).toMatchObject({ ok: false, kind: "validation" });
    expect(await updateDefaultProfileBrief(auth, { name: "x".repeat(81), expectedVersion: seeded.version })).toMatchObject({ ok: false, kind: "validation" });
    expect(await updateDefaultProfileBrief(auth, { name: "Sage", description: "x".repeat(501), expectedVersion: seeded.version })).toMatchObject({ ok: false, kind: "validation" });
    expect(await getDefaultProfile(auth)).toMatchObject({ version: 1 });
  });

  it("saving empty retires that part of the brief to null, and the audit says retired", async () => {
    const auth = await workspace();
    const seeded = await seedDefaultProfile(auth);
    const retired = await updateDefaultProfileBrief(auth, { name: "Sage", description: "", instructions: "  ", expectedVersion: seeded.version });
    expect(retired).toMatchObject({ ok: true, profile: { description: null, instructions: null } });
    const audit = await holder.db!.select().from(auditEvents).where(and(eq(auditEvents.workspaceId, auth.workspaceId), eq(auditEvents.action, "agent_profile.brief_saved")));
    expect(audit[0].summary).toContain("description retired");
    expect(audit[0].summary).toContain("brief retired");
  });

  it("a name already taken in the workspace is validation, never a 500", async () => {
    const auth = await workspace();
    const seeded = await seedDefaultProfile(auth);
    await holder.db!.insert(agentProfiles).values({ workspaceId: auth.workspaceId, name: "Twin", isDefault: false, createdBy: auth.userId, updatedBy: auth.userId });
    const clash = await updateDefaultProfileBrief(auth, { name: "Twin", expectedVersion: seeded.version });
    expect(clash).toEqual({ ok: false, kind: "validation", error: "Another assistant profile already has this name." });
  });

  it("no workspace can read or move another's profile", async () => {
    const a = await workspace();
    const b = await workspace();
    await seedDefaultProfile(a);
    expect(await getDefaultProfile(b)).toBeNull();
    expect(await updateDefaultProfileBrief(b, { name: "Nope", expectedVersion: 1 })).toEqual({ ok: false, kind: "not_found" });
    expect(await getDefaultProfile(a)).toMatchObject({ name: "Polymath", version: 1 });
  });
});
