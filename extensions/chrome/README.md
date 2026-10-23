# Alfred - Knowledge Capture (Chrome Extension)

A Chrome extension that lets you capture text selections, full pages, and quick notes directly into Alfred's knowledge base from any webpage.

## Features

- **Floating Dock** (Alt+N): A sidebar widget with a quick-note textarea, page capture, and recent captures list.
- **Selection Toolbar**: Select text on any page to see "Save to Notes", "Save to Library", and "Summarize" buttons.
- **Keyboard Shortcuts**: Alt+N (toggle dock), Alt+S (save selection/note), Alt+P (capture full page).
- **Popup**: Quick actions, page capture, and settings accessible from the toolbar icon.
- **Dashboard**: Full note management, library browsing, capture history, and settings (opens in a new tab).
- **Connection Indicator**: Green/red dot showing Alfred backend status.

## Installation

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **Load unpacked**
4. Select the `extensions/chrome/` directory from this repo
5. The Alfred icon should appear in your extensions toolbar

## Configuration

The extension connects to `http://localhost:3000` by default (the Polymath dev server). To change this:

- Click the Polymath extension icon and update the API Base URL in Settings, or
- Open the Dashboard (from popup or dock) and go to Settings

## Authentication

Capturing requires an API key:

1. In Polymath, open **Settings → Account and machine clients** and create a key (kind: Chrome companion). The secret is shown once — copy it.
2. Paste it into the extension's **Access token** field (popup or dashboard settings) and save.

The extension sends the key as a bearer token; Polymath stores only its digest. Revoke the key from the same Settings panel to cut access. A `pnpm companion:pair` CLI remains for headless setups.

## Durable capture outbox

Captures are written to the extension's own storage **before** any network
attempt, so a redeploy, a stopped dev server, or a closed laptop delays a
capture instead of losing it. The service worker delivers the queue in the
background:

- **Save first, sync second.** The capture lands in `chrome.storage.local`
  (durable across browser restarts and worker death), then a POST is
  attempted immediately. Page `localStorage` is deliberately not used: it
  belongs to each website, is cleared with site data, and is unreachable
  from the service worker.
- **Exactly-once retries.** Each capture gets one idempotency key at enqueue
  time; the server's `request_receipts` make every retry safe. Failures
  retry with exponential backoff (30s, doubling, 15m cap) scheduled through
  `chrome.alarms`, which wakes the worker even after Chrome restarts.
- **Honest status.** Toasts and Capture History distinguish "Saved on this
  device" from "Synced to Polymath". The popup shows the pending count; the
  Dashboard's **Pending Sync** panel lists every waiting capture with Retry
  and Discard.
- **Nothing is silently dropped.** After 8 failed attempts, or on a
  permanent error, the capture parks as failed / needs-auth and waits for
  you. A 401 means the API key was revoked — mint a fresh one, save it in
  Settings, then Retry.
- **Storage budget.** The outbox refuses new captures near ~8 MB instead of
  corrupting the queue; the Dashboard shows what is waiting.

## If the account or server changes with captures still queued

Every queued capture is bound to the destination it was saved for (the server
origin plus a hash of the paired key — the key itself is never stored on the
entry). If you switch accounts, rotate the key, or point the extension at a
different server while captures are waiting, they park as **account changed —
needs your OK** instead of silently landing in the new account. Nothing is
sent anywhere until you choose, per capture, in **Pending Sync**:

- **Deliver to connected account** sends it to the currently connected
  server/account, which may be different from the one it was saved for;
- **Discard** removes it from this device.

The same honesty applies when Polymath already holds a captured URL: the
server keeps its earlier version and rejects the new text, so the capture
parks as **already in Polymath — text not saved** with the choice to **save
the text without the link** (as a plain note) or discard it. A repeated
URL-only capture is the one case safe to treat as already delivered.

## Requirements

- Polymath backend running at the configured URL
- Chrome 88+ (Manifest V3 support)

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Alt + N  | Toggle the floating dock |
| Alt + S  | Save current selection or quick note |
| Alt + P  | Capture entire page content |
