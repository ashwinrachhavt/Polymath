// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The sender-suggestions switch on the Connectors page (ASH-287), behavior
 * rather than static render: a flip calls the owner-only server action with
 * the account version CAS; a server refusal (including a stale version) is
 * shown, not swallowed; and STOP ALWAYS WORKS - an owner who disconnected
 * the account or turned off read access after enabling still sees the pass
 * is on (paused) and can turn it off, while enabling there is disabled with
 * the reason named, matching the domain gates in setSenderProposals.
 * value: protects=the opt-in surface's presence, copy, and stop semantics;
 * fails_when=the switch hides paused state, blocks a stop, enables where the
 * domain would refuse, or drops a server error; seam=the server actions
 * mocked at the module boundary; no_claim=the domain's owner-only CAS, read
 * gate, and cursor semantics (tests/integration/crm-sender-toggle.test.ts
 * and crm-sender-sync.test.ts own those).
 */

const setSenderProposalsAction = vi.fn();

vi.mock("@/app/(workspace)/command-center/integrations/actions", () => ({
  renameAccountAction: vi.fn(),
  revokeAccountAction: vi.fn(),
  setAccountAccessTierAction: vi.fn(),
  setAccountCapabilityAction: vi.fn(),
  setSenderAliasesAction: vi.fn(),
  setSenderProposalsAction: (...args: unknown[]) => setSenderProposalsAction(...args),
  setWriteDefaultAction: vi.fn(),
  startConnectionAction: vi.fn(),
  syncGoogleCalendarAction: vi.fn(),
  syncNotionAction: vi.fn(),
}));

import { AccountControls, SenderProposalsRow } from "@/app/(workspace)/command-center/integrations/connector-controls";
import { senderProposalsBlockedReason } from "@/domains/crm/sender-proposals-gate";

beforeEach(() => {
  setSenderProposalsAction.mockReset();
  setSenderProposalsAction.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

const rowProps = { accountId: "acc-1", version: 3, alias: "work-gmail" };
const ARIA = { name: "Suggest contacts from new senders" };

describe("the sender-suggestions switch", () => {
  it("renders on an active Gmail account with the honest grant copy, off by default", () => {
    const { getByRole, getByText } = render(
      createElement(AccountControls, {
        accountId: "acc-1",
        version: 3,
        status: "active",
        isDefault: true,
        provider: "gmail",
        alias: "work-gmail",
        senderProposalsEnabled: false,
        senderProposalsBlocked: null,
      }),
    );
    expect(getByRole("switch", ARIA).getAttribute("aria-checked")).toBe("false");
    const copy = getByText(/Once a day, Polymath reads new inbound senders/);
    expect(copy.textContent).toContain("Read-only");
    expect(copy.textContent).toContain("no mail is written, labeled, or sent");
    expect(copy.textContent).toContain("nothing becomes a contact without your approval");
    expect(copy.textContent).toContain("Starts from the moment you turn it on");
  });

  it("turning it on calls the owner-only action with the version CAS", async () => {
    const { getByRole } = render(createElement(SenderProposalsRow, { ...rowProps, enabled: false, blocked: null }));
    fireEvent.click(getByRole("switch", ARIA));
    await waitFor(() => expect(setSenderProposalsAction).toHaveBeenCalledWith({ accountId: "acc-1", expectedVersion: 3, enabled: true }));
  });

  it("reflects the server state after a reload (enabled account renders checked)", () => {
    const { getByRole } = render(createElement(SenderProposalsRow, { ...rowProps, enabled: true, blocked: null }));
    expect(getByRole("switch", ARIA).getAttribute("aria-checked")).toBe("true");
  });

  it("surfaces a server refusal instead of swallowing it", async () => {
    setSenderProposalsAction.mockResolvedValue({ ok: false, error: "Turn on read access for this Gmail account first." });
    const { getByRole, findByRole } = render(createElement(SenderProposalsRow, { ...rowProps, enabled: false, blocked: null }));
    fireEvent.click(getByRole("switch", ARIA));
    const status = await findByRole("status");
    expect(status.textContent).toContain("Turn on read access");
  });

  it("surfaces a stale-version refusal so the owner reloads", async () => {
    setSenderProposalsAction.mockResolvedValue({ ok: false, error: "The connector account changed since you loaded it. Reload and try again." });
    const { getByRole, findByRole } = render(createElement(SenderProposalsRow, { ...rowProps, enabled: false, blocked: null }));
    fireEvent.click(getByRole("switch", ARIA));
    const status = await findByRole("status");
    expect(status.textContent).toContain("Reload and try again");
  });

  it("a disconnected account with the pass on shows it paused and still allows turning it off", async () => {
    const { getByRole, getByText } = render(createElement(SenderProposalsRow, { ...rowProps, enabled: true, blocked: "disconnected" }));
    const toggle = getByRole("switch", ARIA);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    expect(getByText(/On, but not running/).textContent).toContain("work-gmail is disconnected");
    fireEvent.click(toggle);
    await waitFor(() => expect(setSenderProposalsAction).toHaveBeenCalledWith({ accountId: "acc-1", expectedVersion: 3, enabled: false }));
  });

  it("a read-off account with the pass on shows it paused and still allows turning it off", async () => {
    const { getByRole, getByText } = render(createElement(SenderProposalsRow, { ...rowProps, enabled: true, blocked: "read_off" }));
    const toggle = getByRole("switch", ARIA);
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    expect(getByText(/On, but not running/).textContent).toContain("read access is off for work-gmail");
    fireEvent.click(toggle);
    await waitFor(() => expect(setSenderProposalsAction).toHaveBeenCalledWith({ accountId: "acc-1", expectedVersion: 3, enabled: false }));
  });

  it("enabling is disabled with the reason while the account is disconnected", () => {
    const { getByRole, getByText } = render(createElement(SenderProposalsRow, { ...rowProps, enabled: false, blocked: "disconnected" }));
    expect((getByRole("switch", ARIA) as HTMLButtonElement).disabled).toBe(true);
    expect(getByText("Reconnect work-gmail to turn this on.")).toBeTruthy();
  });

  it("enabling is disabled with the reason while read access is off", () => {
    const { getByRole, getByText } = render(createElement(SenderProposalsRow, { ...rowProps, enabled: false, blocked: "read_off" }));
    expect((getByRole("switch", ARIA) as HTMLButtonElement).disabled).toBe(true);
    expect(getByText("Turn on read access for work-gmail to turn this on.")).toBeTruthy();
  });

  it("never renders for other providers", () => {
    const { queryByRole } = render(
      createElement(AccountControls, {
        accountId: "acc-1",
        version: 3,
        status: "active",
        isDefault: true,
        provider: "notion",
        alias: "wiki",
      }),
    );
    expect(queryByRole("switch", ARIA)).toBeNull();
  });
});

describe("senderProposalsBlockedReason", () => {
  const eligible = { status: "active", allowRead: true, accessTier: "read_send", disabledCapabilities: [] };
  it("mirrors the domain enable gates", () => {
    expect(senderProposalsBlockedReason(eligible)).toBeNull();
    expect(senderProposalsBlockedReason({ ...eligible, status: "revoked" })).toBe("disconnected");
    expect(senderProposalsBlockedReason({ ...eligible, status: "failed" })).toBe("disconnected");
    expect(senderProposalsBlockedReason({ ...eligible, allowRead: false })).toBe("read_off");
    expect(senderProposalsBlockedReason({ ...eligible, disabledCapabilities: ["gmail.read"] })).toBe("read_off");
    expect(senderProposalsBlockedReason({ ...eligible, accessTier: null })).toBeNull();
  });
});
