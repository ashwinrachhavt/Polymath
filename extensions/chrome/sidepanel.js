/**
 * Alfred Side Panel — Reading Mode
 *
 * Vanilla JS controller for the Chrome side panel.
 * Communicates directly with the Alfred backend for AI features.
 *
 * All user-provided strings are sanitized via esc() before DOM insertion.
 * innerHTML is only used with either esc()-sanitized values or hardcoded HTML.
 */
(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────

  let currentArticle = null; // { url, title, text, domain, wordCount }
  let activeTab = 'connections';
  let chatHistory = [];
  let connectionCount = 0;
  let connectionsLoaded = false;
  let decomposeLoaded = false;
  let streamingMsgEl = null;

  const BASE_URL = 'http://localhost:3000';

  // ── DOM refs ─────────────────────────────────────────────────────────

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * Escape user-provided strings for safe innerHTML insertion.
   * Uses the browser's own text node escaping.
   */
  function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /** Create a DOM element with attributes and children (safe API). */
  function createElement(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'className') el.className = v;
        else if (k === 'textContent') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else {
          el.setAttribute(k, v);
        }
      }
    }
    if (children) {
      const items = Array.isArray(children) ? children : [children];
      for (const c of items) {
        if (typeof c === 'string') el.appendChild(document.createTextNode(c));
        else if (c) el.appendChild(c);
      }
    }
    return el;
  }

  // ── Init ─────────────────────────────────────────────────────────────

  async function init() {
    bindTabs();
    bindChat();
    bindClose();

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) throw new Error('No active tab');

      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_ARTICLE_TEXT' });
      if (!response || !response.text) throw new Error('No article text');

      const url = new URL(response.url || tab.url);
      const wordCount = (response.text || '').split(/\s+/).filter(Boolean).length;

      currentArticle = {
        url: response.url || tab.url,
        title: response.title || tab.title || 'Untitled',
        text: response.text,
        domain: url.hostname.replace(/^www\./, ''),
        wordCount,
      };

      renderArticleContext();
      loadConnections();
    } catch (err) {
      console.error('Alfred side panel init error:', err);
      showError('Could not read page content. Try refreshing the page.');
    }
  }

  // ── Tab switching ────────────────────────────────────────────────────

  function bindTabs() {
    $$('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchTab(btn.dataset.tab);
      });
    });
  }

  function switchTab(tabName) {
    activeTab = tabName;

    // Update tab buttons
    $$('.tab-btn').forEach((btn) => {
      const isActive = btn.dataset.tab === tabName;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });

    // Update tab panels
    $$('.tab-panel').forEach((panel) => {
      const isActive = panel.id === 'tab-' + tabName;
      panel.classList.toggle('active', isActive);
      panel.hidden = !isActive;
    });

    // Show/hide chat input
    const chatInput = $('#chat-input-area');
    if (chatInput) chatInput.hidden = tabName !== 'chat';

    // Load content if needed
    if (tabName === 'connections' && !connectionsLoaded) loadConnections();
    if (tabName === 'decompose' && !decomposeLoaded) loadDecompose();
  }

  // ── Close button ─────────────────────────────────────────────────────

  function bindClose() {
    const btn = $('#close-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        window.close();
      });
    }
  }

  // ── Article context ──────────────────────────────────────────────────

  function renderArticleContext() {
    if (!currentArticle) return;
    const ctx = $('#article-context');
    if (!ctx) return;

    $('#article-title').textContent = currentArticle.title;
    const meta = [];
    if (currentArticle.domain) meta.push(currentArticle.domain);
    if (currentArticle.wordCount) meta.push(currentArticle.wordCount.toLocaleString() + ' words');
    $('#article-meta').textContent = meta.join(' \u00B7 ');
    ctx.hidden = false;
  }

  // ── Connections tab ──────────────────────────────────────────────────

  async function loadConnections() {
    if (!currentArticle) return;
    const container = $('#tab-connections .tab-content');
    showSkeleton(container);

    try {
      const resp = await fetch(BASE_URL + '/api/reading/companion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: currentArticle.url,
          title: currentArticle.title,
          text: currentArticle.text,
          mode: 'connections',
        }),
      });

      if (!resp.ok) throw new Error('' + resp.status);
      const data = await resp.json();
      connectionsLoaded = true;
      connectionCount = data.connections?.length || 0;

      if (connectionCount < 3) {
        renderColdStart(container);
        if (connectionCount === 0) switchTab('decompose');
      } else {
        renderConnections(container, data.connections);
      }
    } catch (err) {
      connectionsLoaded = false;
      showTabError(container, 'Backend offline', loadConnections);
    }
  }

  function renderConnections(container, items) {
    container.innerHTML = '';
    for (const item of items) {
      const card = createElement('div', {
        className: 'connection-card',
        role: 'article',
        tabindex: '0',
        'aria-label': item.title || 'Connection',
      });

      if (item.title) {
        card.appendChild(createElement('div', { className: 'connection-title', textContent: item.title }));
      }
      if (item.relation) {
        card.appendChild(createElement('div', { className: 'connection-relation', textContent: item.relation }));
      }

      const metaRow = createElement('div', { className: 'connection-meta' });
      if (item.bloom_level) {
        metaRow.appendChild(createElement('span', { className: 'bloom-badge', textContent: item.bloom_level }));
      }
      if (item.source) {
        metaRow.appendChild(createElement('span', { textContent: item.source }));
      }
      if (item.date) {
        metaRow.appendChild(createElement('span', { textContent: item.date }));
      }
      card.appendChild(metaRow);

      container.appendChild(card);
    }
  }

  function renderColdStart(container) {
    container.innerHTML = '';
    const wrapper = createElement('div', { className: 'cold-start-message' });
    wrapper.appendChild(createElement('span', { className: 'cold-start-icon', 'aria-hidden': 'true', textContent: '\u{1F9E0}' }));
    wrapper.appendChild(createElement('p', { className: 'cold-start-title', textContent: 'Building your knowledge graph' }));
    wrapper.appendChild(createElement('p', {
      className: 'cold-start-text',
      textContent: 'Keep reading \u2014 Axiom learns your knowledge graph as you go. After ~10 captured articles, connections will start appearing here.',
    }));
    container.appendChild(wrapper);
  }

  // ── Decompose tab ────────────────────────────────────────────────────

  async function loadDecompose() {
    if (!currentArticle) return;
    const container = $('#tab-decompose .tab-content');
    showSkeleton(container);

    try {
      const resp = await fetch(BASE_URL + '/api/reading/companion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: currentArticle.url,
          title: currentArticle.title,
          text: currentArticle.text,
          mode: 'decompose',
        }),
      });

      if (!resp.ok) throw new Error('' + resp.status);
      const data = await resp.json();
      decomposeLoaded = true;
      renderDecompose(container, data);
    } catch (err) {
      decomposeLoaded = false;
      showTabError(container, 'AI unavailable', loadDecompose);
    }
  }

  function renderDecompose(container, data) {
    container.innerHTML = '';

    // Summary paragraph
    if (data.summary) {
      container.appendChild(createElement('p', { className: 'decompose-summary', textContent: data.summary }));
    }

    // Claims
    const claims = data.claims || data.key_claims || [];
    if (claims.length > 0) {
      container.appendChild(createElement('p', { className: 'claims-label', textContent: 'Key Claims' }));

      const list = createElement('div', { role: 'list', 'aria-label': 'Key claims from this article' });

      for (const claim of claims) {
        const text = typeof claim === 'string' ? claim : claim.text || claim.content || '';
        const tags = (typeof claim === 'object' && claim.tags) ? claim.tags : [];

        const card = createElement('div', { className: 'claim-card', role: 'listitem' });
        card.appendChild(createElement('p', { className: 'claim-text', textContent: text }));

        if (tags.length > 0) {
          const tagsDiv = createElement('div', { className: 'claim-tags' });
          for (const tag of tags) {
            tagsDiv.appendChild(createElement('span', { className: 'claim-tag', textContent: tag }));
          }
          card.appendChild(tagsDiv);
        }

        const btn = createElement('button', {
          className: 'claim-save-btn',
          'aria-label': 'Save this claim to Knowledge Hub',
          textContent: 'Save as zettel',
          onClick: async function () {
            if (btn.classList.contains('saved')) return;
            await saveAsZettel(text, currentArticle?.url);
            btn.textContent = 'Saved';
            btn.classList.add('saved');
          },
        });
        card.appendChild(btn);
        list.appendChild(card);
      }

      container.appendChild(list);
    }

    if (!data.summary && claims.length === 0) {
      container.appendChild(createElement('p', {
        className: 'tab-error-text',
        textContent: 'No decomposition data available for this page.',
      }));
    }
  }

  // ── Chat tab ─────────────────────────────────────────────────────────

  function bindChat() {
    const input = $('#chat-input');
    const sendBtn = $('#chat-send-btn');

    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          submitChat();
        }
      });
    }

    if (sendBtn) {
      sendBtn.addEventListener('click', submitChat);
    }
  }

  function submitChat() {
    const input = $('#chat-input');
    if (!input) return;
    const message = input.value.trim();
    if (!message) return;
    input.value = '';
    sendChatMessage(message);
  }

  async function sendChatMessage(message) {
    if (!currentArticle) return;

    chatHistory.push({ role: 'user', content: message });
    renderChatMessage('user', message);
    showTypingIndicator();

    let fullResponse = '';
    let gotDoneMarker = false;

    try {
      const resp = await fetch(BASE_URL + '/api/reading/companion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: currentArticle.url,
          title: currentArticle.title,
          text: currentArticle.text,
          mode: 'chat',
          message,
          chat_history: chatHistory.slice(-10),
        }),
      });

      if (!resp.ok) throw new Error('' + resp.status);

      // Check if response is streaming (ndjson) or regular JSON
      const contentType = resp.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        // Non-streaming response
        const data = await resp.json();
        hideTypingIndicator();
        fullResponse = data.response || data.content || data.message || JSON.stringify(data);
        gotDoneMarker = true;
        renderChatMessage('assistant', fullResponse);
      } else {
        // Streaming response — newline-delimited JSON
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();

        streamingMsgEl = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = decoder.decode(value, { stream: true });
          const lines = text.split('\n').filter(Boolean);

          for (const line of lines) {
            try {
              const chunk = JSON.parse(line);
              if (chunk.done) {
                gotDoneMarker = true;
              } else if (chunk.content) {
                fullResponse += chunk.content;
                updateStreamingMessage(fullResponse);
              }
            } catch (e) {
              // Not valid JSON — partial chunk; ignore
            }
          }
        }

        hideTypingIndicator();
        streamingMsgEl = null;

        if (!gotDoneMarker) {
          appendInterruptedMessage();
        }
      }

      if (fullResponse) {
        chatHistory.push({ role: 'assistant', content: fullResponse });
      }
    } catch (err) {
      hideTypingIndicator();
      streamingMsgEl = null;
      renderChatMessage('error', 'Response failed \u2014 try again.');
    }
  }

  function renderChatMessage(role, content) {
    const container = $('#chat-messages');
    if (!container) return;

    const classMap = {
      user: 'chat-msg chat-msg-user',
      assistant: 'chat-msg chat-msg-assistant',
      error: 'chat-msg chat-msg-error',
    };

    const msg = createElement('div', {
      className: classMap[role] || 'chat-msg',
      textContent: content,
    });

    container.appendChild(msg);
    scrollChatToBottom();
  }

  function updateStreamingMessage(text) {
    const container = $('#chat-messages');
    if (!container) return;

    if (!streamingMsgEl) {
      // Remove typing indicator first if present
      const typing = container.querySelector('.typing-indicator');
      if (typing) typing.remove();

      streamingMsgEl = createElement('div', { className: 'chat-msg chat-msg-assistant' });
      container.appendChild(streamingMsgEl);
    }

    streamingMsgEl.textContent = text;
    scrollChatToBottom();
  }

  function showTypingIndicator() {
    const container = $('#chat-messages');
    if (!container) return;

    // Remove existing
    const existing = container.querySelector('.typing-indicator');
    if (existing) existing.remove();

    const indicator = createElement('div', {
      className: 'typing-indicator',
      'aria-label': 'Axiom is thinking',
    }, [
      createElement('span'),
      createElement('span'),
      createElement('span'),
    ]);

    container.appendChild(indicator);
    scrollChatToBottom();
  }

  function hideTypingIndicator() {
    const container = $('#chat-messages');
    if (!container) return;
    const indicator = container.querySelector('.typing-indicator');
    if (indicator) indicator.remove();
  }

  function appendInterruptedMessage() {
    const container = $('#chat-messages');
    if (!container) return;
    container.appendChild(createElement('p', {
      className: 'interrupted-msg',
      textContent: 'Response interrupted \u2014 try again.',
    }));
    scrollChatToBottom();
  }

  function scrollChatToBottom() {
    const panel = $('#tab-chat');
    if (panel) panel.scrollTop = panel.scrollHeight;
  }

  // ── Save as zettel ───────────────────────────────────────────────────

  async function saveAsZettel(content, sourceUrl) {
    try {
      const resp = await fetch(BASE_URL + '/api/zettels/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          source_url: sourceUrl,
          bloom_level: 'remember',
        }),
      });
      if (!resp.ok) throw new Error('' + resp.status);
      showToast('Saved to Knowledge Hub');
    } catch (err) {
      showToast('Save failed \u2014 try again', 'error');
    }
  }

  // ── Skeleton loading ─────────────────────────────────────────────────

  function showSkeleton(container) {
    if (!container) return;
    container.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const card = createElement('div', { className: 'skeleton-card', 'aria-hidden': 'true' });
      card.appendChild(createElement('div', { className: 'skeleton-line w-full' }));
      card.appendChild(createElement('div', { className: 'skeleton-line w-3-4' }));
      card.appendChild(createElement('div', { className: 'skeleton-line w-1-2' }));
      container.appendChild(card);
    }
  }

  // ── Error states ─────────────────────────────────────────────────────

  function showTabError(container, msg, retryFn) {
    if (!container) return;
    container.innerHTML = '';

    const wrapper = createElement('div', { className: 'tab-error' });
    wrapper.appendChild(createElement('p', { className: 'tab-error-text', textContent: msg }));
    wrapper.appendChild(createElement('button', {
      className: 'retry-btn',
      textContent: 'Retry',
      onClick: function () {
        if (typeof retryFn === 'function') retryFn();
      },
    }));
    container.appendChild(wrapper);
  }

  function showError(msg) {
    const overlay = $('#error-overlay');
    const msgEl = $('#error-message');
    const retryBtn = $('#error-retry-btn');
    if (!overlay || !msgEl) return;

    msgEl.textContent = msg;
    overlay.hidden = false;

    if (retryBtn) {
      retryBtn.onclick = () => {
        overlay.hidden = true;
        init();
      };
    }
  }

  // ── Toast ────────────────────────────────────────────────────────────

  function showToast(msg, type) {
    const container = $('#toast-container');
    if (!container) return;

    const toast = createElement('div', {
      className: 'toast' + (type === 'error' ? ' toast-error' : ''),
      textContent: msg,
    });
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-fade');
      setTimeout(() => {
        if (toast.parentNode) toast.remove();
      }, 300);
    }, 2500);
  }

  // ── Start ────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', init);
})();
