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
 *   - every entry is bound to the destination it was captured for (server
 *     origin + a hash of the credential, never the credential itself). If the
 *     connected account or server changes before delivery, the entry parks
 *     instead of silently landing in a different account;
 *   - responses classify into delivered / retry / failed / needs-auth /
 *     conflicted / identity-mismatch;
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
   *
   * `response` is { ok, status, problemCode } for a completed fetch (problemCode
   * is the RFC 9457 `code` parsed from the problem+json body, when present), or
   * null when the network/server was unreachable (DNS, refused, timeout).
   *
   * 409 is only safe to treat as delivered when ALL of these hold — pinned to
   * the captures endpoint's own conflict semantics, so an arbitrary 409 from
   * a proxy or a different API version can never masquerade as a duplicate:
   *   - the queued capture is URL-only (no text): the server's
   *     captures_workspace_source_url_key unique index covers every capture
   *     with a URL, so a text-bearing capture that 409s had its content
   *     REJECTED — the server kept an earlier version and discarded this one.
   *     Dropping the local copy would lose the user's words.
   *   - the problem body is exactly this endpoint's duplicate-URL conflict:
   *     type https://axiom.dev/problems/conflict, code "conflict", and the
   *     endpoint's own duplicate title. For a URL-only body this endpoint
   *     raises no other conflict ("Nothing to capture." needs an empty body).
   * A URL-only duplicate is same-intent by construction, so only then is the
   * local copy safe to drop. Anything else parks as "conflicted" for the user.
   */
  const DUPLICATE_URL_TITLE = "That URL is already in the inbox.";
  function isEndpointDuplicate(response) {
    return (
      response.problemCode === "conflict" &&
      response.problemType === "https://axiom.dev/problems/conflict" &&
      response.problemTitle === DUPLICATE_URL_TITLE
    );
  }
  function classifyDelivery(response, entry) {
    if (!response) return "retry";
    if (response.ok) return "delivered";
    if (response.status === 409) {
      const urlOnly = Boolean(entry) && !entry.text;
      return urlOnly && isEndpointDuplicate(response) ? "delivered" : "conflicted";
    }
    if (response.status === 401 || response.status === 403) return "needs-auth";
    if (response.status >= 400 && response.status < 500) return "failed";
    return "retry"; // 5xx and anything unexpected: the server may recover
  }

  function isDue(entry, now) {
    return entry.status === "queued" && (entry.nextAttemptAt || 0) <= now;
  }

  /**
   * The destination this capture must land in: the server origin and a hash
   * of the credential, captured at enqueue time. The hash proves only that
   * the credential is unchanged — it is not an account identity (Polymath
   * exposes no whoami endpoint), so a mismatch always parks for the user
   * rather than guessing. Never render or log the hash.
   */
  function destinationsMatch(a, b) {
    return Boolean(a && b) && a.origin === b.origin && a.tokenHash === b.tokenHash;
  }

  /** Fresh entry. The id doubles as the server idempotency key. */
  function makeEntry(fields, now) {
    return {
      v: SCHEMA_VERSION,
      id: fields.id,
      text: fields.text,
      url: fields.url || null,
      title: fields.title || null,
      // How the content arrived ("page" | "selection" | ...), so the server
      // does not have to infer it. Defaults to null because this module
      // persists to storage: an entry queued by a build that predates this
      // field must still load and deliver, not fail on a missing key.
      mode: fields.mode || null,
      history: fields.history || null,
      destination: fields.destination || null,
      status: "queued", // queued | sending | failed | needs-auth | conflicted | parked-identity
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
      lastError: null,
    };
  }

  /**
   * The POST body for one entry. Optional fields are omitted when empty rather
   * than sent as null, and `mode` is omitted rather than sent as null: an entry
   * queued before mode existed posts exactly the body it always posted, and the
   * server infers the mode from what it receives.
   */
  function deliveryBody(entry) {
    const body = { text: entry.text };
    if (entry.url) body.url = entry.url;
    if (entry.title) body.title = entry.title;
    if (entry.mode) body.mode = entry.mode;
    return body;
  }

  /**
   * Fold one delivery attempt into the entry. `outcome` comes from
   * classifyDelivery (or "identity-mismatch" when the destination changed
   * before the request was even sent); `error` is the human-readable reason
   * for failures. Returns a NEW entry (or null when delivered — the caller
   * drops it).
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
    // retry exhausted, permanent 4xx, auth rejected, server conflict, or a
    // destination change: park for the user, each with its own recovery path.
    const status =
      outcome === "retry" ? "failed"
      : outcome === "identity-mismatch" ? "parked-identity"
      : outcome; // failed | needs-auth | conflicted
    return {
      ...entry,
      status,
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
   * The explicit recovery for a parked-identity entry: the user confirms the
   * queued content should go to the NEWLY CONNECTED destination, so the entry
   * is re-stamped with it and queued again. This is never automatic — a
   * changed credential hash is not proof of a same-account key rotation.
   */
  function rebind(entry, destination, now) {
    return {
      ...requeue(entry, now),
      destination,
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
    destinationsMatch,
    makeEntry,
    deliveryBody,
    applyOutcome,
    requeue,
    rebind,
    recoverInFlight,
    estimateBytes,
    hasQuotaFor,
    nextWakeAt,
  };
});
