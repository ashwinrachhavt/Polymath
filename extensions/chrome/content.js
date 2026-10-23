/**
 * Alfred Chrome Extension — Content Script
 *
 * Injects a floating dock and selection toolbar on every page.
 * Keyboard shortcuts: Alt+N toggle dock, Alt+S save selection, Alt+P capture page.
 */
(function () {
  "use strict";

  // Prevent double-injection
  if (window.__alfredContentLoaded) return;
  window.__alfredContentLoaded = true;

  const DOMAIN_KEY = `alfred_draft_${location.hostname}`;

  // ── Helpers ──────────────────────────────────────────────────────────

  function qs(sel, root) {
    return (root || document).querySelector(sel);
  }

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") e.className = v;
        else if (k === "style" && typeof v === "object")
          Object.assign(e.style, v);
        else if (k.startsWith("on") && typeof v === "function")
          e.addEventListener(k.slice(2).toLowerCase(), v);
        else e.setAttribute(k, v);
      }
    }
    if (children) {
      for (const c of Array.isArray(children) ? children : [children]) {
        if (typeof c === "string") e.appendChild(document.createTextNode(c));
        else if (c) e.appendChild(c);
      }
    }
    return e;
  }

  // ── Toast system ────────────────────────────────────────────────────

  let toastContainer = null;

  function ensureToastContainer() {
    if (toastContainer && document.body.contains(toastContainer)) return;
    toastContainer = el("div", { id: "alfred-toast-container" });
    document.body.appendChild(toastContainer);
  }

  function showToast(message, type = "info") {
    ensureToastContainer();
    const t = el("div", { class: `alfred-toast alfred-toast-${type}` }, message);
    toastContainer.appendChild(t);
    setTimeout(() => {
      if (t.parentNode) t.remove();
    }, 3000);
  }

  // ── Connection status ───────────────────────────────────────────────

  let isOnline = false;

  async function checkConnection() {
    try {
      isOnline = await AlfredAPI.health();
    } catch {
      isOnline = false;
    }
    const dot = qs("#alfred-dock-status");
    if (dot) {
      dot.classList.toggle("alfred-status-online", isOnline);
      dot.title = isOnline ? "Polymath connected" : "Polymath offline";
    }
  }

  // ── Build the dock ──────────────────────────────────────────────────

  let dock = null;
  let dockBuilt = false;

  function buildDock() {
    if (dockBuilt) return;
    dockBuilt = true;

    dock = el("div", { id: "alfred-dock" }, [
      // Header
      el("div", { id: "alfred-dock-header" }, [
        el("div", { class: "alfred-logo" }, [
          el("span", { class: "alfred-logo-icon" }, "P"),
          "Polymath",
          el("div", { id: "alfred-dock-status", title: "Checking..." }),
        ]),
        el("div", { class: "alfred-dock-actions" }, [
          el("button", {
            class: "alfred-dock-btn-icon",
            title: "Move to other side",
            onClick: toggleDockSide,
          }, "\u21C4"),
          el("button", {
            class: "alfred-dock-btn-icon",
            title: "Open Dashboard",
            onClick: () => {
              const url = chrome.runtime.getURL("dashboard.html");
              window.open(url, "_blank");
            },
          }, "\u2630"),
          el("button", {
            class: "alfred-dock-btn-icon",
            title: "Close (Alt+N)",
            onClick: toggleDock,
          }, "\u2715"),
        ]),
      ]),

      // Body
      el("div", { id: "alfred-dock-body" }, [
        el("textarea", {
          id: "alfred-note-textarea",
          placeholder: "Quick note... (Alt+S to save)",
          rows: "6",
        }),
        el("div", { class: "alfred-btn-row" }, [
          el("button", {
            class: "alfred-btn alfred-btn-primary",
            onClick: saveQuickNote,
          }, "Save Note"),
          el("button", {
            class: "alfred-btn alfred-btn-secondary",
            onClick: captureFullPage,
          }, "Capture Page"),
        ]),
        el("div", { class: "alfred-shortcuts-hint" }, [
          el("span", { class: "alfred-kbd" }, "Alt+N"),
          " Toggle dock  ",
          el("span", { class: "alfred-kbd" }, "Alt+S"),
          " Save  ",
          el("span", { class: "alfred-kbd" }, "Alt+P"),
          " Capture page",
        ]),
        el("p", { class: "alfred-section-label" }, "Recent Captures"),
        el("ul", { id: "alfred-recent-captures", class: "alfred-capture-list" }),
      ]),
    ]);

    document.body.appendChild(dock);

    // Restore draft
    try {
      const saved = localStorage.getItem(DOMAIN_KEY);
      if (saved) qs("#alfred-note-textarea").value = saved;
    } catch {}

    // Auto-save draft on input
    qs("#alfred-note-textarea").addEventListener("input", (e) => {
      try {
        localStorage.setItem(DOMAIN_KEY, e.target.value);
      } catch {}
    });

    // Restore dock side
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get("alfredDockSide", (res) => {
          if (res && res.alfredDockSide === "left") dock.classList.add("alfred-dock-left");
        });
      }
    } catch {}

    // Initial connection check
    checkConnection();
    setInterval(checkConnection, 30000);

    // Load recent captures
    refreshRecentCaptures();
  }

  async function refreshRecentCaptures() {
    const list = qs("#alfred-recent-captures");
    if (!list) return;
    const history = await AlfredAPI.getCaptureHistory();
    list.innerHTML = "";
    const recent = history.slice(0, 5);
    if (recent.length === 0) {
      list.appendChild(
        el("li", { class: "alfred-capture-item" }, "No captures yet.")
      );
      return;
    }
    for (const item of recent) {
      const ago = timeAgo(item.timestamp);
      const sync =
        item.delivery === "pending" ? " — pending sync"
        : item.delivery === "failed" ? " — sync failed"
        : item.delivery === "needs-auth" ? " — needs new API key"
        : "";
      list.appendChild(
        el("li", { class: "alfred-capture-item" }, [
          el("span", { class: "alfred-capture-item-title" }, item.title || "Untitled"),
          el("span", { class: "alfred-capture-item-meta" }, `${ago} — ${item.type || "note"}${sync}`),
        ])
      );
    }
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return "just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    return `${days}d ago`;
  }

  // ── Dock actions ────────────────────────────────────────────────────

  function toggleDock() {
    buildDock();
    dock.classList.toggle("alfred-dock-visible");
  }

  function toggleDockSide() {
    if (!dock) return;
    dock.classList.toggle("alfred-dock-left");
    const isLeft = dock.classList.contains("alfred-dock-left");
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ alfredDockSide: isLeft ? "left" : "right" });
      }
    } catch {}
  }

  async function saveQuickNote() {
    const textarea = qs("#alfred-note-textarea");
    let text = textarea ? textarea.value.trim() : "";

    // If textarea is empty, try clipboard, then selected text, then full page
    if (!text) {
      const selected = getSelectedText();
      if (selected) {
        text = selected;
      } else {
        try {
          const clip = await navigator.clipboard.readText();
          if (clip && clip.trim()) {
            text = clip.trim();
          }
        } catch {
          // Clipboard access denied or unavailable — fall through
        }
      }
    }

    // Last resort: capture full page using extractor
    if (!text) {
      const extracted = window.AlfredExtract
        ? AlfredExtract.extractPage()
        : { raw_text: document.body.innerText.slice(0, 50000), raw_markdown: null, quality: "basic", content_type_hint: "generic" };
      text = extracted.raw_text.trim();
    }

    if (!text) {
      showToast("Nothing to save.", "warning");
      return;
    }

    const isFullPage = text.length > 500;
    const captureType = isFullPage ? "page-capture" : "quick-note";

    try {
      const result = isFullPage
        ? await AlfredAPI.capturePage({
            url: location.href,
            title: document.title,
            content: text,
          })
        : await AlfredAPI.captureSelection({
            url: location.href,
            title: document.title,
            selectedText: text,
            history: { title: text.slice(0, 80), url: location.href, type: captureType },
          });
      if (textarea) {
        textarea.value = "";
        try { localStorage.removeItem(DOMAIN_KEY); } catch {}
      }
      showToast(
        result.delivered
          ? (isFullPage ? "Page captured to Polymath!" : "Note saved to Polymath!")
          : "Saved on this device — will sync to Polymath when it is reachable.",
        "success",
      );
      refreshRecentCaptures();
    } catch (err) {
      showToast(`Save failed: ${err.message}`, "error");
    }
  }

  async function captureFullPage() {
    try {
      const extracted = window.AlfredExtract
        ? AlfredExtract.extractPage()
        : { raw_text: document.body.innerText.slice(0, 50000), raw_markdown: null, quality: "basic", content_type_hint: "generic" };

      const result = await AlfredAPI.capturePage({
        url: location.href,
        title: document.title,
        content: extracted.raw_text,
        history: {
          title: `[Page] ${document.title}`,
          url: location.href,
          type: "page-capture",
          quality: extracted.quality,
        },
      });
      const qualityLabel = extracted.quality === "rich" ? "Rich capture \u2713" : "Basic capture";
      showToast(
        result.delivered
          ? `Page captured to Polymath! (${qualityLabel})`
          : "Saved on this device — will sync to Polymath when it is reachable.",
        "success",
      );
      refreshRecentCaptures();
    } catch (err) {
      showToast(`Capture failed: ${err.message}`, "error");
    }
  }

  async function saveSelectionToNotes(text) {
    try {
      // Extract structured selection with formatting preserved
      var extracted = window.AlfredExtract
        ? AlfredExtract.extractSelection()
        : { raw_text: text, raw_markdown: null };

      var selText = extracted.raw_text || text;

      const result = await AlfredAPI.captureSelection({
        url: location.href,
        title: document.title,
        selectedText: selText,
        raw_markdown: extracted.raw_markdown,
        history: { title: selText.slice(0, 80), url: location.href, type: "selection" },
      });
      showToast(
        result.delivered
          ? "Selection saved to Polymath!"
          : "Saved on this device — will sync to Polymath when it is reachable.",
        "success",
      );
      refreshRecentCaptures();
    } catch (err) {
      showToast(`Save failed: ${err.message}`, "error");
    }
  }

  // Summarize needs an AI endpoint Polymath does not expose to the companion yet.
  // Say so plainly instead of letting the button hit a 404.
  function summarizeSelection() {
    showToast("Summarize is not available yet. Capture the selection instead.", "info");
  }

  // ── Selection toolbar ───────────────────────────────────────────────

  let toolbar = null;

  function buildToolbar() {
    if (toolbar) return;
    toolbar = el("div", { id: "alfred-selection-toolbar" }, [
      el("button", {
        class: "alfred-toolbar-btn",
        onClick: () => {
          const text = getSelectedText();
          if (text) saveSelectionToNotes(text);
          hideToolbar();
        },
      }, "Save to Notes"),
      el("button", {
        class: "alfred-toolbar-btn",
        onClick: () => {
          const text = getSelectedText();
          if (text) saveSelectionToNotes(text);
          hideToolbar();
        },
      }, "Save to Library"),
      el("button", {
        class: "alfred-toolbar-btn",
        onClick: () => {
          const text = getSelectedText();
          if (text) summarizeSelection(text);
          hideToolbar();
        },
      }, "Summarize"),
    ]);
    document.body.appendChild(toolbar);
  }

  function getSelectedText() {
    return window.getSelection().toString().trim();
  }

  function showToolbar(x, y) {
    buildToolbar();
    toolbar.style.left = `${Math.min(x, window.innerWidth - 320)}px`;
    toolbar.style.top = `${y + window.scrollY - 44}px`;
    toolbar.classList.add("alfred-toolbar-visible");
  }

  function hideToolbar() {
    if (toolbar) toolbar.classList.remove("alfred-toolbar-visible");
  }

  // Show toolbar on text selection
  document.addEventListener("mouseup", (e) => {
    // Ignore clicks inside our own UI
    if (e.target.closest("#alfred-dock") || e.target.closest("#alfred-selection-toolbar")) return;

    setTimeout(() => {
      const text = getSelectedText();
      if (text.length > 2) {
        const sel = window.getSelection();
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        showToolbar(rect.left + rect.width / 2 - 120, rect.top);
      } else {
        hideToolbar();
      }
    }, 10);
  });

  // Hide toolbar on click elsewhere
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#alfred-selection-toolbar")) {
      hideToolbar();
    }
  });

  // ── Floating Action Button (always visible) ────────────────────────

  function openSidePanel() {
    try {
      chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL" });
    } catch {
      // Fallback if messaging fails — just toggle the dock
      toggleDock();
    }
  }

  function buildFab() {
    const fab = el("div", { id: "alfred-fab" }, [
      el("span", { class: "alfred-fab-letter", onClick: toggleDock }, "P"),
    ]);
    // Long-press or right-click opens side panel
    fab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openSidePanel();
    });
    document.body.appendChild(fab);
  }

  // Build FAB immediately so user sees something on page load
  if (document.body) {
    buildFab();
  } else {
    document.addEventListener("DOMContentLoaded", buildFab);
  }

  // ── Message handler for side panel ──────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "GET_ARTICLE_TEXT") {
      // Use shared extractor for consistent extraction
      const extracted = window.AlfredExtract
        ? AlfredExtract.extractPage()
        : { raw_text: (document.body.innerText || "").slice(0, 50000), raw_markdown: null, quality: "basic", content_type_hint: "generic" };

      sendResponse({
        url: location.href,
        title: document.title,
        text: extracted.raw_text,
        raw_markdown: extracted.raw_markdown,
        quality: extracted.quality,
        content_type_hint: extracted.content_type_hint,
      });
      return true; // async response
    }
  });

  // ── Keyboard shortcuts ──────────────────────────────────────────────

  document.addEventListener("keydown", (e) => {
    // Alt+N — toggle dock
    if (e.altKey && e.key.toLowerCase() === "n") {
      e.preventDefault();
      toggleDock();
    }

    // Alt+S — save selection or quick note
    if (e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      const selected = getSelectedText();
      if (selected) {
        saveSelectionToNotes(selected);
      } else {
        saveQuickNote();
      }
    }

    // Alt+P — capture full page
    if (e.altKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      captureFullPage();
    }

    // Alt+J — open AI reading mode side panel
    if (e.altKey && e.key.toLowerCase() === "j") {
      e.preventDefault();
      openSidePanel();
    }
  });
})();
