import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The canonical query log has three contracts to pin: exactly one line per
 * withQueryLog unit carrying key/durationMs/sql/paramCount and never an
 * argument value; silence without a context or with the flag off; and
 * transaction-scoped statements attributing to the wrapping context. The
 * transaction test mocks the driver the same way db-pool.test.ts does, with
 * one addition: the mock calls the logger drizzle would call pre-execution
 * (session.js: `this.logger.logQuery(this.queryString, params)`), so the
 * wiring from db.ts through drizzle's transaction into the ambient store is
 * exercised for real.
 */

const mocks = vi.hoisted(() => {
  type SessionLogger = { logQuery: (query: string, params: unknown[]) => void };
  return { logger: undefined as SessionLogger | undefined };
});

vi.mock("postgres", () => ({ default: () => ({}) }));
vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: (_client: unknown, config?: { logger?: { logQuery: (query: string, params: unknown[]) => void } }) => {
    mocks.logger = config?.logger;
    const tx = {
      // Emulates drizzle's pre-execution hook on the transaction session:
      // placeholder-form SQL, values only in params.
      execute: async () => {
        mocks.logger?.logQuery("INSERT INTO zettels (body) VALUES ($1)", ["tx-secret-value"]);
        return Object.assign([] as unknown[], { count: 1 });
      },
    };
    return { transaction: async (fn: (t: object) => Promise<unknown>) => fn(tx) };
  },
}));

let withQueryLog: typeof import("@/lib/db-query-log").withQueryLog;
let dbQueryLogger: typeof import("@/lib/db-query-log").dbQueryLogger;
let isQueryLogEnabled: typeof import("@/lib/db-query-log").isQueryLogEnabled;

beforeEach(async () => {
  // Shared workers (isolate: false) reuse one module registry per worker:
  // reset so the mocks above and a fresh store always win. Env stubs are
  // declared per test (the flag is read lazily at call time, never at import)
  // and restored by unstubAllEnvs — NODE_ENV is read-only to assign directly.
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  mocks.logger = undefined;
  ({ withQueryLog, dbQueryLogger, isQueryLogEnabled } = await import("@/lib/db-query-log"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("query-log flag", () => {
  it("is off by default outside development and on by default in development", () => {
    delete process.env.POLYMATH_DB_QUERY_LOG;
    vi.stubEnv("NODE_ENV", "test");
    expect(isQueryLogEnabled()).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(isQueryLogEnabled()).toBe(false);
    vi.stubEnv("NODE_ENV", "development");
    expect(isQueryLogEnabled()).toBe(true);
  });

  it("an explicit value beats the environment default", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("POLYMATH_DB_QUERY_LOG", "0");
    expect(isQueryLogEnabled()).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POLYMATH_DB_QUERY_LOG", "1");
    expect(isQueryLogEnabled()).toBe(true);
  });
});

describe("withQueryLog", () => {
  it("emits exactly one canonical line per unit, without argument values", async () => {
    vi.stubEnv("POLYMATH_DB_QUERY_LOG", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const rows = [{ id: 1 }, { id: 2 }];

    const result = await withQueryLog("notes.load", async () => {
      dbQueryLogger.logQuery("SELECT * FROM notes WHERE id = $1", ["secret-row-id"]);
      return rows;
    });

    expect(result).toBe(rows); // semantics of the wrapped unit never change
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(log.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(line.msg).toBe("db_query");
    expect(line.key).toBe("notes.load");
    expect(typeof line.durationMs).toBe("number");
    expect(line.sql).toBe("SELECT * FROM notes WHERE id = $1");
    expect(line.paramCount).toBe(1);
    expect(line.rowCount).toBe(2);
    // The value passed to logQuery above must never reach the line.
    expect(log.mock.calls[0][0]).not.toContain("secret-row-id");
  });

  it("reports the most recent statement when a unit runs several", async () => {
    vi.stubEnv("POLYMATH_DB_QUERY_LOG", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await withQueryLog("notes.multi", async () => {
      dbQueryLogger.logQuery("SELECT * FROM a", []);
      dbQueryLogger.logQuery("SELECT * FROM b", [1, 2]);
      return null;
    });

    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(log.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(line.sql).toBe("SELECT * FROM b");
    expect(line.paramCount).toBe(2);
  });

  it("emits nothing for a unit that runs no statements", async () => {
    vi.stubEnv("POLYMATH_DB_QUERY_LOG", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await withQueryLog("notes.empty", async () => "no queries here");

    expect(log).not.toHaveBeenCalled();
  });

  it("records nothing outside any withQueryLog context", async () => {
    vi.stubEnv("POLYMATH_DB_QUERY_LOG", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    // Drizzle calls this hook on every statement; with no ambient context
    // there is nothing to attribute it to and no wrapper to emit the line.
    expect(() => dbQueryLogger.logQuery("SELECT 1", [])).not.toThrow();
    expect(log).not.toHaveBeenCalled();
  });

  it("is silent with the flag off even when a statement runs", async () => {
    vi.stubEnv("POLYMATH_DB_QUERY_LOG", "0");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await withQueryLog("notes.muted", async () => {
      dbQueryLogger.logQuery("SELECT * FROM notes", []);
      return [{ id: 1 }];
    });

    expect(log).not.toHaveBeenCalled();
  });

  it("emits the line for a failed unit and propagates the original error", async () => {
    vi.stubEnv("POLYMATH_DB_QUERY_LOG", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const failure = new Error("unit exploded");

    await expect(
      withQueryLog("notes.boom", async () => {
        dbQueryLogger.logQuery("DELETE FROM notes WHERE id = $1", [7]);
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(log.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(line.key).toBe("notes.boom");
    expect(line.sql).toBe("DELETE FROM notes WHERE id = $1");
    expect(line.rowCount).toBeUndefined(); // unobservable on a failed unit
  });

  it("truncates long SQL to keep the line canonical", async () => {
    vi.stubEnv("POLYMATH_DB_QUERY_LOG", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await withQueryLog("notes.long", async () => {
      dbQueryLogger.logQuery(`SELECT ${"x".repeat(1000)}`, []);
      return null;
    });

    const line = JSON.parse(log.mock.calls[0][0] as string) as { sql: string };
    expect(line.sql.startsWith("SELECT xxx")).toBe(true);
    expect(line.sql.length).toBe(501); // 500 chars + ellipsis
  });
});

describe("withQueryLog over withTransaction", () => {
  it("attributes transaction-scoped statements to the wrapping context", async () => {
    vi.stubEnv("POLYMATH_DB_QUERY_LOG", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { withTransaction } = await import("@/lib/db-transaction");

    const result = await withQueryLog("run.tx", () =>
      withTransaction(async (tx) => {
        return (tx as { execute: (q: unknown) => Promise<unknown> }).execute("unused");
      }),
    );

    // db.ts wired the shared query-log logger, and the transaction session
    // inherits it — statements on tx land in the ambient context.
    expect(mocks.logger).toBe(dbQueryLogger);
    expect(Array.isArray(result)).toBe(true);
    expect((result as { count: number }).count).toBe(1); // unit return passes through
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(log.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(line.key).toBe("run.tx");
    expect(line.sql).toBe("INSERT INTO zettels (body) VALUES ($1)");
    expect(line.paramCount).toBe(1);
    expect(line.rowCount).toBe(1); // postgres-js count from the tx statement
    expect(log.mock.calls[0][0]).not.toContain("tx-secret-value");
  });
});
