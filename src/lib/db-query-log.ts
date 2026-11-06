import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "drizzle-orm";

/*
 * Canonical Drizzle query logging (the Numeric pattern): a query log line has
 * to carry post-execution facts — duration, row count — and drizzle's logger
 * hook fires pre-execution only (`logQuery(query, params)` immediately before
 * the driver call), so those facts cannot come from the hook itself. Instead
 * the hook records what it sees into an AsyncLocalStorage context, and
 * `withQueryLog` — which wraps a logical unit of work — completes the line
 * when the unit finishes.
 *
 * One line per `withQueryLog` unit, not per statement: when a unit runs
 * several statements the line reports the most recent one's SQL and argument
 * count against the whole unit's duration. Statements inside `withTransaction`
 * inherit the ambient context through the awaited drizzle chain, so they
 * attribute to the wrapping unit with no extra wiring.
 *
 * Redaction is structural: drizzle hands the logger the placeholder-form query
 * ($1, $2, …) with the real values only in the params array, and the line
 * records `params.length` — never an argument value.
 *
 * The three raw `postgres()` clients (superagent wiring, cron, outbox) bypass
 * drizzle and are invisible to this logger — a known coverage gap, out of
 * scope for this module. Drizzle's own `drizzle.driver.execute` OTel spans
 * stay untouched; the line complements tracing, it does not duplicate it.
 *
 * Flag semantics for POLYMATH_DB_QUERY_LOG: an explicit value always wins
 * ("1"/"true" on, "0"/"false" off); unset, the log is on in development and
 * off in production. With the flag off — or outside any `withQueryLog` —
 * this module behaves exactly like drizzle's NoopLogger: no output, and the
 * only overhead is one ALS store lookup per statement.
 */

interface QueryLogContext {
  key: string;
  startedAt: number;
  /** Most recent statement seen, already in placeholder form (values never enter). */
  sql?: string;
  paramCount?: number;
}

const store = new AsyncLocalStorage<QueryLogContext>();

/** Longest SQL snippet the canonical line carries before truncation. */
const MAX_SQL_LENGTH = 500;

export function isQueryLogEnabled(): boolean {
  const flag = process.env.POLYMATH_DB_QUERY_LOG;
  if (flag !== undefined && flag !== "") return flag === "1" || flag === "true";
  return process.env.NODE_ENV === "development";
}

/**
 * The Logger instance wired into the drizzle client. Drizzle calls it once per
 * statement, immediately before execution, inside the ambient async context —
 * recording here is what lets the wrapping `withQueryLog` complete the line.
 */
export const dbQueryLogger: Logger = {
  logQuery(query: string, params: unknown[]): void {
    const ctx = store.getStore();
    if (!ctx || !isQueryLogEnabled()) return;
    ctx.sql = query;
    ctx.paramCount = params.length;
  },
};

/** Collapses whitespace so the canonical line stays one line; truncates. */
function sanitizeSql(query: string): string {
  const flat = query.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SQL_LENGTH ? `${flat.slice(0, MAX_SQL_LENGTH)}…` : flat;
}

/*
 * Row count only where the wrapper can observe it: postgres-js attaches
 * `count` (affected rows) to its result arrays, selects surface as mapped
 * arrays, and some drivers return objects with a numeric `rowCount`. Anything
 * else omits the field — no result-materializing hacks.
 */
function rowCountOf(result: unknown): number | undefined {
  if (Array.isArray(result)) {
    const count = (result as { count?: unknown }).count;
    return typeof count === "number" ? count : result.length;
  }
  if (result && typeof result === "object") {
    const rowCount = (result as { rowCount?: unknown }).rowCount;
    if (typeof rowCount === "number") return rowCount;
  }
  return undefined;
}

function emit(ctx: QueryLogContext, result?: unknown): void {
  if (ctx.sql === undefined) return; // unit ran no statements — nothing to log
  const line: Record<string, unknown> = {
    msg: "db_query",
    key: ctx.key,
    durationMs: Math.round((performance.now() - ctx.startedAt) * 10) / 10,
    sql: sanitizeSql(ctx.sql),
    paramCount: ctx.paramCount,
  };
  const rowCount = rowCountOf(result);
  if (rowCount !== undefined) line.rowCount = rowCount;
  console.log(JSON.stringify(line));
}

/**
 * Runs `fn` inside a query-log context and, when the flag is on, emits one
 * canonical line when it finishes. The unit's semantics never change —
 * including its rejection: a failed unit still emits the line for the
 * statements it did run (row count is unobservable then), and the original
 * error propagates.
 */
export async function withQueryLog<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const ctx: QueryLogContext = { key, startedAt: performance.now() };
  try {
    const result = await store.run(ctx, fn);
    if (isQueryLogEnabled()) emit(ctx, result);
    return result;
  } catch (err) {
    if (isQueryLogEnabled()) emit(ctx);
    throw err;
  }
}
