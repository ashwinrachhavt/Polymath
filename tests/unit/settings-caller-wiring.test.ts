import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The mode flag must follow the caller's actual execution mode, not just a
 * manually supplied prop: the /settings route passes browserPreview from
 * clerkConfigured (its established preview switch), and the command-center
 * dispatch threads it through, defaulting unknown callers to account mode
 * (which never makes no-egress claims).
 */

const settingsProps = vi.hoisted(() => ({ fn: vi.fn((props: unknown) => (void props, null)) }));
const dispatched = vi.hoisted(() => ({ fn: vi.fn((props: unknown) => (void props, null)) }));
vi.mock("@/components/products/command-center/settings", () => ({
  default: (props: unknown) => settingsProps.fn(props),
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), io: async () => undefined }));

const clerk = vi.hoisted(() => ({ clerkConfigured: true, devAuthBypass: false }));
vi.mock("@/lib/clerk", () => clerk);

const authContext = vi.hoisted(() => ({
  getAuthContext: vi.fn(async (): Promise<unknown> => ({ userId: "u", workspaceId: "w", role: "owner" })),
}));
vi.mock("@/lib/auth", () => authContext);
vi.mock("@/domains/identity/preferences", () => ({
  getPreferences: vi.fn(async () => ({ timezone: "UTC", weekStart: 1, appearance: "system", motion: "full", version: 1 })),
}));
vi.mock("@/domains/agents/queries", () => ({ getDefaultProfile: vi.fn(async () => null) }));
vi.mock("@/lib/capability-config", () => ({ capabilityStatus: vi.fn(() => []) }));

import { SettingsSurface } from "@/app/(workspace)/settings/page";

describe("/settings route wiring", () => {
  beforeEach(() => {
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

describe("command-center dispatch wiring", () => {
  it("threads browserPreview to the settings screen and defaults unknown callers to account mode", async () => {
    vi.doMock("next/dynamic", () => ({
      default: () => (props: unknown) => dispatched.fn(props),
    }));
    vi.resetModules();
    const { default: CommandCenterScreen } = await import("@/components/products/command-center/screen-dispatch");

    renderToStaticMarkup(h(CommandCenterScreen, { screen: "settings", browserPreview: true }));
    expect(dispatched.fn.mock.calls[0][0]).toMatchObject({ browserPreview: true });

    dispatched.fn.mockClear();
    renderToStaticMarkup(h(CommandCenterScreen, { screen: "settings" }));
    expect(dispatched.fn.mock.calls[0][0]).toMatchObject({ browserPreview: false });
  });
});
