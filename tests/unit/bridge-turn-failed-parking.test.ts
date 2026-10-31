import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The two agent bridges (polymath and specialist) are near-copies of the same
 * forwarding protocol, and they drift independently: the specialist bridge
 * shipped without the turn.failed parking handler the polymath side got, so a
 * specialist run whose turn failed kept its state "running" - the UI kept a
 * live Stop button on a conversation whose stream had already ended. These
 * tests pin the parking behavior on both bridges, so the next handler that
 * lands on one side and not the other fails here instead of in the UI.
 */

vi.mock("eve/hooks", () => ({ defineHook: (definition: unknown) => definition }));

const eventBridge = vi.hoisted(() => ({
  closeRun: vi.fn(async () => undefined),
  markWaitingForInput: vi.fn(async () => undefined),
  mirrorMessage: vi.fn(async () => undefined),
  recordQuestion: vi.fn(async () => undefined),
  recordRoundEvent: vi.fn(async () => undefined),
  recordToolCall: vi.fn(async () => undefined),
  recordUsageEvent: vi.fn(async () => undefined),
}));
vi.mock("@/domains/agents/event-bridge", () => eventBridge);

vi.mock("@/domains/agents/queries", () => ({
  getRunBySessionRef: vi.fn(async () => ({ id: "run_1" })),
}));

import polymathBridge from "../../eve/polymath/agent/hooks/bridge";
import specialistBridge from "../../eve/specialist/agent/hooks/bridge";

function ctx() {
  return {
    session: {
      id: "wrun_sess",
      auth: { current: { attributes: { workspaceId: "ws_1" } } },
    },
  } as never;
}

const failedTurn = { data: { turnId: "turn_9" }, meta: { at: 0 } };

beforeEach(() => {
  vi.clearAllMocks();
});

type Bridge = { events: Record<string, (event: unknown, ctx: never) => Promise<void>> };

describe("bridge turn.failed parking", () => {
  for (const [name, bridge] of [
    ["polymath", polymathBridge as Bridge],
    ["specialist", specialistBridge as Bridge],
  ] as const) {
    it(`${name}: a failed turn records the event and parks the run for input`, async () => {
      await bridge.events["turn.failed"](failedTurn, ctx());

      expect(eventBridge.recordRoundEvent).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "run_1", workspaceId: "ws_1", type: "turn.failed" }),
      );
      expect(eventBridge.markWaitingForInput).toHaveBeenCalledWith({ runId: "run_1", workspaceId: "ws_1" });
      // Parking, not closing: only session.completed/session.failed end the run.
      expect(eventBridge.closeRun).not.toHaveBeenCalled();
    });

    it(`${name}: an unknown session (no run to mirror into) is skipped`, async () => {
      const { getRunBySessionRef } = await import("@/domains/agents/queries");
      vi.mocked(getRunBySessionRef).mockResolvedValueOnce(null);

      await bridge.events["turn.failed"](failedTurn, ctx());

      expect(eventBridge.recordRoundEvent).not.toHaveBeenCalled();
      expect(eventBridge.markWaitingForInput).not.toHaveBeenCalled();
    });
  }
});
