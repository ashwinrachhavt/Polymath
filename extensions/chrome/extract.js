/**
 * Alfred Chrome Extension — Shared Extraction Module
 *
 * Single source of truth for all content extraction across content.js and popup.js.
 * Uses Readability.js for article extraction and Turndown.js for HTML→Markdown conversion.
 *
 * Globals expected: Readability (from libs/readability.js), TurndownService (from libs/turndown.js)
 */
(function () {
  "use strict";

  if (window.__alfredExtractLoaded) return;
  window.__alfredExtractLoaded = true;

  // ── Turndown configuration ─────────────────────────────────────────

  var _turndownService = null;

  function getTurndown() {
    if (_turndownService) return _turndownService;
    if (typeof TurndownService === "undefined") return null;

    _turndownService = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
      emDelimiter: "*",
      strongDelimiter: "**",
      linkStyle: "inlined",
    });

    // Preserve tables (basic support)
    _turndownService.addRule("table", {
      filter: ["table"],
      replacement: function (content, node) {
        // Convert table to simple markdown table
        var rows = node.querySelectorAll("tr");
        if (!rows.length) return content;

        var lines = [];
        for (var i = 0; i < rows.length; i++) {
          var cells = rows[i].querySelectorAll("td, th");
          var cellTexts = [];
          for (var j = 0; j < cells.length; j++) {
            cellTexts.push(cells[j].textContent.trim().replace(/\|/g, "\\|"));
          }
          lines.push("| " + cellTexts.join(" | ") + " |");
          // Add header separator after first row
          if (i === 0) {
            lines.push("| " + cellTexts.map(function () { return "---"; }).join(" | ") + " |");
          }
        }
        return "\n\n" + lines.join("\n") + "\n\n";
      },
    });

    // Skip table sub-elements (handled by table rule)
    _turndownService.addRule("tableElements", {
      filter: ["thead", "tbody", "tfoot", "tr", "td", "th"],
      replacement: function (content) {
        return content;
      },
    });

    // Remove script/style/nav/footer elements
    _turndownService.remove(["script", "style", "nav", "footer", "noscript", "iframe"]);

    return _turndownService;
  }

  // ── Content type detection ─────────────────────────────────────────

  var CONTENT_TYPE_PATTERNS = [
    { pattern: /^https?:\/\/(www\.)?youtube\.com\/watch/, type: "youtube" },
    { pattern: /^https?:\/\/youtu\.be\//, type: "youtube" },
    { pattern: /^https?:\/\/(www\.)?youtube\.com\/shorts\//, type: "youtube" },
    { pattern: /^https?:\/\/(www\.)?(twitter|x)\.com\/\w+\/status\//, type: "twitter" },
    { pattern: /^https?:\/\/github\.com\/[^/]+\/[^/]+\/(blob|tree|readme)/i, type: "github" },
    { pattern: /^https?:\/\/github\.com\/[^/]+\/[^/]+\/?$/i, type: "github" },
    { pattern: /^https?:\/\/raw\.githubusercontent\.com\//, type: "github" },
    { pattern: /^https?:\/\/arxiv\.org\/(abs|pdf)\//, type: "arxiv" },
  ];

  /**
   * Detect special content type from URL.
   * @param {string} url
   * @returns {"youtube"|"github"|"arxiv"|"twitter"|"generic"}
   */
  function detectContentType(url) {
    if (!url) return "generic";
    for (var i = 0; i < CONTENT_TYPE_PATTERNS.length; i++) {
      if (CONTENT_TYPE_PATTERNS[i].pattern.test(url)) {
        return CONTENT_TYPE_PATTERNS[i].type;
      }
    }
    return "generic";
  }

  // ── Quality analysis ───────────────────────────────────────────────

  /**
   * Analyze markdown quality — does it have meaningful structure?
   * @param {string} markdown
   * @returns {"rich"|"basic"}
   */
  function analyzeQuality(markdown) {
    if (!markdown) return "basic";

    var hasHeadings = /^#{1,6}\s/m.test(markdown);
    var hasImages = /!\[.*?\]\(.*?\)/.test(markdown);
    var hasCodeBlocks = /```[\s\S]*?```/.test(markdown) || /^    \S/m.test(markdown);
    var hasTables = /\|.*\|.*\|/m.test(markdown);
    var hasLists = /^[\s]*[-*+]\s/m.test(markdown) || /^[\s]*\d+\.\s/m.test(markdown);
    var hasLinks = /\[.*?\]\(.*?\)/.test(markdown);

    var signals = [hasHeadings, hasImages, hasCodeBlocks, hasTables, hasLists, hasLinks];
    var count = signals.filter(Boolean).length;

    return count >= 2 ? "rich" : "basic";
  }

  // ── Core extraction ────────────────────────────────────────────────

  var MAX_MARKDOWN_SIZE = 200 * 1024; // 200KB cap
  var MAX_TEXT_SIZE = 50000; // 50KB plain text cap (existing limit)

  /**
   * Extract the main article content from the page.
   * Returns both plain text (for backward compat) and rich markdown.
   *
   * Fallback chain:
   *   1. Readability → clean article HTML → Turndown → Markdown
   *   2. body.innerHTML (if Readability finds no article) → Turndown → Markdown
   *   3. body.innerText (if Turndown fails) → plain text only
   *
   * @returns {{ raw_text: string, raw_markdown: string|null, quality: "rich"|"basic", content_type_hint: string }}
   */
  function extractPage() {
    var url = location.href;
    var contentTypeHint = detectContentType(url);
    var articleHtml = null;
    var raw_text = null;
    var raw_markdown = null;

    // Step 1: Try Readability for clean article extraction
    if (typeof Readability !== "undefined") {
      try {
        var docClone = document.cloneNode(true);
        var parsed = new Readability(docClone).parse();
        if (parsed && parsed.content && parsed.textContent) {
          articleHtml = parsed.content;
          raw_text = parsed.textContent.slice(0, MAX_TEXT_SIZE);
        }
      } catch (e) {
        // Readability failed — fall through
      }
    }

    // Step 2: Fallback — use best DOM selector for article area
    if (!articleHtml) {
      var main =
        document.querySelector("article") ||
        document.querySelector("[role='main']") ||
        document.querySelector("main") ||
        document.querySelector(".post-content") ||
        document.querySelector(".entry-content") ||
        document.querySelector(".article-body") ||
        document.body;

      articleHtml = main.innerHTML;
      raw_text = (main.innerText || "").slice(0, MAX_TEXT_SIZE);
    }

    // Step 3: Convert HTML to Markdown via Turndown
    var turndown = getTurndown();
    if (turndown && articleHtml) {
      try {
        raw_markdown = turndown.turndown(articleHtml);
        // Apply 200KB cap — truncate at last complete paragraph
        if (raw_markdown.length > MAX_MARKDOWN_SIZE) {
          var truncated = raw_markdown.slice(0, MAX_MARKDOWN_SIZE);
          var lastParagraph = truncated.lastIndexOf("\n\n");
          if (lastParagraph > MAX_MARKDOWN_SIZE * 0.8) {
            raw_markdown = truncated.slice(0, lastParagraph);
          } else {
            raw_markdown = truncated;
          }
          raw_markdown += "\n\n[Content truncated at 200KB]";
        }
      } catch (e) {
        // Turndown failed — raw_markdown stays null
        raw_markdown = null;
      }
    }

    // Step 4: Ensure we always have raw_text
    if (!raw_text || raw_text.trim().length < 10) {
      raw_text = (document.body.innerText || "").slice(0, MAX_TEXT_SIZE);
    }

    var quality = analyzeQuality(raw_markdown);

    return {
      raw_text: raw_text.trim(),
      raw_markdown: raw_markdown,
      quality: quality,
      content_type_hint: contentTypeHint,
    };
  }

  /**
   * Extract structured content from a text selection.
   * Uses Range.cloneContents() to preserve formatting.
   *
   * @param {Selection} [selection] - optional, defaults to window.getSelection()
   * @returns {{ raw_text: string, raw_markdown: string|null }}
   */
  function extractSelection(selection) {
    selection = selection || window.getSelection();
    var raw_text = (selection.toString() || "").trim();
    var raw_markdown = null;

    if (!raw_text) return { raw_text: "", raw_markdown: null };

    // Try to get HTML from the selection Range
    try {
      if (selection.rangeCount > 0) {
        var range = selection.getRangeAt(0);
        var fragment = range.cloneContents();
        var tempDiv = document.createElement("div");
        tempDiv.appendChild(fragment);
        var html = tempDiv.innerHTML;

        if (html && html.trim()) {
          var turndown = getTurndown();
          if (turndown) {
            raw_markdown = turndown.turndown(html);
          }
        }
      }
    } catch (e) {
      // Range extraction or Turndown failed — raw_markdown stays null
    }

    return {
      raw_text: raw_text,
      raw_markdown: raw_markdown,
    };
  }

  // ── Export globals ─────────────────────────────────────────────────

  window.AlfredExtract = {
    extractPage: extractPage,
    extractSelection: extractSelection,
    detectContentType: detectContentType,
    analyzeQuality: analyzeQuality,
  };
})();
