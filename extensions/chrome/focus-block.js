/**
 * Ghost interstitial — behavior.
 *
 * The poller (focus-blocker.js) caches the last successful poll in
 * chrome.storage.local under AxiomFocus.STORAGE_KEY; this page renders it and
 * re-reads on every change plus a 30s tick, so minutes count down without a
 * reload. There is deliberately no bypass control here: the session is ended
 * or paused from Focus Mode, and the poller lifts the rules within ~30s of
 * that. In the deep tier nothing can lift the block but the plan running out.
 */
(function () {
  "use strict";
  var Core = self.AxiomFocus;
  var DEFAULT_BASE = "http://localhost:3000";

  var els = {
    subject: document.getElementById("focus-subject"),
    remaining: document.getElementById("focus-remaining"),
    explain: document.getElementById("focus-explain"),
    link: document.getElementById("focus-link"),
    status: document.getElementById("focus-status"),
  };

  async function readBase() {
    try {
      var stored = (await chrome.storage.local.get("alfredBaseUrl")).alfredBaseUrl;
      return typeof stored === "string" && stored ? stored.replace(/\/+$/, "") : DEFAULT_BASE;
    } catch {
      return DEFAULT_BASE;
    }
  }

  function render(state, base) {
    var session = state && state.session ? state.session : null;
    if (!session || session.state !== "running") {
      // A redirect landed here but the cache says nothing is running: the
      // session probably just ended. Say so instead of showing stale data.
      els.subject.hidden = true;
      els.remaining.hidden = true;
      // The poller's 403 marker: the paired key cannot read focus state, so
      // blocking can never engage and this page is the only place that can
      // say why. Checked before the outage copy, which would misdiagnose it.
      if (state && state.forbidden) {
        els.explain.textContent =
          "This device's companion key cannot read Focus Mode (the server refused it), so no sites can be blocked. " +
          "Re-pair the extension: open the Polymath side panel and save a key that includes the \"Read focus sessions and blocklist\" scope.";
        els.link.href = base + "/neuralflow/focus";
        els.link.hidden = false;
        els.status.textContent = "Waiting for the next check…";
        return;
      }
      els.explain.textContent =
        "Focus Mode held this page, and this device has not heard from your Polymath server since. " +
        "It re-checks every 30 seconds — if a session is running, this page will say so; otherwise the site will load normally on your next visit.";
      els.link.href = base + "/neuralflow/focus";
      els.link.hidden = false;
      els.status.textContent = "Waiting for the next check…";
      return;
    }

    els.subject.textContent = "You're focusing on \u201C" + session.title + "\u201D.";
    els.subject.hidden = false;

    var minutes = Core.remainingMinutes(session.remainingSeconds);
    if (minutes !== null) {
      els.remaining.textContent = minutes === 1 ? "1 minute left" : minutes + " minutes left";
      els.remaining.hidden = false;
    } else {
      els.remaining.hidden = true;
    }

    if (session.strictness === "deep") {
      els.explain.textContent =
        "This is a deep-focus session: it holds until the planned time runs out. " +
        "There is no bypass on this tier — not in the extension, not on the page.";
    } else {
      els.explain.textContent =
        "This site is on your focus blocklist while the session runs. " +
        "Pause or end the session from Focus Mode and the block lifts within about 30 seconds.";
    }

    els.link.href = base + "/neuralflow/focus";
    els.link.hidden = false;

    if (state.enforcing === false) {
      els.status.textContent = "Waiting for the next check…";
    } else {
      var age = typeof state.lastOkAt === "number" ? Math.max(0, Math.round((Date.now() - state.lastOkAt) / 1000)) : null;
      els.status.textContent = age === null ? "Synced with your workspace." : "Synced with your workspace \u00B7 checked " + age + "s ago";
    }
  }

  async function refresh() {
    var state = null;
    try {
      state = (await chrome.storage.local.get(Core.STORAGE_KEY))[Core.STORAGE_KEY] || null;
    } catch {
      state = null;
    }
    render(state, await readBase());
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === "local" && changes[Core.STORAGE_KEY]) refresh();
  });

  refresh();
  // The poller refreshes storage every 30s; this tick keeps the "checked Ns
  // ago" line honest between polls and counts a plan down when the poller
  // itself is quiet.
  setInterval(refresh, 30000);
})();
