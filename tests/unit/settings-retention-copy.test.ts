import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";

/*
 * Privacy copy is mode-specific. The browser preview may say "nothing is
 * sent anywhere, everything stays in local storage"; a live authenticated
 * deployment must never render those claims - providers it can call are
 * named by the capability panel, and settings persist server-side.
 */

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/workspace/workspace-provider", () => ({
  useWorkspace: () => ({
    state: { preferences: { celebrations: false } },
    updatePreferences: vi.fn(),
    resetPreview: vi.fn(),
    notify: vi.fn(),
  }),
}));
vi.mock("@/app/(workspace)/settings/actions", () => ({
  loadPreferencesAction: vi.fn(),
  savePreferencesAction: vi.fn(),
  loadAssistantProfileAction: vi.fn(),
  saveAssistantProfileAction: vi.fn(),
}));
vi.mock("@/components/products/command-center/scheduler-panel", () => ({ SchedulerPanel: () => null }));

import Settings from "@/components/products/command-center/settings";

const PREVIEW_CLAIMS = [
  "Nothing. No provider, model or analytics call is made from this preview.",
  "in this browser&#x27;s local storage",
  "Until you clear the browser preview",
];

describe("Data and retention copy", () => {
  it("live authenticated mode never renders preview-only privacy claims", () => {
    const html = renderToStaticMarkup(
      h(Settings, {
        browserPreview: false,
        serverPreferences: { timezone: "UTC", weekStart: 1, appearance: "system", motion: "full", interfaceMode: "auto", version: 3 },
        capabilities: [],
      }),
    );
    for (const claim of PREVIEW_CLAIMS) {
      expect(html).not.toContain(claim);
    }
    expect(html).toContain("this deployment&#x27;s server");
    expect(html).toContain("persist on the server");
    expect(html).toContain("read from its environment");
    // The account-mode reset action says exactly what is cleared.
    expect(html).toContain("local preview edits only");
    expect(html).toContain("server records are not affected");
  });

  it("account-persistence copy describes authenticated settings only, never the preview", () => {
    const preview = renderToStaticMarkup(h(Settings, { browserPreview: true, capabilities: [] }));
    expect(preview).not.toContain("save to your account");
    expect(preview).not.toContain("load on every device");
    const account = renderToStaticMarkup(
      h(Settings, {
        browserPreview: false,
        serverPreferences: { timezone: "UTC", weekStart: 1, appearance: "system", motion: "full", interfaceMode: "auto", version: 3 },
        capabilities: [],
      }),
    );
    expect(account).toContain("save to your account");
  });

  it("browser preview mode keeps the preview claims", () => {
    const html = renderToStaticMarkup(h(Settings, { browserPreview: true, capabilities: [] }));
    for (const claim of PREVIEW_CLAIMS) {
      expect(html).toContain(claim);
    }
  });
});
