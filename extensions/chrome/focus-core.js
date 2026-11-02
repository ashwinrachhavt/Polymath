/**
 * Focus blocker core — pure decision surface (no chrome.* APIs).
 *
 * The service worker (focus-blocker.js) owns storage, network and the
 * declarativeNetRequest calls; this module owns the decisions, so they can be
 * unit-tested in Node:
 *
 *   - blocklist patterns are hostnames (the blocklist table stores them
 *     lowercased); normalization tolerates a pasted URL or a leading "*."
 *     because the setup screen accepts free text;
 *   - rule conversion encodes the precedence the API documents — a matching
 *     allow wins over any matching block — as DNR priorities, since DNR
 *     evaluates by priority, not by array order;
 *   - the stale-poll fail-safe: if the poll keeps failing the dynamic rules
 *     must be cleared after 10 minutes, because an outage must never lock a
 *     user out of their own browser.
 *
 * Loaded both as a plain script (service worker via importScripts) and as a
 * CommonJS module (vitest).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AxiomFocus = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  /** chrome.alarms will not fire sooner than ~30s; the brief caps polling at 30s. */
  var POLL_ALARM = "axiom-focus-poll";
  var POLL_PERIOD_MINUTES = 0.5;

  /** Auto-clear dynamic rules after this long without a successful poll. */
  var STALE_AFTER_MS = 10 * 60 * 1000;

  /** chrome.storage.local key for the cached poll result. */
  var STORAGE_KEY = "axiomFocusState";

  /**
   * DNR picks the winner by priority, then by action. Allows sit above
   * blocks unconditionally: the API's documented precedence (allow entries
   * sort first; a matching allow wins) becomes numeric here.
   */
  var ALLOW_PRIORITY = 2;
  var BLOCK_PRIORITY = 1;

  /** Deterministic id bands we own inside the dynamic ruleset, for clean removal. */
  var ALLOW_RULE_ID_BASE = 1000000;
  var BLOCK_RULE_ID_BASE = 2000000;
  var RULE_ID_BAND_END = 3000000;

  /** Chrome grants at least 5000 dynamic rules; converting beyond this would fail. */
  var MAX_RULES = 5000;

  /** The redirect every block rule uses: the ghost interstitial page. */
  var BLOCK_REDIRECT_PATH = "/focus-block.html";

  /**
   * Normalize a blocklist pattern to a bare hostname, or null when it cannot
   * name a host. The table documents patterns as hostnames
   * ("news.ycombinator.com"); this tolerates the forms a person pastes —
   * a full URL, a leading "*.", a trailing dot — without inventing matching
   * semantics DNR does not have.
   */
  function normalizePattern(pattern) {
    if (typeof pattern !== "string") return null;
    var value = pattern.trim().toLowerCase();
    if (!value) return null;
    value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
    value = value.split("/")[0].split("?")[0].split("#")[0]; // path, query, fragment
    if (value.lastIndexOf("@") !== -1) value = value.slice(value.lastIndexOf("@") + 1); // userinfo
    value = value.replace(/:\d+$/, ""); // port
    if (value.indexOf("*.") === 0) value = value.slice(2); // requestDomains already covers subdomains
    while (value.indexOf(".") === 0) value = value.slice(1);
    while (value.lastIndexOf(".") === value.length - 1) value = value.slice(0, -1);
    if (value.length < 3 || value.length > 253) return null;
    if (!/^[a-z0-9.-]+$/.test(value)) return null;
    if (value.indexOf(".") === -1 && value !== "localhost") return null;
    // RFC 5891: no label may start or end with a hyphen — DNR would reject
    // such a domain at updateDynamicRules time, failing every poll.
    var labels = value.split(".");
    for (var l = 0; l < labels.length; l++) {
      var label = labels[l];
      if (label.charAt(0) === "-" || label.charAt(label.length - 1) === "-") return null;
    }
    return value;
  }

  /**
   * Convert blocklist entries into DNR dynamic rules. Returns the rules plus
   * what did not convert: `skipped` names the unusable patterns (invalid,
   * duplicate after normalization, or beyond the rule budget) so the UI can
   * surface them instead of failing silently.
   *
   * Allow rules are emitted before block rules and at a higher priority —
   * both encodings of "a matching allow wins over any matching block".
   */
  function toDnrRules(entries) {
    var list = Array.isArray(entries) ? entries : [];
    var skipped = [];
    var seen = {};
    var allows = [];
    var blocks = [];
    for (var i = 0; i < list.length; i++) {
      var entry = list[i] || {};
      var domain = normalizePattern(entry.pattern);
      if (!domain || seen[domain]) {
        skipped.push(typeof entry.pattern === "string" ? entry.pattern : String(entry.pattern));
        continue;
      }
      seen[domain] = true;
      if (entry.kind === "allow") allows.push(domain);
      else blocks.push(domain);
    }

    var rules = [];
    var truncated = false;
    var index;
    for (index = 0; index < allows.length; index++) {
      if (rules.length >= MAX_RULES) {
        truncated = true;
        break;
      }
      rules.push({
        id: ALLOW_RULE_ID_BASE + index,
        priority: ALLOW_PRIORITY,
        action: { type: "allow" },
        condition: { requestDomains: [allows[index]], resourceTypes: ["main_frame"] },
      });
    }
    var blockBudget = MAX_RULES - rules.length;
    for (index = 0; index < blocks.length; index++) {
      if (index >= blockBudget) {
        truncated = true;
        skipped.push(blocks[index]);
        continue;
      }
      rules.push({
        id: BLOCK_RULE_ID_BASE + index,
        priority: BLOCK_PRIORITY,
        action: { type: "redirect", redirect: { extensionPath: BLOCK_REDIRECT_PATH } },
        condition: { requestDomains: [blocks[index]], resourceTypes: ["main_frame"] },
      });
    }
    return { rules: rules, skipped: skipped, truncated: truncated };
  }

  /** True when the rule id belongs to this module's band. */
  function ownsRuleId(id) {
    return typeof id === "number" && id >= ALLOW_RULE_ID_BASE && id < RULE_ID_BAND_END;
  }

  /**
   * The stale-poll fail-safe. `state` is the cached last successful poll
   * ({ lastOkAt: <epoch ms> } or null). Rules exist only because some poll
   * once succeeded, so a state without a usable timestamp is treated as
   * overdue: clear. An outage past STALE_AFTER_MS must never keep a person
   * locked out of their own browser.
   */
  function failSafeDecision(state, now) {
    if (!state || typeof state !== "object") return "clear";
    var lastOkAt = state.lastOkAt;
    if (typeof lastOkAt !== "number" || !(lastOkAt > 0)) return "clear";
    return now - lastOkAt > STALE_AFTER_MS ? "clear" : "keep";
  }

  /** Whole minutes to show, rounded up so "1 minute" never reads as zero. */
  function remainingMinutes(remainingSeconds) {
    if (typeof remainingSeconds !== "number" || !(remainingSeconds > 0)) return null;
    return Math.max(1, Math.ceil(remainingSeconds / 60));
  }

  return {
    POLL_ALARM: POLL_ALARM,
    POLL_PERIOD_MINUTES: POLL_PERIOD_MINUTES,
    STALE_AFTER_MS: STALE_AFTER_MS,
    STORAGE_KEY: STORAGE_KEY,
    ALLOW_PRIORITY: ALLOW_PRIORITY,
    BLOCK_PRIORITY: BLOCK_PRIORITY,
    ALLOW_RULE_ID_BASE: ALLOW_RULE_ID_BASE,
    BLOCK_RULE_ID_BASE: BLOCK_RULE_ID_BASE,
    RULE_ID_BAND_END: RULE_ID_BAND_END,
    MAX_RULES: MAX_RULES,
    BLOCK_REDIRECT_PATH: BLOCK_REDIRECT_PATH,
    normalizePattern: normalizePattern,
    toDnrRules: toDnrRules,
    ownsRuleId: ownsRuleId,
    failSafeDecision: failSafeDecision,
    remainingMinutes: remainingMinutes,
  };
});
