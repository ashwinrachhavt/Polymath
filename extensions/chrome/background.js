/**
 * Polymath Capture — Service Worker (MV3)
 *
 * Owns three jobs:
 *
 *   1. The capture outbox. Every capture is persisted here BEFORE any network
 *      attempt, then delivered with retries and exponential backoff. A deploy,
 *      a stopped dev server, or a closed laptop delays a capture instead of
 *      losing it. State lives in chrome.storage.local, which survives worker
 *      restarts and browser reboots; chrome.alarms wakes the worker for each
 *      scheduled retry.
 *   2. The AXIOM_FETCH relay. Content scripts cannot reach Polymath directly:
 *      a page-origin fetch is subject to that page's CORS, which no allowlist
 *      can cover. host_permissions exempts the worker, so content scripts
 *      relay their requests here. Only the origins listed in manifest.json
 *      are reachable — the URL is checked, not trusted.
 *   3. Side panel and keyboard commands.
 */

importScripts("outbox-core.js", "api.js");

var Outbox = self.AxiomOutbox;
var ALARM_NAME = "axiom-capture-outbox-pump";
/** chrome.alarms will not fire sooner than ~30s; never schedule tighter. */
var MIN_ALARM_MS = 30 * 1000;
var DELIVERY_TIMEOUT_MS = 20000;

var LEGACY_STORAGE_KEYS = [
  "alfredPendingEvents",
  "alfredVisitedUrls",
  "alfredPendingCaptures",
];

// ── Storage helpers ──────────────────────────────────────────────────

async function readOutbox() {
  const result = await chrome.storage.local.get(Outbox.STORAGE_KEY);
  const entries = result[Outbox.STORAGE_KEY];
  return Array.isArray(entries) ? entries : [];
}

async function writeOutbox(entries) {
  await chrome.storage.local.set({ [Outbox.STORAGE_KEY]: entries });
}

// ── Delivery ─────────────────────────────────────────────────────────

/**
 * One POST of one entry. Returns { ok, status, errorText } for a completed
 * request, or null when the network/server was unreachable — the distinction
 * Outbox.classifyDelivery needs.
 */
async function deliver(entry) {
  const base = await AlfredAPI.base();
  const token = await AlfredAPI.token();
  const headers = {
    "Content-Type": "application/json",
    // Minted once at enqueue; the server's request_receipts make every retry
    // of this key exactly-once.
    "Idempotency-Key": entry.id,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const resp = await fetch(`${base}/api/v1/captures`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: entry.text,
        ...(entry.url ? { url: entry.url } : {}),
        ...(entry.title ? { title: entry.title } : {}),
      }),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    const errorText = resp.ok ? null : (await resp.text().catch(() => "")).slice(0, 200);
    return { ok: resp.ok, status: resp.status, errorText };
  } catch {
    return null;
  }
}

// ── The pump ─────────────────────────────────────────────────────────

var pumping = false;
var pumpAgain = false;

/**
 * Two tabs can enqueue in the same instant, and the pump re-reads and
 * re-writes the outbox around every network await. chrome.storage.local has
 * no transactions, so every read-modify-write of the outbox goes through
 * this chain; a concurrent writer appends instead of interleaving and
 * losing an entry.
 */
var writeChain = Promise.resolve();
function withOutboxLock(fn) {
  var run = writeChain.then(fn, fn);
  writeChain = run.then(function () {}, function () {});
  return run;
}

/**
 * Deliver every due entry, then schedule the next wake. Re-entrant calls
 * during a pump set pumpAgain instead of running concurrently.
 */
async function pump() {
  if (pumping) {
    pumpAgain = true;
    return;
  }
  pumping = true;
  try {
    do {
      pumpAgain = false;
      var recovered = Outbox.recoverInFlight(await readOutbox());
      var entries = recovered.entries;
      if (recovered.changed) await writeOutbox(entries);
      while (true) {
        var entry = entries.find(function (candidate) { return Outbox.isDue(candidate, Date.now()); });
        if (!entry) break;
        entries = entries.map(function (candidate) {
          return candidate.id === entry.id ? { ...candidate, status: "sending" } : candidate;
        });
        await writeOutbox(entries);
        var response = await deliver(entry);
        var outcome = Outbox.classifyDelivery(response);
        var error = response && response.errorText ? response.errorText
          : response ? `Polymath answered ${response.status}.`
          : "Polymath is unreachable.";
        var folded = Outbox.applyOutcome(entry, outcome, Date.now(), error);
        // Re-read: the UI may have retried or discarded while we awaited.
        entries = await readOutbox();
        var idx = entries.findIndex(function (candidate) { return candidate.id === entry.id; });
        if (outcome === "delivered") {
          if (idx !== -1) entries.splice(idx, 1);
          await markHistory(entry.id, { delivery: "synced" });
        } else if (idx !== -1) {
          entries[idx] = folded;
          await markHistory(entry.id, {
            delivery: folded.status === "queued" ? "pending" : folded.status,
          });
        }
        await writeOutbox(entries);
      }
      await scheduleAlarm(entries);
    } while (pumpAgain);
  } finally {
    pumping = false;
  }
}

async function scheduleAlarm(entries) {
  await chrome.alarms.clear(ALARM_NAME);
  var wake = Outbox.nextWakeAt(entries, Date.now());
  if (wake === null) return;
  var delayMs = Math.max(wake - Date.now(), MIN_ALARM_MS);
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: delayMs / 60000 });
}

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm && alarm.name === ALARM_NAME) pump();
});

// ── History ──────────────────────────────────────────────────────────

async function markHistory(outboxId, patch) {
  try {
    await AlfredAPI.updateCaptureHistoryByOutboxId(outboxId, patch);
  } catch {
    // History is a convenience view; the outbox is the record.
  }
}

async function recordHistoryPending(entry) {
  if (!entry.history) return;
  try {
    await AlfredAPI.addCaptureHistory({
      ...entry.history,
      delivery: "pending",
      outboxId: entry.id,
    });
  } catch {}
}

// ── Message handlers ─────────────────────────────────────────────────

/** Capture text may not be empty; a URL alone is a valid capture. */
function validPayload(msg) {
  return Boolean((msg.text || "").trim() || (msg.url || "").trim());
}

async function enqueueCapture(msg) {
  if (!validPayload(msg)) {
    return { ok: false, error: "Nothing to save — send text, a URL, or both." };
  }
  var entry = Outbox.makeEntry(
    {
      id: crypto.randomUUID(),
      text: (msg.text || "").trim(),
      url: (msg.url || "").trim(),
      title: (msg.title || "").trim(),
      history: msg.history || null,
    },
    Date.now(),
  );
  var locked = await withOutboxLock(async function () {
    var entries = await readOutbox();
    if (!Outbox.hasQuotaFor(entries, entry)) return { full: true };
    entries.push(entry);
    await writeOutbox(entries);
    return { full: false };
  });
  if (locked.full) {
    return {
      ok: false,
      error:
        "This device is out of capture storage. Open the Dashboard, let the pending captures sync, then try again.",
    };
  }
  await recordHistoryPending(entry);
  // Try to deliver immediately so a healthy backend still feels instant.
  await pump();
  var after = await readOutbox();
  var still = after.find(function (candidate) { return candidate.id === entry.id; });
  return { ok: true, id: entry.id, delivered: !still };
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "AXIOM_ENQUEUE_CAPTURE") {
    enqueueCapture(msg).then(sendResponse, function (error) {
      sendResponse({ ok: false, error: String((error && error.message) || error) });
    });
    return true;
  }

  if (msg.type === "AXIOM_OUTBOX_STATUS") {
    readOutbox().then(function (entries) {
      sendResponse({
        ok: true,
        pending: entries.filter(function (e) { return e.status === "queued" || e.status === "sending"; }).length,
        failed: entries.filter(function (e) { return e.status === "failed"; }).length,
        needsAuth: entries.filter(function (e) { return e.status === "needs-auth"; }).length,
        bytes: Outbox.estimateBytes(entries),
        budgetBytes: Outbox.QUOTA_BUDGET_BYTES,
      });
    });
    return true;
  }

  if (msg.type === "AXIOM_OUTBOX_LIST") {
    readOutbox().then(function (entries) {
      sendResponse({
        ok: true,
        entries: entries.map(function (e) {
          return {
            id: e.id,
            title: e.title || (e.history && e.history.title) || e.url || "Note",
            url: e.url,
            status: e.status,
            attempts: e.attempts,
            createdAt: e.createdAt,
            nextAttemptAt: e.nextAttemptAt,
            lastError: e.lastError,
            preview: (e.text || "").slice(0, 140),
          };
        }),
      });
    });
    return true;
  }

  if (msg.type === "AXIOM_OUTBOX_RETRY") {
    (async function () {
      var entries = await readOutbox();
      var now = Date.now();
      entries = entries.map(function (entry) {
        var parked = entry.status === "failed" || entry.status === "needs-auth";
        var mine = !msg.id || entry.id === msg.id;
        return parked && mine ? Outbox.requeue(entry, now) : entry;
      });
      await writeOutbox(entries);
      await pump();
      sendResponse({ ok: true });
    })().catch(function (error) {
      sendResponse({ ok: false, error: String((error && error.message) || error) });
    });
    return true;
  }

  if (msg.type === "AXIOM_OUTBOX_DISCARD") {
    (async function () {
      var entries = await readOutbox();
      var kept = entries.filter(function (entry) { return entry.id !== msg.id; });
      await writeOutbox(kept);
      await markHistory(msg.id, { delivery: "discarded" });
      sendResponse({ ok: true });
    })().catch(function (error) {
      sendResponse({ ok: false, error: String((error && error.message) || error) });
    });
    return true;
  }

  if (msg.type === "AXIOM_FETCH") {
    if (typeof msg.url !== "string") {
      sendResponse({ ok: false, error: "Blocked: not a Polymath origin." });
      return true;
    }

    (async function () {
      // Only the configured Polymath origin is reachable; the URL is checked,
      // not trusted, and the manifest's host_permissions bound it further.
      var base = await AlfredAPI.base();
      if (!msg.url.startsWith(base + "/")) {
        sendResponse({ ok: false, error: "Blocked: not the configured Polymath origin." });
        return;
      }
      try {
        var resp = await fetch(msg.url, {
          method: msg.method || "GET",
          headers: msg.headers || {},
          body: msg.body ?? null,
          signal: AbortSignal.timeout(msg.signalTimeoutMs || 15000),
        });
        var text = await resp.text();
        sendResponse({
          ok: true,
          status: resp.status,
          contentType: resp.headers.get("content-type") || "application/json",
          body: text,
        });
      } catch (error) {
        var raw = error && error.message ? error.message : "Request failed.";
        sendResponse({
          ok: false,
          error: "Could not reach the configured Polymath server. (" + raw + ")",
        });
      }
    })();

    return true; // keep the channel open for the async response
  }
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

// ── Lifecycle ────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.remove(LEGACY_STORAGE_KEYS);
  pump(); // recover anything queued before an update or crash
});

chrome.runtime.onStartup.addListener(function () {
  chrome.storage.local.remove(LEGACY_STORAGE_KEYS);
  pump();
});
