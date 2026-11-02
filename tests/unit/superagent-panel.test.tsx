/** The supervision panel's components: stage labels render, counts are the lists they link to, the drill-down reuses AgentPanel. */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PersonStageCard, TicketsView } from "@/components/superagent/tickets-view";
import { SettingsPanel } from "@/components/superagent/settings-panel";
import { superviseTickets, type StageGroup } from "@/components/superagent/view";
import type { Ticket } from "@/domains/superagent/core/model";
import { savePolicyAction } from "@/app/(workspace)/supervision/actions";

vi.mock("@/app/(workspace)/supervision/actions", () => ({
  savePolicyAction: vi.fn(async () => ({ ok: true })),
  dismissDecisionAction: vi.fn(async () => ({ ok: true })),
}));

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "t1",
    title: "Summarize the meeting",
    decisionId: "d1",
    mandate: {
      strength: "explicit",
      policyVersion: "abc123def4567890",
      basis: { via: "addressed", addressed: "direct" },
      actor: { source: "chat", id: "u1" },
      scope: "Summarize the meeting notes.",
    },
    channels: [],
    runs: [
      {
        id: "r1",
        state: "ended",
        createdAt: "2026-11-02T10:00:00.000Z",
        report: { state: "ready", summary: "Summary attached.", at: "2026-11-02T10:05:00.000Z" },
      },
    ],
    inputs: [],
    undelivered: [],
    origin: { triggerId: "tr1", triggerIds: ["tr1"] },
    createdAt: "2026-11-02T10:00:00.000Z",
    updatedAt: "2026-11-02T10:00:00.000Z",
    ...overrides,
  };
}

const readyTicket = makeTicket({ id: "t-ready", title: "Summarize the meeting" });
const queuedTicket = makeTicket({
  id: "t-queued",
  title: "Triage the failing check",
  runs: [{ id: "r2", state: "pending", createdAt: "2026-11-02T10:00:00.000Z" }],
});
const endedTicket = makeTicket({
  id: "t-ended",
  title: "Archive the branch",
  ended: { at: "2026-11-02T10:05:00.000Z", by: "human", outcome: "stopped" },
});

const groups: StageGroup[] = superviseTickets([readyTicket, queuedTicket, endedTicket]);

const inputChecked = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).checked;
const inputValue = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;

describe("PersonStageCard", () => {
  it("renders the stage label with the count of the list it links to", () => {
    const group = groups.find((candidate) => candidate.key === "person-review")!;
    render(<PersonStageCard group={group} />);
    const card = screen.getByRole("link");
    expect(within(card).getByText("Ready for review")).toBeDefined();
    expect(within(card).getByText(String(group.tickets.length))).toBeDefined();
    expect(card.getAttribute("href")).toBe("/supervision?view=tickets&stage=person-review");
  });
});

describe("TicketsView", () => {
  it("renders one row per ticket and the stage label on each", () => {
    render(<TicketsView groups={groups} />);
    const rows = screen.getAllByTestId("ticket-row");
    expect(rows).toHaveLength(3);
    for (const label of ["Ready for review", "Queued", "Ended"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it("shows exactly the filtered group a count linked to", () => {
    const group = groups.find((candidate) => candidate.key === "person-review")!;
    render(<TicketsView groups={groups} stage={group.key} />);
    const rows = screen.getAllByTestId("ticket-row");
    // The count a card rendered equals the length of the list it links to.
    expect(rows).toHaveLength(group.tickets.length);
    expect(within(rows[0]).getByText("Summarize the meeting")).toBeDefined();
  });

  it("expands a row into the drill-down showing the mandate as the procedure", () => {
    render(<TicketsView groups={groups} stage="person-review" />);
    fireEvent.click(within(screen.getAllByTestId("ticket-row")[0]).getByRole("button"));
    expect(screen.getByText(/Scope: Summarize the meeting notes\./)).toBeDefined();
    expect(screen.getByText(/a listed sender addressing the agent, addressed by direct/)).toBeDefined();
  });

  it("shows the empty state when a filtered group has no tickets", () => {
    render(<TicketsView groups={[]} stage="person-failed" />);
    expect(screen.getByText("No tickets here")).toBeDefined();
  });
});

describe("SettingsPanel", () => {
  beforeEach(() => {
    vi.mocked(savePolicyAction).mockClear();
  });

  it("renders the stored policy: paused, accept mode, rules, and version", () => {
    render(
      <SettingsPanel
        policy={{
          paused: true,
          acceptMode: "observe",
          version: "abcdef1234567890",
          rules: [
            {
              id: "rule-1",
              name: "Triage CI",
              instruction: "Triage failing checks on the main branch.",
              enabled: true,
            },
          ],
        }}
      />,
    );
    expect(inputChecked("Paused")).toBe(true);
    expect((screen.getByRole("radio", { name: /Observe/ }) as HTMLInputElement).checked).toBe(true);
    expect(inputValue("Rule 1 name")).toBe("Triage CI");
    expect(screen.getByText(/Policy abcdef123456/)).toBeDefined();
  });

  it("saves the edited policy through the action", async () => {
    render(<SettingsPanel policy={{ paused: false, acceptMode: "off", version: "abc123def4567890", rules: [] }} />);
    fireEvent.click(screen.getByRole("radio", { name: /Auto/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() =>
      expect(savePolicyAction).toHaveBeenCalledWith({ paused: false, acceptMode: "auto", rules: [] }),
    );
  });
});
