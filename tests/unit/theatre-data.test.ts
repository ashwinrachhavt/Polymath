import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/domains/identity/resolve";

/*
 * The theatre's degradation contract (ASH-308 acceptance 6): each region
 * reads independently, so one source throwing must come back as that
 * region's labelled error while the other regions still render. The day
 * bounds and the three domain reads are mocked - what is under test is the
 * isolation, not the queries.
 */

const execute = vi.fn();
vi.mock("@/lib/db", () => ({ db: { execute: (...args: unknown[]) => execute(...args) } }));

const listDayFocusSessions = vi.fn();
vi.mock("@/domains/focus/queries", () => ({
  listDayFocusSessions: (...args: unknown[]) => listDayFocusSessions(...args),
}));

const listEventsBetween = vi.fn();
vi.mock("@/domains/calendar/queries", () => ({
  listEventsBetween: (...args: unknown[]) => listEventsBetween(...args),
}));

const listCapturesArrivedBetween = vi.fn();
vi.mock("@/domains/capture/queries", () => ({
  listCapturesArrivedBetween: (...args: unknown[]) => listCapturesArrivedBetween(...args),
}));

import { getTheatreDay } from "@/app/(workspace)/command-center/briefing/theatre/theatre-data";

const auth = { workspaceId: "ws-1", userId: "user-1" } as unknown as AuthContext;

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue([
    {
      local_date: "2026-10-25",
      timezone: "UTC",
      day_start: "2026-10-25T00:00:00.000Z",
      day_end: "2026-10-26T00:00:00.000Z",
    },
  ]);
  listDayFocusSessions.mockResolvedValue([{ id: "session-1" }]);
  listEventsBetween.mockResolvedValue([{ id: "event-1" }]);
  listCapturesArrivedBetween.mockResolvedValue([{ id: "capture-1", createdAt: new Date("2026-10-25T09:00:00Z") }]);
});

describe("getTheatreDay degradation", () => {
  it("a failing calendar leaves sessions and captures rendering, with the region named", async () => {
    listEventsBetween.mockRejectedValue(new Error("calendar connection refused"));
    const day = await getTheatreDay(auth);
    expect(day.sessions).toHaveLength(1);
    expect(day.captures).toHaveLength(1);
    expect(day.events).toHaveLength(0);
    expect(day.errors.events).toBe("calendar connection refused");
    expect(day.errors.sessions).toBeUndefined();
    expect(day.errors.captures).toBeUndefined();
  });

  it("a failing focus source leaves events and captures rendering", async () => {
    listDayFocusSessions.mockRejectedValue(new Error("focus store down"));
    const day = await getTheatreDay(auth);
    expect(day.events).toHaveLength(1);
    expect(day.captures).toHaveLength(1);
    expect(day.errors.sessions).toBe("focus store down");
  });

  it("a failing capture source leaves sessions and events rendering", async () => {
    listCapturesArrivedBetween.mockRejectedValue(new Error("inbox unavailable"));
    const day = await getTheatreDay(auth);
    expect(day.sessions).toHaveLength(1);
    expect(day.events).toHaveLength(1);
    expect(day.errors.captures).toBe("inbox unavailable");
  });
});
