/**
 * Focus blocker — service-worker module.
 *
 * Owns the poll-and-enforce loop; the decisions live in focus-core.js (pure,
 * unit-tested). Every chrome.alarms tick (30s floor):
 *
 *   1. Read the paired axm_ machine key and the configured server.
 *   2. GET /api/v1/focus/live and /api/v1/focus/blocklist under focus:read.
 *   3. On success, cache both in chrome.storage.local and shape the dynamic
 *      ruleset: a live RUNNING session installs the blocklist (block rules
 *      redirect to the ghost interstitial); paused, absent, or ended sessions
 *      clear the rules.
 *   4. On failure, keep the last-known rules — unless the failure streak has
 *      run past the stale window, when the fail-safe clears everything. A
 *      dead server must never lock a user out of their own browser.
 */
(function (root) {
  "use strict";
  var Core = root.AxiomFocus;
  var POLL_TIMEOUT_MS = 15000;

  async function readState() {
    var result = await chrome.storage.local.get(Core.STORAGE_KEY);
    var state = result[Core.STORAGE_KEY];
    return state && typeof state === "object" ? state : null;
  }

  async function writeState(state) {
    if (state) await chrome.storage.local.set({ [Core.STORAGE_KEY]: state });
    else await chrome.storage.local.remove(Core.STORAGE_KEY);
  }

  /** Ids of the dynamic rules this module owns (other rules are left alone). */
  async function ownedRuleIds() {
    var existing = await chrome.declarativeNetRequest.getDynamicRules();
    return existing.rules
      .map(function (rule) {
        return rule.id;
      })
      .filter(Core.ownsRuleId);
  }

  /** Replace the owned slice of the dynamic ruleset. Empty rules = clear. */
  async function applyRules(rules) {
    var removeRuleIds = await ownedRuleIds();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removeRuleIds,
      addRules: rules,
    });
  }

  async function fetchJson(url, token) {
    var response = await fetch(url, {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(url.split("?")[0] + " answered " + response.status);
    return response.json();
  }

  /**
   * One poll cycle. Both endpoints must answer for the cache to advance —
   * rebuilding rules from half the data could block the wrong sites.
   */
  async function pollAndEnforce() {
    var token = await AlfredAPI.token();
    if (!token) {
      // Unpaired: nothing is enforced and nothing is cached — the blocker
      // never acts on a server it cannot authenticate to.
      await applyRules([]);
      await writeState(null);
      return { ok: true, enforcing: false, reason: "unpaired" };
    }
    var base = await AlfredAPI.base();
    try {
      var results = await Promise.all([
        fetchJson(base + "/api/v1/focus/live", token),
        fetchJson(base + "/api/v1/focus/blocklist", token),
      ]);
      var session = results[0] && results[0].session ? results[0].session : null;
      var entries = results[1] && Array.isArray(results[1].entries) ? results[1].entries : [];
      var conversion = Core.toDnrRules(entries);
      var enforcing = Boolean(session && session.state === "running") && conversion.rules.length > 0;
      if (enforcing) await applyRules(conversion.rules);
      else await applyRules([]);
      var state = {
        session: session,
        enforcing: enforcing,
        ruleCount: conversion.rules.length,
        skipped: conversion.skipped,
        truncated: conversion.truncated,
        lastOkAt: Date.now(),
      };
      await writeState(state);
      return { ok: true, enforcing: enforcing, ruleCount: conversion.rules.length };
    } catch (error) {
      // Keep the last-known rules while the streak is young (the blocklist
      // changing server-side can wait); past the stale window, clear — an
      // outage must never lock a user out.
      var cached = await readState();
      if (Core.failSafeDecision(cached, Date.now()) === "clear") {
        await applyRules([]);
        await writeState(null);
        return { ok: false, error: String((error && error.message) || error), failSafe: "cleared" };
      }
      return { ok: false, error: String((error && error.message) || error), failSafe: "kept" };
    }
  }

  /** Serialized: an alarm tick and a storage-triggered poll must not interleave. */
  var polling = false;
  var pollAgain = false;
  async function pollSerialized() {
    if (polling) {
      pollAgain = true;
      return { ok: true, deferred: true };
    }
    polling = true;
    try {
      do {
        pollAgain = false;
        var result = await pollAndEnforce();
      } while (pollAgain);
      return result;
    } finally {
      polling = false;
    }
  }

  /** Ensure the periodic alarm exists (idempotent; same name replaces). */
  function ensureAlarm() {
    chrome.alarms.create(Core.POLL_ALARM, { periodInMinutes: Core.POLL_PERIOD_MINUTES });
  }

  root.AxiomFocusBlocker = {
    pollAndEnforce: pollSerialized,
    ensureAlarm: ensureAlarm,
    clearFocusRules: function () {
      return applyRules([]);
    },
  };
})(typeof self !== "undefined" ? self : globalThis);
