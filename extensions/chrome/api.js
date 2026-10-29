/**
 * Alfred API client for Chrome extension.
 * Wraps all Alfred backend calls with error handling and base URL management.
 */
/**
 * True when running inside a page. Extension pages (popup, dashboard, side
 * panel) live on chrome-extension://; content scripts run on the page's own
 * origin. chrome.extension is not a reliable signal in MV3.
 */
function isContentScript() {
  return (
    typeof chrome !== "undefined" &&
    Boolean(chrome.runtime && chrome.runtime.id) &&
    typeof location !== "undefined" &&
    !location.protocol.startsWith("chrome-extension")
  );
}

/** Ask the service worker to perform the request; reply as a Response. */
async function relayThroughWorker(url, options) {
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({
      type: "AXIOM_FETCH",
      url,
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body ?? null,
      signalTimeoutMs: 15000,
    });
  } catch {
    // "Extension context invalidated" — the extension was reloaded or updated
    // and this tab still runs the old content script. Chrome fixes it on the
    // next page load.
    throw new Error("The extension was just reloaded. Refresh this page and try again.");
  }
  if (!reply || reply.ok !== true) {
    throw new Error(reply && reply.error ? `Polymath API: ${reply.error}` : "Polymath API: the companion worker did not answer.");
  }
  return new Response(reply.body, {
    status: reply.status,
    headers: { "content-type": reply.contentType || "application/json" },
  });
}

/**
 * How long to wait for the worker to confirm it wrote the capture. Generous
 * compared with a normal reply (microseconds on a healthy worker) because the
 * worker also attempts one immediate delivery, bounded by its own 20s
 * DELIVERY_TIMEOUT_MS. Past this the capture is unknown, not failed.
 */
const ENQUEUE_REPLY_DEADLINE_MS = 30000;

const AlfredAPI = {
  _baseUrl: null,
  _defaultUrl: "http://localhost:3000",
  /** Resolve the API base URL from storage or fall back to default. */
  async base() {
    if (this._baseUrl) return this._baseUrl;
    let stored;
    try {
      // One-time migration: clear stale localhost:8080 URL from when that was the default.
      // SearXNG runs on 8080 and its /healthz returns 200, tricking the old health check.
      const migrated = await this._getStorage("alfredUrlMigrated_v2");
      if (!migrated) {
        const old = await this._getStorage("alfredBaseUrl");
        if (old && old.includes(":8080")) {
          await this._setStorage("alfredBaseUrl", null);
        }
        await this._setStorage("alfredUrlMigrated_v2", true);
      }
      stored = await this._getStorage("alfredBaseUrl");
    } catch {
      // Storage unreadable reads as first run: nothing was configured.
      stored = undefined;
    }
    // A stored URL is a promise the person made to this companion. When it no
    // longer answers as Polymath, say so instead of quietly saving elsewhere.
    if (stored && stored !== this._defaultUrl) {
      let reachable = false;
      try {
        // Verify the stored URL is actually Polymath (not another service on
        // that port) by checking /api/v1/captures, which only Polymath serves.
        // The endpoint requires auth, so the probe carries the saved key;
        // without it every valid server answers 401 and the URL never sticks.
        const probeHeaders = { "Content-Type": "application/json" };
        const probeToken = await this.token();
        if (probeToken) probeHeaders.Authorization = `Bearer ${probeToken}`;
        const resp = await fetch(`${stored}/api/v1/captures`, {
          signal: AbortSignal.timeout(1500),
          headers: probeHeaders,
        });
        reachable = resp.ok;
      } catch {
        reachable = false;
      }
      if (!reachable) throw new Error("The configured server is unreachable.");
      this._baseUrl = stored;
      return this._baseUrl;
    }
    this._baseUrl = this._defaultUrl;
    return this._baseUrl;
  },

  /** Update the stored base URL and clear cache. */
  async setBase(url) {
    const clean = url.replace(/\/+$/, "");
    try {
      await this._setStorage("alfredBaseUrl", clean);
    } catch {}
    this._baseUrl = clean;
  },

  /** The paired bearer token, or null when the companion has not been paired. */
  async token() {
    return (await this._getStorage("axiomToken")) || null;
  },

  /** Store the API key minted in Polymath → Settings → Account and machine clients. */
  async setToken(value) {
    const clean = (value || "").trim();
    await this._setStorage("axiomToken", clean || null);
  },

  /**
   * First-run pairing: an empty token picks up the owner's companion key so
   * the extension works before anyone opens Settings. Replace the constant
   * when re-pairing; a stored value always wins, so the field stays editable.
   */
  async ensureTokenPreloaded() {
    const CONFIGURED_TOKEN = "axm_0PV9s4CkRn_c.7O5TVMU3HAbPQwRxswZL3wKlsbnx4zMl5Aa5X5ST7O0";
    try {
      const stored = await this._getStorage("axiomToken");
      if (!stored) await this.setToken(CONFIGURED_TOKEN);
    } catch {
      // Storage unavailable: nothing to preload.
    }
  },

  /** Generic fetch wrapper with JSON parsing and error handling. */
  async _fetch(path, options = {}) {
    const base = await this.base();
    const url = `${base}${path}`;
    const defaults = {
      headers: { "Content-Type": "application/json" },
    };
    const merged = { ...defaults, ...options };
    if (options.headers) {
      merged.headers = { ...defaults.headers, ...options.headers };
    }
    const bearer = await this.token();
    if (bearer) merged.headers = { ...merged.headers, Authorization: `Bearer ${bearer}` };
    // A content script fetches with the *page's* origin, which no server-side
    // allowlist can enumerate. The service worker holds host_permissions for
    // Polymath and is exempt from page CORS, so content-script calls hop there.
    const resp = isContentScript() ? await relayThroughWorker(url, merged) : await fetch(url, merged);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      if (resp.status === 401 && bearer) {
        throw new Error(
          "Polymath rejected this API key (401). Mint a fresh one in Polymath → Settings → Account and machine clients, paste it into the extension settings, or clear the token field to save without one.",
        );
      }
      throw new Error(`Polymath API ${resp.status}: ${text}`);
    }
    const ct = resp.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      return resp.json();
    }
    return resp.text();
  },

  // ── Capture helpers ────────────────────────────────────────────────

  /**
   * One capture into the Polymath inbox. `mode` states how it arrived
   * ("authored" | "selection" | "page" | "url-reference"); omitted, the server
   * infers it. Server-side dedupe answers 409 for a repeated URL-only capture.
   */
  async createCapture({ text, url, title, mode, idempotencyKey }) {
    return this._fetch("/api/v1/captures", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey || crypto.randomUUID() },
      body: JSON.stringify({ text, url, title, mode }),
    });
  },

  /** The inbox queue. filter is unprocessed | converted | discarded | all. */
  async listCaptures(filter) {
    const query = filter ? `?filter=${encodeURIComponent(filter)}` : "";
    return this._fetch(`/api/v1/captures${query}`);
  },

  /** Ingest a captured page (or a short excerpt) into the inbox. */
  async capturePage({ url, title, content, history }) {
    const text = (content || "").trim();
    return this.queueCapture({
      mode: "page",
      text,
      url,
      title: title || url,
      history: history || { title: `[Page] ${title || url}`, url, type: "page-capture" },
    });
  },

  /** Capture a text selection into the inbox. */
  async captureSelection({ url, title, selectedText, history }) {
    const text = (selectedText || "").trim();
    return this.queueCapture({
      mode: "selection",
      text,
      url,
      title: title || url,
      history: history || { title: text.slice(0, 80), url, type: "selection" },
    });
  },

  /**
   * The durable save path. The service worker writes the capture to its
   * outbox BEFORE any network attempt and answers { delivered } — true only
   * when Polymath confirmed the save during this call. A false delivered is
   * not a failure: the capture is safe on this device and syncs itself. When
   * the worker never answers at all the result also carries `unconfirmed`, so
   * the caller can say the server has not confirmed yet instead of "saved".
   *
   * Falls back to a direct POST only when the worker cannot be messaged at
   * all (e.g. an unpacked dashboard outside the extension runtime).
   */
  async queueCapture({ text, url, title, mode, history }) {
    const canMessage =
      typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id && chrome.runtime.sendMessage;
    if (canMessage) {
      let reply;
      try {
        reply = await this._messageWorker(
          {
            type: "AXIOM_ENQUEUE_CAPTURE",
            text,
            url,
            title,
            mode,
            history: history || null,
          },
          ENQUEUE_REPLY_DEADLINE_MS,
        );
      } catch (err) {
        if (err && err.code === "enqueue_unconfirmed") {
          // The worker took the message and then stopped answering: Chrome
          // kills an idle worker mid-await. The capture is written to the
          // outbox before any network call, so it is on this device and the
          // alarm the worker wakes on delivers it. Reporting ok:true here is
          // deliberate — a false failure makes the person capture again. The
          // unconfirmed flag keeps the caller from claiming a save it cannot
          // prove.
          return { ok: true, delivered: false, unconfirmed: true };
        }
        // "Extension context invalidated" — the extension was reloaded or
        // updated and this page still runs the old content script.
        throw new Error("The extension was just reloaded. Refresh this page and try again.");
      }
      if (!reply || reply.ok !== true) {
        throw new Error(reply && reply.error ? reply.error : "The companion could not save the capture.");
      }
      return reply;
    }
    await this.createCapture({ text, url, title, mode });
    return { ok: true, delivered: true };
  },

  /**
   * sendMessage bounded by a deadline. The worker writes the capture before it
   * replies, and that write waits on a storage lock and a delivery pump, so a
   * worker killed mid-await never answers at all — which used to surface as an
   * immediate "could not save" for a capture that was safe on this device.
   */
  _messageWorker(message, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const err = new Error("The companion did not confirm the save in time.");
        err.code = "enqueue_unconfirmed";
        reject(err);
      }, timeoutMs);
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // A missing reply with a runtime error is the reloaded-extension
          // case, not a timeout: keep the distinction the caller reports on.
          if (chrome.runtime.lastError && !reply) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(reply);
        });
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  },

  // ── Health ─────────────────────────────────────────────────────────

  /** Check that Polymath is reachable and this companion is paired. */
  async health() {
    try {
      // Same relay as _fetch: from a page, a direct fetch is subject to that
      // page's CORS and would report offline on every third-party site.
      const resp = await this._fetch("/api/v1/captures?filter=all");
      return Boolean(resp);
    } catch {
      return false;
    }
  },

  // ── Capture history (local) ────────────────────────────────────────

  /** Storage helper — chrome.storage when available, else localStorage fallback. */
  _storageAvailable() {
    return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  },

  async _getStorage(key) {
    if (this._storageAvailable()) {
      const result = await chrome.storage.local.get(key);
      return result[key];
    }
    try {
      const raw = localStorage.getItem(`alfred_${key}`);
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  },

  async _setStorage(key, value) {
    if (this._storageAvailable()) {
      await chrome.storage.local.set({ [key]: value });
      return;
    }
    try {
      localStorage.setItem(`alfred_${key}`, JSON.stringify(value));
    } catch {}
  },

  /** Add a capture to local history (last 100). */
  async addCaptureHistory(entry) {
    try {
      const history = (await this._getStorage("captureHistory")) || [];
      history.unshift({
        ...entry,
        timestamp: Date.now(),
      });
      if (history.length > 100) history.length = 100;
      await this._setStorage("captureHistory", history);
    } catch {
      // Silently ignore storage errors — don't break the main save flow
    }
  },

  /** Patch the history entry written for one outbox entry (sync status). */
  async updateCaptureHistoryByOutboxId(outboxId, patch) {
    try {
      const history = (await this._getStorage("captureHistory")) || [];
      const idx = history.findIndex((entry) => entry.outboxId === outboxId);
      if (idx === -1) return;
      history[idx] = { ...history[idx], ...patch };
      await this._setStorage("captureHistory", history);
    } catch {}
  },

  /** Get capture history. */
  async getCaptureHistory() {
    try {
      return (await this._getStorage("captureHistory")) || [];
    } catch {
      return [];
    }
  },

  /** Clear capture history. */
  async clearCaptureHistory() {
    try {
      await this._setStorage("captureHistory", []);
    } catch {}
  },
};

// Make available globally: window in pages, self in the service worker.
const _axiomRoot = typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : null;
if (_axiomRoot) {
  _axiomRoot.AlfredAPI = AlfredAPI;
}
