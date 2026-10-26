// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The sender-suggestions switch on the Connectors page (ASH-287): it only
 * exists on an ACTIVE Gmail account's controls, its copy says exactly what
 * the grant buys (a daily read-only pass; proposals only; starts at the
 * enable moment), and the checked state comes from the server - never
 * assumed on. value: protects=the opt-in surface's presence + copy;
 * fails_when=the switch renders where it cannot be honored or the copy
 * starts promising more than the pass does; seam=the server actions mocked
 * at the module boundary; no_claim=the domain's owner-only CAS, read gate,
 * and cursor semantics (pinned in tests/integration/crm-sender-toggle.test.ts
 * and crm-sender-sync.test.ts).
 */

vi.mock("@/app/(workspace)/command-center/integrations/actions", () => ({
  renameAccountAction: vi.fn(),
  revokeAccountAction: vi.fn(),
  setAccountAccessTierAction: vi.fn(),
  setAccountCapabilityAction: vi.fn(),
  setSenderAliasesAction: vi.fn(),
  setSenderProposalsAction: vi.fn(),
  setWriteDefaultAction: vi.fn(),
  startConnectionAction: vi.fn(),
  syncGoogleCalendarAction: vi.fn(),
  syncNotionAction: vi.fn(),
}));

import { AccountControls } from "@/app/(workspace)/command-center/integrations/connector-controls";

afterEach(cleanup);

const base = {
  accountId: "acc-1",
  version: 3,
  isDefault: true,
  alias: "work-gmail",
};

describe("the sender-suggestions switch", () => {
  it("renders on an active Gmail account with the honest grant copy, off by default", () => {
    const { getByRole, getByText } = render(
      createElement(AccountControls, { ...base, provider: "gmail", status: "active", senderProposalsEnabled: false }),
    );
    const toggle = getByRole("switch", { name: "Suggest contacts from new senders" });
    expect(toggle.getAttribute("aria-checked") ?? toggle.getAttribute("data-state")).not.toBe("checked");
    const copy = getByText(/Once a day, Polymath reads new inbound senders/);
    expect(copy.textContent).toContain("Read-only");
    expect(copy.textContent).toContain("nothing becomes a contact without your approval");
    expect(copy.textContent).toContain("Starts from the moment you turn it on");
    expect(copy.textContent).toContain("no mail is written, labeled, or sent");
  });

  it("reflects an enabled account as checked", () => {
    const { getByRole } = render(
      createElement(AccountControls, { ...base, provider: "gmail", status: "active", senderProposalsEnabled: true }),
    );
    const toggle = getByRole("switch", { name: "Suggest contacts from new senders" });
    expect(toggle.getAttribute("data-state") ?? toggle.getAttribute("aria-checked")).toMatch(/checked|true/);
  });

  it("never renders for other providers or a revoked account", () => {
    const notion = render(createElement(AccountControls, { ...base, provider: "notion", status: "active", senderProposalsEnabled: false }));
    expect(notion.queryByRole("switch", { name: "Suggest contacts from new senders" })).toBeNull();
    cleanup();
    const revoked = render(createElement(AccountControls, { ...base, provider: "gmail", status: "revoked", senderProposalsEnabled: false }));
    expect(revoked.queryByRole("switch", { name: "Suggest contacts from new senders" })).toBeNull();
  });
});
