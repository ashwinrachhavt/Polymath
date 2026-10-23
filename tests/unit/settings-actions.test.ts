import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@/lib/auth";

/*
 * The settings preferences/profile actions share the API-key boundary rule:
 * a driver failure answers with the action's generic message, never raw SQL;
 * authored auth strings pass through; a no-Clerk deployment gets the named
 * "not configured" result (ASH-193), not the thrown detail.
 */

const prefs = vi.hoisted(() => ({ getPreferences: vi.fn(), updatePreferences: vi.fn() }));
vi.mock("@/domains/identity/preferences", () => prefs);
const agentQueries = vi.hoisted(() => ({ getDefaultProfile: vi.fn() }));
vi.mock("@/domains/agents/queries", () => agentQueries);
const agentCommands = vi.hoisted(() => ({ updateDefaultProfileBrief: vi.fn() }));
vi.mock("@/domains/agents/commands", () => agentCommands);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const getAuthContext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth")>();
  return { ...original, getAuthContext };
});

import {
  loadAssistantProfileAction,
  loadPreferencesAction,
  saveAssistantProfileAction,
  savePreferencesAction,
} from "@/app/(workspace)/settings/actions";

const ownerAuth = { userId: "u", workspaceId: "w", role: "owner" as const };
const RAW_DB_ERROR = new Error(
  'Failed query: select "id" from "user_preferences" where "workspace_id" = $1 params: f4327824-9579-4245-9f04-6fcc7bb673c6',
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  getAuthContext.mockResolvedValue(ownerAuth);
});

describe("loadPreferencesAction", () => {
  it("sanitizes a driver error", async () => {
    prefs.getPreferences.mockRejectedValue(RAW_DB_ERROR);
    const result = await loadPreferencesAction();
    expect(result).toEqual({ ok: false, error: "Could not load preferences." });
    expect(JSON.stringify(result)).not.toContain("Failed query");
  });

  it("passes the authored auth message through", async () => {
    getAuthContext.mockRejectedValue(new UnauthorizedError());
    const result = await loadPreferencesAction();
    expect(result).toEqual({ ok: false, error: "No signed-in session." });
  });

  it("names an unconfigured deployment without echoing the thrown detail", async () => {
    getAuthContext.mockRejectedValue(new Error("clerk publishable key missing from env"));
    const result = await loadPreferencesAction();
    expect(result).toEqual({ ok: false, error: "Sign-in is not configured on this deployment." });
  });

  it("returns preferences on the healthy path", async () => {
    prefs.getPreferences.mockResolvedValue({ timezone: "UTC", version: 3 });
    const result = await loadPreferencesAction();
    expect(result).toEqual({ ok: true, preferences: { timezone: "UTC", version: 3 } });
  });
});

describe("savePreferencesAction", () => {
  it("sanitizes a driver error", async () => {
    prefs.updatePreferences.mockRejectedValue(RAW_DB_ERROR);
    const result = await savePreferencesAction({ expectedVersion: 1, timezone: "UTC" });
    expect(result).toEqual({ ok: false, error: "Could not save preferences." });
    expect(JSON.stringify(result)).not.toContain("Failed query");
  });
});

describe("assistant profile actions", () => {
  it("sanitizes a load failure", async () => {
    agentQueries.getDefaultProfile.mockRejectedValue(RAW_DB_ERROR);
    const result = await loadAssistantProfileAction();
    expect(result).toEqual({ ok: false, error: "Could not load the assistant profile." });
    expect(JSON.stringify(result)).not.toContain("Failed query");
  });

  it("sanitizes a save failure", async () => {
    agentCommands.updateDefaultProfileBrief.mockRejectedValue(RAW_DB_ERROR);
    const result = await saveAssistantProfileAction({ expectedVersion: 1 });
    expect(result).toEqual({ ok: false, error: "Could not save the assistant profile." });
    expect(JSON.stringify(result)).not.toContain("Failed query");
  });
});
