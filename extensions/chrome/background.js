/**
 * Alfred Chrome Extension — Service Worker (MV3)
 *
 * Handles side panel open requests from content scripts and keyboard shortcuts.
 */

var LEGACY_STORAGE_KEYS = [
  "alfredPendingEvents",
  "alfredVisitedUrls",
  "alfredPendingCaptures",
];

chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.remove(LEGACY_STORAGE_KEYS);
});

chrome.runtime.onStartup.addListener(function () {
  chrome.storage.local.remove(LEGACY_STORAGE_KEYS);
});

/*
 * Content scripts cannot reach Axiom directly: a page-origin fetch is subject
 * to that page's CORS, which no allowlist can cover. host_permissions exempts
 * the worker, so content scripts relay their captures here. Only the origins
 * listed in manifest.json are reachable — the URL is checked, not trusted.
 */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== "AXIOM_FETCH") return;

  var allowed = /^http:\/\/localhost:3000\//;
  if (typeof msg.url !== "string" || !allowed.test(msg.url)) {
    sendResponse({ ok: false, error: "Blocked: not an Axiom origin." });
    return true;
  }

  fetch(msg.url, {
    method: msg.method || "GET",
    headers: msg.headers || {},
    body: msg.body ?? null,
    signal: AbortSignal.timeout(msg.signalTimeoutMs || 15000),
  })
    .then(async function (resp) {
      var text = await resp.text();
      sendResponse({
        ok: true,
        status: resp.status,
        contentType: resp.headers.get("content-type") || "application/json",
        body: text,
      });
    })
    .catch(function (error) {
      sendResponse({ ok: false, error: error && error.message ? error.message : "Request failed." });
    });

  return true; // keep the channel open for the async response
});

chrome.runtime.onMessage.addListener(function (msg, sender) {
  if (!msg || msg.type !== "OPEN_SIDE_PANEL") return;

  if (sender && sender.tab && sender.tab.id) {
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(function () {});
  }
});

chrome.commands.onCommand.addListener(function (command) {
  if (command === "toggle-reading-mode") {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs && tabs[0]) {
        chrome.sidePanel.open({ tabId: tabs[0].id }).catch(function () {
          // Side panel may not be available
        });
      }
    });
  }
});
