/**
 * Capture outbox — pure state machine (no chrome.* APIs).
 *
 * The service worker (background.js) owns storage, network and alarms; this
 * module owns the decisions, so they can be unit-tested in Node:
 *
 *   - a capture is written to the outbox BEFORE any network attempt, so a
 *     deploy, a dead dev server or a closed laptop can never lose it;
 *   - every entry carries one idempotency key minted at enqueue time, which
 *     the server uses to make retries exactly-once (request_receipts);
 *   - responses classify into delivered / retry / failed / needs-auth;
 *   - retries back off exponentially (30s, doubling, 15m cap) and give up
 *     into "failed" after MAX_ATTEMPTS — the entry is kept for the user,
 *     never silently dropped.
 *
 * Loaded both as a plain script (service worker via importScripts) and as a
 * CommonJS module (vitest).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AxiomOutbox = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const STORAGE_KEY = "axiomCaptureOutbox";
  const SCHEMA_VERSION = 1;

  /** First retry delay; each attempt doubles it. */
  const BASE_RETRY_MS = 30 * 1000;
  /** Longest delay between retries. */
  const MAX_RETRY_MS = 15 * 60 * 1000;
  /** Attempts before an entry parks as failed and waits for the user. */
  const MAX_ATTEMPTS = 8;

  /**
   * chrome.storage.local is capped at ~10 MB for the whole extension. Keep a
   * safety margin so history, settings and the dock state always fit; when
   * the outbox would cross the budget the capture is refused loudly instead
   * of silently truncated.
   */
  const QUOTA_BUDGET_BYTES = 8 * 1024 * 1024;

  /** Milliseconds to wait before attempt number `attempts` (1-based). */
  function backoffMs(attempts) {
    const exp = Math.min(attempts - 1, 10);
    return Math.min(BASE_RETRY_MS * Math.pow(2, exp), MAX_RETRY_MS);
  }

  /**
   * What a delivery attempt means for the entry.
   * `response` is { ok, status } for a completed fetch, or null when the
   * network/server was unreachable (DNS, refused connection, timeout).
   */
  function classifyDelivery(response) {
    if (!response) return "retry";
    if (response.ok) return "delivered";
    // A URL-only capture dedupes on (workspace, url): 409 means the server
    // confirms it already holds this exact capture, so the copy here is safe
    // to drop. Page grabs carry text and never dedupe this way; a replayed
    // idempotency key answers 201 from request_receipts, not 409.
    if (response.status === 409) return "delivered";
    if (response.status === 401 || response.status === 403) return "needs-auth";
    if (response.status >= 400 && response.status < 500) return "failed";
    return "retry"; // 5xx and anything unexpected: the server may recover
  }

  function isDue(entry, now) {
    return entry.status === "queued" && (entry.nextAttemptAt || 0) <= now;
  }

  /** Fresh entry. The id doubles as the server idempotency key. */
  function makeEntry({ id, text, url, title, history }, now) {
    return {
      v: SCHEMA_VERSION,
      id,
      text,
      url: url || null,
      title: title || null,
      history: history || null,
      status: "queued", // queued | sending | failed | needs-auth
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
      lastError: null,
    };
  }

  /**
   * Fold one delivery attempt into the entry. `outcome` comes from
   * classifyDelivery; `error` is the human-readable reason for failures.
   * Returns a NEW entry (or null when delivered — the caller drops it).
   */
  function applyOutcome(entry, outcome, now, error) {
    if (outcome === "delivered") return null;
    const attempts = entry.attempts + 1;
    if (outcome === "retry" && attempts < MAX_ATTEMPTS) {
      return {
        ...entry,
        status: "queued",
        attempts,
        updatedAt: now,
        nextAttemptAt: now + backoffMs(attempts),
        lastError: error || null,
      };
    }
    // retry exhausted, permanent 4xx, or auth rejected: park for the user.
    return {
      ...entry,
      status: outcome === "retry" ? "failed" : outcome, // failed | needs-auth
      attempts,
      updatedAt: now,
      nextAttemptAt: 0,
      lastError: error || null,
    };
  }

  /**
   * Reset a parked entry so the user can retry it by hand. The attempt
   * budget restarts: a manual retry is a new delivery cycle, not one last
   * chance before the entry parks again.
   */
  function requeue(entry, now) {
    return {
      ...entry,
      status: "queued",
      attempts: 0,
      updatedAt: now,
      nextAttemptAt: now,
      lastError: null,
    };
  }

  /**
   * A worker crash can strand an entry in "sending"; queue it again.
   * Returns { entries, changed } so the caller persists only when needed.
   */
  function recoverInFlight(entries) {
    let changed = false;
    const recovered = entries.map((entry) => {
      if (entry.status !== "sending") return entry;
      changed = true;
      return { ...entry, status: "queued" };
    });
    return { entries: recovered, changed };
  }

  /** Approximate storage cost, the same JSON the extension persists. */
  function estimateBytes(entries) {
    return entries.reduce((sum, entry) => sum + JSON.stringify(entry).length + 1, 2);
  }

  function hasQuotaFor(entries, candidate) {
    return estimateBytes([...entries, candidate]) <= QUOTA_BUDGET_BYTES;
  }

  /** Earliest time the alarm should wake the worker, or null when idle. */
  function nextWakeAt(entries, now) {
    let wake = null;
    for (const entry of entries) {
      if (entry.status !== "queued") continue;
      const at = Math.max(entry.nextAttemptAt || 0, now);
      if (wake === null || at < wake) wake = at;
    }
    return wake;
  }

  return {
    STORAGE_KEY,
    SCHEMA_VERSION,
    BASE_RETRY_MS,
    MAX_RETRY_MS,
    MAX_ATTEMPTS,
    QUOTA_BUDGET_BYTES,
    backoffMs,
    classifyDelivery,
    isDue,
    makeEntry,
    applyOutcome,
    requeue,
    recoverInFlight,
    estimateBytes,
    hasQuotaFor,
    nextWakeAt,
  };
});
