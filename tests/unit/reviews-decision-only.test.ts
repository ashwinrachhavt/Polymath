// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * ASH-284: a decision-only proposal (no executor for its capability) must
 * SAY so on the review card - approving records the decision and nothing
 * runs, and the copy must never imply GitHub changed. The flag is computed
 * server-side from supportsEffect; this pins the rendering half.
 *
 * value: protects=the decision-only line's presence/absence; fails_when=the
 * card drops the line or shows it for executed capabilities; seam=the
 * server actions mocked at the module boundary; no_claim=the executor gate
 * itself (pinned in tool-authorization tests).
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/(workspace)/reviews/actions", () => ({
  decideProposalAction: vi.fn(),
  reviseProposalAction: vi.fn(),
}));

import { ReviewsQueue, type QueueCardData } from "@/app/(workspace)/reviews/reviews-queue";

afterEach(cleanup);

function card(over: Partial<QueueCardData>): QueueCardData {
  return {
    id: "6557a1d2-0000-4000-8000-0000000000aa",
    version: 1,
    title: "Triage ashwinrachhavt/Polymath#42: Inbox badge keeps a count",
    capability: "github.issue.triage",
    riskClass: "prepare",
    status: "pending",
    expectedEffect: "On ashwinrachhavt/Polymath#42: add label bug. Nothing is applied automatically.",
    accountAlias: null,
    decisionOnly: true,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    decidedAt: null,
    expired: false,
    flags: null,
    latestRevision: { id: "6557a1d2-0000-4000-8000-0000000000bb", revisionNumber: 1, payload: {}, preview: null },
    proposedBy: null,
    reviews: [],
    ...over,
  };
}

const NO_OP = () => {};

describe("reviews queue decision-only proposals", () => {
  it("says approving records the decision and nothing changes on GitHub", () => {
    const screen = render(createElement(ReviewsQueue, { items: [card({})], onFilterChange: NO_OP } as never));
    screen.getByText(/Approving records the decision only/);
    screen.getByText(/nothing changes on GitHub/i);
    // The card never claims a label, assignment, or close happened.
    expect(screen.queryByText(/labeled|assigned|closed on GitHub/i)).toBeNull();
  });

  it("does not show the decision-only line for a capability with an executor", () => {
    const screen = render(
      createElement(ReviewsQueue, {
        items: [card({ capability: "notion.page.append", decisionOnly: false })],
        onFilterChange: NO_OP,
      } as never),
    );
    expect(screen.queryByText(/Approving records the decision only/)).toBeNull();
  });
});
