import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/domains/identity/resolve";
import { releaseSpend, reserveSpend } from "@/domains/spending/commands";
import { createEngine } from "@/domains/agents/engine";

/*
 * The SQL is not what this test proves — tests/integration owns that. What it
 * proves is the ordering and the terminal-state contract: the reservation is
 * claimed before the driver is started, and a cancelled run cannot be cancelled
 * again.
 *
 * src/lib/db, src/lib/db-transaction, and the spending commands are faked
 * because this unit scope has no database; the transaction mock runs the
 * callback directly rather than opening one.
 */

const WS = "ws_1";
const OTHER_WS = "ws_2";
const auth: AuthContext = { userId: "u1", workspaceId: WS, role: "owner" };

const profileRow = {
  id: "prof_1",
  workspaceId: WS,
  name: "alfred",
  instructions: "Be brief.",
  modelPolicy: { primary: "claude-sonnet-4-6" },
  allowedTools: [],
  allowedAccounts: [],
  budgetPolicy: {},
  isDefault: true,
};

const RUN = { id: "run_1", workspaceId: WS, state: "queued" };

type StubResult = { rows?: unknown[]; returning?: unknown };
let stubResults: Record<string, StubResult> = {};
let calls: { sql: string; args: unknown[] }[] = [];

const { fakeDb } = vi.hoisted(() => ({ fakeDb: {} as Record<string, unknown> }));

vi.mock("@/lib/db", () => {
  const result = () => stubResults[(calls.at(-1)?.sql ?? "") as string] ?? {};
  const chain = (sqlText: string, args: unknown[]) => {
    calls.push({ sql: sqlText, args });
    const self: Record<string, unknown> = {};
    for (const method of ["from", "where", "limit", "values", "set"]) {
      self[method] = () => self;
    }
    self.returning = async () => result().returning ?? [];
    self.execute = async () => result().rows ?? [];
    // Executing a read chain is awaiting the chain itself (limit/from/where).
    self.then = (resolve: (value: unknown) => unknown) => resolve(result().returning ?? []);
    return self;
  };
  fakeDb.select = vi.fn(() => chain("select", []));
  fakeDb.insert = vi.fn(() => chain("insert", []));
  fakeDb.update = vi.fn(() => chain("update", []));
  fakeDb.execute = vi.fn(() => chain("execute", []));
  return { db: fakeDb };
});

vi.mock("@/domains/spending/commands", () => ({
  reserveSpend: vi.fn(async () => ({ ok: true, reservationId: "rsv_1" })),
  releaseSpend: vi.fn(async () => {}),
}));

vi.mock("@/lib/db-transaction", () => ({
  withTransaction: (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ execute: async () => stubResults.execute?.rows ?? [] }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  stubResults = {
    select: { returning: [profileRow] },
    insert: { returning: [{ id: RUN.id }] },
    update: { returning: [{ id: RUN.id }] },
    execute: { rows: [] },
  };
});

function fakeDriver() {
  const order: string[] = [];
  return {
    order,
    driver: {
      start: vi.fn(async () => void order.push("start")),
      signal: vi.fn(async () => void order.push("signal")),
      cancel: vi.fn(async () => void order.push("cancel")),
    },
  };
}

const runningRun = () => ({ id: RUN.id, workspaceId: WS, state: "running" as const });

const startInput = {
  auth,
  profileName: "alfred",
  objective: "Summarize the inbox",
  subjects: [],
  estimateUsd: "0.50",
};

describe("engine", () => {
  it("start claims the reservation before the driver starts the session", async () => {
    const { driver, order } = fakeDriver();
    vi.mocked(reserveSpend).mockImplementation(async () => {
      order.push("reserve");
      return { ok: true, reservationId: "rsv_1" };
    });

    const { runId, reservationId } = await createEngine(driver).start(startInput);

    expect(runId).toBe(RUN.id);
    expect(reservationId).toBe("rsv_1");
    expect(order).toEqual(["reserve", "start"]);
    expect(reserveSpend).toHaveBeenCalledWith(
      expect.anything(),
      { workspaceId: WS },
      { runId: RUN.id, model: "claude-sonnet-4-6", estimateUsd: "0.50" },
    );
    // The session is keyed on the run id and carries the frozen snapshot.
    expect(driver.start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: RUN.id,
        auth,
        instructions: "Be brief.",
        policy: expect.objectContaining({ profileId: "prof_1", model: "claude-sonnet-4-6" }),
      }),
    );
  });

  it("start closes the run and never starts a session when the ceiling is hit", async () => {
    const { driver } = fakeDriver();
    vi.mocked(reserveSpend).mockResolvedValueOnce({
      ok: false,
      reason: "ceiling_exceeded",
      action: "fail",
    });

    await expect(createEngine(driver).start(startInput)).rejects.toThrow("Spend ceiling exceeded");
    expect(driver.start).not.toHaveBeenCalled();
  });

  it("cancel is terminal-only-once: second cancel is a no-op", async () => {
    const { driver } = fakeDriver();
    const engine = createEngine(driver);

    stubResults.select = { returning: [runningRun()] };
    await expect(engine.cancel(RUN.id, auth)).resolves.toEqual({ cancelled: true });
    expect(driver.cancel).toHaveBeenCalledWith(RUN.id);

    // The conditional update matched nothing the second time.
    stubResults.update = { returning: [] };
    await expect(engine.cancel(RUN.id, auth)).resolves.toEqual({ cancelled: false });
    expect(driver.cancel).toHaveBeenCalledTimes(1);
  });

  it("cancel releases the run's open reservation", async () => {
    const { driver } = fakeDriver();
    stubResults.select = { returning: [runningRun()] };
    stubResults.execute = { rows: [{ id: "rsv_9" }] };

    await createEngine(driver).cancel(RUN.id, auth);

    expect(releaseSpend).toHaveBeenCalledWith(expect.anything(), { workspaceId: WS }, { reservationId: "rsv_9" });
  });

  it("signal and resume do nothing on a terminal run", async () => {
    const { driver } = fakeDriver();
    const engine = createEngine(driver);
    stubResults.select = { returning: [{ id: RUN.id, workspaceId: WS, state: "succeeded" }] };

    await engine.signal(RUN.id, "checkpoint", auth);
    await engine.resume(RUN.id, auth);

    expect(driver.signal).not.toHaveBeenCalled();
  });

  it("rejects a run owned by another workspace", async () => {
    const { driver } = fakeDriver();
    stubResults.select = { returning: [{ id: RUN.id, workspaceId: OTHER_WS, state: "running" }] };

    await expect(createEngine(driver).cancel(RUN.id, auth)).rejects.toThrow("run not found in workspace");
    expect(driver.cancel).not.toHaveBeenCalled();
  });
});
