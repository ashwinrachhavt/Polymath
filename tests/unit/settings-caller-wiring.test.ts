import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The mode flag must follow the caller's actual execution mode, not just a
 * manually supplied prop: the /settings route passes browserPreview from
 * clerkConfigured (its established preview switch).
 */

const settingsProps = vi.hoisted(() => ({ fn: vi.fn((props: unknown) => (void props, null)) }));
vi.mock("@/components/products/command-center/settings", () => ({
  default: (props: unknown) => settingsProps.fn(props),
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn(), io: async () => undefined }));

const clerk = vi.hoisted(() => ({ clerkConfigured: true, devAuthBypass: false }));
vi.mock("@/lib/clerk", () => clerk);

const authContext = vi.hoisted(() => ({
  getAuthContext: vi.fn(async (): Promise<unknown> => ({ userId: "u", workspaceId: "w", role: "owner" })),
}));
vi.mock("@/lib/auth", () => authContext);
vi.mock("@/domains/identity/preferences", () => ({
  getPreferences: vi.fn(async () => ({
    timezone: "UTC",
    weekStart: 1,
    appearance: "system",
    motion: "full",
    version: 1,
  })),
}));
vi.mock("@/domains/agents/queries", () => ({ getDefaultProfile: vi.fn(async () => null) }));
vi.mock("@/lib/capability-config", () => ({ capabilityStatus: vi.fn(() => []) }));

let SettingsSurface: typeof import("@/app/(workspace)/settings/page").SettingsSurface;

describe("/settings route wiring", () => {
  beforeEach(async () => {
    // Shared workers reuse the module registry across files: a page cached
    // from a sibling settings test would carry that file's mocks. Re-import
    // per test so this file's wiring is what runs.
    vi.resetModules();
    ({ SettingsSurface } = await import("@/app/(workspace)/settings/page"));
    settingsProps.fn.mockClear();
    authContext.getAuthContext.mockImplementation(async () => ({ userId: "u", workspaceId: "w", role: "owner" }));
  });

  it("passes browserPreview=false and the account row when auth resolves", async () => {
    renderToStaticMarkup(await SettingsSurface());
    expect(settingsProps.fn.mock.calls[0][0]).toMatchObject({
      browserPreview: false,
      serverPreferences: { timezone: "UTC", weekStart: 1, version: 1 },
    });
  });

  /*
   * The preview branch is the "no account exists" case, not the "no Clerk keys"
   * case: the keyless dev harness has no keys yet getAuthContext still resolves
   * the dev owner. Branching on the flags made the form post version 0 forever.
   */
  it("passes browserPreview=true only when auth has no account", async () => {
    authContext.getAuthContext.mockRejectedValue(new Error("No signed-in session."));
    renderToStaticMarkup(await SettingsSurface());
    expect(settingsProps.fn.mock.calls[0][0]).toMatchObject({ browserPreview: true });
    expect(settingsProps.fn.mock.calls[0][0]).not.toHaveProperty("serverPreferences");
  });
});
