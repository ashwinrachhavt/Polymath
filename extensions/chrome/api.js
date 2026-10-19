/**
 * Alfred API client for Chrome extension.
 * Wraps all Alfred backend calls with error handling and base URL management.
 */
/**
 * True when running inside a page. Extension pages (popup, dashboard, side
 * panel) have chrome.extension; content scripts do not.
 */
function isContentScript() {
  return (
    typeof chrome !== "undefined" &&
    Boolean(chrome.runtime && chrome.runtime.id) &&
    !chrome.extension
  );
}

/** Ask the service worker to perform the request; reply as a Response. */
async function relayThroughWorker(url, options) {
  const reply = await chrome.runtime.sendMessage({
    type: "AXIOM_FETCH",
    url,
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body ?? null,
    signalTimeoutMs: 15000,
  });
  if (!reply || reply.ok !== true) {
    throw new Error(reply && reply.error ? `Polymath API: ${reply.error}` : "Polymath API: the companion worker did not answer.");
  }
  return new Response(reply.body, {
    status: reply.status,
    headers: { "content-type": reply.contentType || "application/json" },
  });
}

const AlfredAPI = {
  _baseUrl: null,
  _workspaceId: null,
  _defaultUrl: "http://localhost:3000",

  /** Resolve the API base URL from storage or fall back to default. */
  async base() {
    if (this._baseUrl) return this._baseUrl;
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
      const stored = await this._getStorage("alfredBaseUrl");
      // Only use stored URL if it was explicitly set and is reachable.
      // Otherwise fall back to default to avoid stale cached URLs.
      if (stored && stored !== this._defaultUrl) {
        try {
          // Verify the stored URL is actually Polymath (not another service on
          // that port) by checking /api/v1/captures, which only Polymath serves.
          const resp = await fetch(`${stored}/api/v1/captures`, {
            signal: AbortSignal.timeout(1500),
            headers: { "Content-Type": "application/json" },
          });
          if (resp.ok) {
            this._baseUrl = stored;
            return this._baseUrl;
          }
        } catch {
          // Stored URL unreachable or not Polymath — fall through to default
        }
      }
      this._baseUrl = this._defaultUrl;
    } catch {
      this._baseUrl = this._defaultUrl;
    }
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

  /** Store the token printed by `pnpm companion:pair`. */
  async setToken(value) {
    const clean = (value || "").trim();
    await this._setStorage("axiomToken", clean || null);
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
   * One capture into the Polymath inbox. Text and URL travel together when the
   * page was grabbed; the inbox keeps both and treats the URL as provenance.
   * Server-side dedupe answers 409 for a repeated URL-only capture.
   */
  async createCapture({ text, url, title }) {
    return this._fetch("/api/v1/captures", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ text, url, title }),
    });
  },

  /** The inbox queue. filter is unprocessed | converted | discarded | all. */
  async listCaptures(filter) {
    const query = filter ? `?filter=${encodeURIComponent(filter)}` : "";
    return this._fetch(`/api/v1/captures${query}`);
  },

  /** Ingest a captured page (or a short excerpt) into the inbox. */
  async capturePage({ url, title, content }) {
    const text = (content || "").trim();
    return this.createCapture({ text, url, title: title || url });
  },

  /** Capture a text selection into the inbox. */
  async captureSelection({ url, title, selectedText }) {
    const text = (selectedText || "").trim();
    return this.createCapture({ text, url, title: title ? `${title} — selection` : url });
  },

  // ── Health ─────────────────────────────────────────────────────────

  /** Check that Polymath is reachable and this companion is paired. */
  async health() {
    try {
      const base = await this.base();
      const bearer = await this.token();
      const resp = await fetch(`${base}/api/v1/captures`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        signal: AbortSignal.timeout(3000),
      });
      return resp.ok;
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

// Make available globally (content scripts share the same scope per injection)
if (typeof window !== "undefined") {
  window.AlfredAPI = AlfredAPI;
}
