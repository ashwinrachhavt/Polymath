import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * D23 invariants: a preference row is per (workspace, user); the first save
 * must know it is the first save; every later save compare-and-sets the
 * version; another tenant never sees the row.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let preferences: typeof import("@/domains/identity/preferences");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  preferences = await import("@/domains/identity/preferences");
});

afterAll(async () => {
  await handle?.client.end();
});

suite("server-saved preferences (D23)", () => {
  it("a user who never saved reads defaults at version 0", async () => {
    const seeded = await seedWorkspace(db, `prefs-default-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const loaded = await preferences.getPreferences(auth);
    expect(loaded).toEqual({ timezone: "UTC", weekStart: 1, appearance: "system", motion: "full", version: 0 });
  });

  it("first save inserts version 1 and round-trips", async () => {
    const seeded = await seedWorkspace(db, `prefs-first-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const saved = await preferences.updatePreferences(auth, {
      expectedVersion: 0,
      timezone: "Asia/Kolkata",
      weekStart: 7,
      motion: "reduced",
    });
    expect(saved).toMatchObject({ timezone: "Asia/Kolkata", weekStart: 7, motion: "reduced", appearance: "system", version: 1 });
    const loaded = await preferences.getPreferences(auth);
    expect(loaded).toEqual(saved);
  });

  it("first save with a nonzero expectation conflicts instead of inserting", async () => {
    const seeded = await seedWorkspace(db, `prefs-stale0-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    await expect(
      preferences.updatePreferences(auth, { expectedVersion: 3, timezone: "UTC" }),
    ).rejects.toThrow(/changed in another tab or device/);
    expect((await preferences.getPreferences(auth)).version).toBe(0);
  });

  it("later saves compare-and-set: the stale writer loses", async () => {
    const seeded = await seedWorkspace(db, `prefs-cas-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    const v1 = await preferences.updatePreferences(auth, { expectedVersion: 0, timezone: "UTC" });
    const v2 = await preferences.updatePreferences(auth, { expectedVersion: v1.version, appearance: "dark" });
    expect(v2.version).toBe(2);
    expect(v2.appearance).toBe("dark");
    expect(v2.timezone).toBe("UTC");
    await expect(
      preferences.updatePreferences(auth, { expectedVersion: v1.version, motion: "reduced" }),
    ).rejects.toThrow(/changed in another tab or device/);
    expect((await preferences.getPreferences(auth)).motion).toBe("full");
  });

  it("another tenant never sees the row", async () => {
    const one = await seedWorkspace(db, `prefs-ten-a-${Date.now()}`);
    const two = await seedWorkspace(db, `prefs-ten-b-${Date.now()}`);
    const authA = ownerAuth(one.userId, one.workspaceId);
    const authB = ownerAuth(two.userId, two.workspaceId);
    await preferences.updatePreferences(authA, { expectedVersion: 0, timezone: "Europe/London", appearance: "light" });
    expect(await preferences.getPreferences(authB)).toMatchObject({ timezone: "UTC", version: 0 });
    // Saving in B must insert B's own row, not update A's.
    const savedB = await preferences.updatePreferences(authB, { expectedVersion: 0, motion: "reduced" });
    expect(savedB.version).toBe(1);
    expect((await preferences.getPreferences(authA)).timezone).toBe("Europe/London");
  });

  it("an invalid timezone is refused before any write", async () => {
    const seeded = await seedWorkspace(db, `prefs-bad-${Date.now()}`);
    const auth = ownerAuth(seeded.userId, seeded.workspaceId);
    await expect(
      preferences.updatePreferences(auth, { expectedVersion: 0, timezone: "Not/AZone" }),
    ).rejects.toThrow(/not a recognized IANA timezone/);
    expect((await preferences.getPreferences(auth)).version).toBe(0);
  });
});
