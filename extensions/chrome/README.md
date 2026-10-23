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

## Requirements

- Polymath backend running at the configured URL
- Chrome 88+ (Manifest V3 support)

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Alt + N  | Toggle the floating dock |
| Alt + S  | Save current selection or quick note |
| Alt + P  | Capture entire page content |
