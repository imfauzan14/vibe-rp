// Keyed, append-only message feed.
//
// Two jobs:
//   1. Reconcile the DOM by message id instead of rebuilding it, so an open
//      inline editor, a focused control, and scroll position all survive.
//   2. During streaming, format ONLY the newly settled tail. The whole reply
//      is re-parsed exactly once, when the turn settles. Re-parsing the full
//      accumulated text per chunk is quadratic and was the old hot path.
//
// The incremental rule: content is split at blank lines. Everything up to the
// last blank line is "settled" and is formatted once, then appended as DOM.
// Only the trailing partial paragraph is re-formatted on each chunk, and that
// is bounded by one paragraph regardless of how long the reply gets.

import { escapeHtml, escapeAttr } from "../../safe_html.js";

const MAX_RENDERED = 60;
const RENDER_STEP = 40;

export function createMessageFeed({
  mount,
  resolve = (t) => t,
  formatProse,
  estimateTokens = () => 0,
  onAction = () => {},
}) {
  if (!mount) throw new Error("createMessageFeed needs a mount element");
  if (typeof formatProse !== "function") throw new Error("createMessageFeed needs formatProse");

  const nodes = new Map(); // msg id -> element
  let context = { card: null, persona: null, charName: "Character", initialLetter: "C" };
  let windowSize = MAX_RENDERED;
  let lastMessages = [];

  // --- small helpers -------------------------------------------------------

  const safeId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
  const timeText = (ts) =>
    ts ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

  function avatarHtml(isUser) {
    const persona = context.persona;
    const card = context.card;
    const url = isUser ? persona?.avatar : card?.avatar || card?.data?.avatar;
    if (url && (url.startsWith("data:") || url.startsWith("http"))) {
      return `<img src="${escapeAttr(url)}" alt="" style="width:100%;height:100%;object-fit:cover;">`;
    }
    if (isUser) return escapeHtml(persona?.name ? persona.name.charAt(0).toUpperCase() : "U");
    return escapeHtml(context.initialLetter);
  }

  function speakerName(isUser) {
    return isUser ? context.persona?.name || "You" : context.charName;
  }

  /** The token figure reads inline in the header, never behind a press. */
  function tokenMetaHtml(tokens) {
    if (typeof tokens !== "number") return "";
    return `<span class="rp-message__tokens rp-tnum" title="Estimated tokens">~${tokens.toLocaleString()} tokens</span>`;
  }

  /** Earlier drafts are a figure, not a disclosure: they read inline too. */
  function forkMetaHtml(forks) {
    if (!forks) return "";
    return `<span class="rp-message__forks rp-tnum" title="Earlier drafts kept">${forks} draft${forks === 1 ? "" : "s"}</span>`;
  }

  function trayHtml(msg, opts) {
    const { showDelete, showReroll, showFork } = opts;
    const id = safeId(msg.id);
    const btns = [];
    btns.push(`<button type="button" class="rp-btn rp-btn--ghost rp-btn--sm" data-action="copy" data-msg-id="${escapeAttr(msg.id)}">Copy</button>`);
    btns.push(`<button type="button" class="rp-btn rp-btn--ghost rp-btn--sm" data-action="edit" data-msg-id="${escapeAttr(msg.id)}">Edit</button>`);
    if (showFork) btns.push(`<button type="button" class="rp-btn rp-btn--ghost rp-btn--sm" data-action="fork" data-msg-id="${escapeAttr(msg.id)}">Fork from here</button>`);
    if (showReroll) btns.push(`<button type="button" class="rp-btn rp-btn--ghost rp-btn--sm" data-action="reroll" data-msg-id="${escapeAttr(msg.id)}">Reroll</button>`);
    if (showDelete) btns.push(`<button type="button" class="rp-btn rp-btn--danger-ghost rp-btn--sm" data-action="delete" data-msg-id="${escapeAttr(msg.id)}">Delete</button>`);
    return `
      <div class="rp-message__tray" id="tray-${id}" data-open="false" role="group" aria-label="Message actions">
        ${btns.join("")}
      </div>`;
  }

  function extractThoughts(content, defaultCharName = "Character") {
    if (!content) return { prose: "", thoughts: [] };
    const regex = /(?:<thought(?:\s+character="([^"]*)")?>([\s\S]*?)<\/thought>|<think>([\s\S]*?)<\/think>)/gi;
    const thoughts = [];
    let match;
    while ((match = regex.exec(content)) !== null) {
      const who = match[1] || defaultCharName;
      const body = (match[2] !== undefined ? match[2] : match[3] || "").trim();
      if (body) thoughts.push({ who, body });
    }
    const prose = content.replace(/(?:<thought[\s\S]*?<\/thought>|<think>[\s\S]*?<\/think>)/gi, "").trim();
    return { prose, thoughts };
  }

  function thoughtDrawerHtml(thoughts, msgId) {
    if (!thoughts || !thoughts.length) return "";
    const id = safeId(msgId);
    const sections = thoughts.map((t) => `
      <div class="rp-thought__item">
        <div class="rp-thought__summary">${escapeHtml(t.who)}'s thought</div>
        <div class="rp-thought__body">${formatProse(t.body)}</div>
      </div>
    `).join("");
    return `
      <div class="rp-thought" id="thought-${id}" hidden role="region" aria-label="Character inner thoughts">
        ${sections}
      </div>`;
  }

  function thoughtPillHtml(thoughts, msgId) {
    if (!thoughts || !thoughts.length) return "";
    const id = safeId(msgId);
    const label = thoughts.length === 1 && thoughts[0].who && thoughts[0].who !== "Character" && thoughts[0].who !== context.charName
      ? `💭 ${escapeHtml(thoughts[0].who)}`
      : thoughts.length > 1
        ? `💭 Thoughts (${thoughts.length})`
        : "💭 Thought";
    return `<button type="button" class="rp-thought-pill" data-action="toggle-thought" data-target="thought-${id}" aria-expanded="false" aria-controls="thought-${id}" title="Toggle character inner thoughts">${label}</button>`;
  }

  // --- element construction ------------------------------------------------

  function buildMessage(msg, opts) {
    const isUser = msg.role === "user";
    const id = safeId(msg.id);
    const el = document.createElement("article");
    el.className = `rp-message ${isUser ? "rp-message--user" : "rp-message--assistant"}`;
    el.dataset.msgId = msg.id;

    const resolved = resolve(msg.content || "");
    const { prose, thoughts } = extractThoughts(resolved, context.charName);
    const pill = thoughtPillHtml(thoughts, msg.id);
    const drawer = thoughtDrawerHtml(thoughts, msg.id);

    el.innerHTML = `
      <div class="rp-message__rail">
        <div class="rp-avatar rp-avatar--md ${isUser ? "rp-avatar--user" : ""}">${avatarHtml(isUser)}</div>
      </div>
      <div class="rp-message__content">
        <div class="rp-message__head" data-controls="tray-${id}">
          <button type="button" class="rp-message__title" aria-expanded="false" aria-controls="tray-${id}" title="Message actions">
            <span class="rp-message__speaker">${escapeHtml(speakerName(isUser))}</span>
          </button>
          <span class="rp-message__meta"><span class="rp-message__time rp-tnum">${escapeHtml(timeText(msg.timestamp))}</span>${pill}${tokenMetaHtml(estimateTokens(msg.content || ""))}</span>
        </div>
        ${drawer}
        <div class="rp-message__prose" id="prose-${id}">${formatProse(prose)}</div>
        ${trayHtml(msg, opts)}
      </div>`;
    return el;
  }

  // --- reconciliation ------------------------------------------------------

  function signatureOf(msg) {
    return `${(msg.content || "").length}:${(msg.forks || []).length}:${msg.timestamp || 0}`;
  }

  function reconcile(messages) {
    const total = messages.length;
    const start = Math.max(0, total - windowSize);
    const visible = messages.slice(start);

    // Drop nodes whose ids are gone, or that fell out of the rendered window.
    const keep = new Set(visible.map((m) => String(m.id)));
    for (const [id, el] of nodes) {
      if (!keep.has(id)) {
        el.remove();
        nodes.delete(id);
      }
    }

    // Build or reuse one element per visible message, in order. A fork or an
    // inline edit keeps the id but changes the text, so the cached node is
    // rebuilt when its signature moves.
    const ordered = visible.map((msg, i) => {
      const id = String(msg.id);
      const isLastAssistant = msg.role !== "user" && start + i === total - 1;
      const opts = {
        showDelete: total > 1,
        showReroll: isLastAssistant,
        showFork: total > 1,
      };
      let el = nodes.get(id);
      if (el && el.dataset.sig !== signatureOf(msg)) {
        const fresh = buildMessage(msg, opts);
        el.replaceWith(fresh);
        el = fresh;
        nodes.set(id, el);
      } else if (!el) {
        el = buildMessage(msg, opts);
        nodes.set(id, el);
      }
      el.dataset.sig = signatureOf(msg);
      return el;
    });

    // The "show earlier" header exists only while the rendered window is capped.
    let more = mount.querySelector(".rp-feed-more");
    if (start > 0) {
      if (!more) {
        more = document.createElement("div");
        more.className = "rp-feed-more";
        more.innerHTML = `<button type="button" class="rp-btn rp-btn--ghost rp-btn--sm"></button>`;
        more.querySelector("button").addEventListener("click", () => {
          windowSize += RENDER_STEP;
          reconcile(lastMessages);
        });
      }
      more.querySelector("button").textContent =
        `Show ${start} earlier message${start === 1 ? "" : "s"}`;
    } else {
      more = null;
    }

    // Walk the mount once, moving each wanted node into place and deleting
    // whatever is left over. Nodes already in position are left alone.
    let cursor = mount.firstChild;
    const place = (el) => {
      if (cursor === el) {
        cursor = cursor.nextSibling;
        return;
      }
      mount.insertBefore(el, cursor);
    };
    if (more) place(more);
    for (const el of ordered) place(el);
    while (cursor) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
  }

  // --- public API ----------------------------------------------------------

  function setContext(ctx) {
    context = { ...context, ...ctx };
  }

  function setMessages(messages, ctx = {}) {
    setContext(ctx);
    lastMessages = messages || [];
    if (!lastMessages.length) {
      clear();
      return;
    }
    reconcile(lastMessages);
  }

  function clear() {
    nodes.clear();
    mount.textContent = "";
  }

  function renderEmpty({ title, body, actionLabel, onAction: cb }) {
    clear();
    const wrap = document.createElement("div");
    wrap.className = "rp-empty";
    wrap.innerHTML = `
      <h2 class="rp-empty__title">${escapeHtml(title)}</h2>
      <p class="rp-empty__body">${escapeHtml(body)}</p>
      ${actionLabel ? `<button type="button" class="rp-btn rp-btn--primary rp-btn--lg" data-action="empty-continue">${escapeHtml(actionLabel)}</button>` : ""}`;
    wrap.querySelector("[data-action='empty-continue']")?.addEventListener("click", () => cb?.());
    mount.appendChild(wrap);
  }

  // --- streaming -----------------------------------------------------------

  function beginStream(id, { autoFollow = true } = {}) {
    const isUser = false;
    const sid = safeId(id);
    const el = document.createElement("article");
    el.className = "rp-message rp-message--assistant is-streaming";
    el.dataset.msgId = id;
    el.innerHTML = `
      <div class="rp-message__rail">
        <div class="rp-avatar rp-avatar--md">${avatarHtml(isUser)}</div>
      </div>
      <div class="rp-message__content">
        <div class="rp-message__head" data-controls="tray-${sid}">
          <button type="button" class="rp-message__title" aria-expanded="false" aria-controls="tray-${sid}" title="Message actions">
            <span class="rp-message__speaker">${escapeHtml(context.charName)}</span>
          </button>
          <span class="rp-message__meta"><span class="rp-stream-status">Writing</span></span>
        </div>
        <div class="rp-message__prose is-streaming" id="prose-${sid}" role="status" aria-live="polite" aria-busy="true">
          <div class="rp-stream-settled"></div><div class="rp-stream-tail"></div>
        </div>
      </div>`;
    mount.appendChild(el);
    nodes.set(String(id), el);
    return { el, autoFollow, buffer: "", settledAt: 0, settledEl: el.querySelector(".rp-stream-settled"), tailEl: el.querySelector(".rp-stream-tail") };
  }

  /**
   * Formats and appends only what has settled since the last call, then
   * re-formats the single trailing paragraph. Cost per chunk is bounded by the
   * tail length, not by the reply length.
   */
  function appendChunk(stream, chunk) {
    if (!stream || !chunk) return;
    stream.buffer += chunk;

    const hasUnclosedThought = /(?:<thought[^>]*>|<think>)(?![\s\S]*?(?:<\/thought>|<\/think>))/i.test(stream.buffer);
    const statusEl = stream.el.querySelector(".rp-stream-status");
    if (statusEl) {
      if (hasUnclosedThought) {
        if (!statusEl.classList.contains("rp-stream-status--thinking")) {
          statusEl.classList.add("rp-stream-status--thinking");
          statusEl.textContent = "💭 Thinking…";
        }
      } else {
        if (statusEl.classList.contains("rp-stream-status--thinking")) {
          statusEl.classList.remove("rp-stream-status--thinking");
          statusEl.textContent = "Writing";
        }
      }
    }

    const stripped = stream.buffer
      .replace(/<thought[\s\S]*?<\/thought>/gi, "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/(?:<thought[^>]*>|<think>)[\s\S]*$/i, "");

    const boundary = stripped.lastIndexOf("\n\n");
    if (boundary > stream.settledAt) {
      const delta = resolve(stripped.slice(stream.settledAt, boundary + 2));
      if (delta.trim()) stream.settledEl.insertAdjacentHTML("beforeend", formatProse(delta));
      stream.settledAt = boundary + 2;
    }
    const tail = resolve(stripped.slice(stream.settledAt));
    stream.tailEl.innerHTML = tail.trim() ? formatProse(tail) : "";
  }

  /** One full parse at settle: the incremental tail is replaced by the truth. */
  function settleStream(stream, msg) {
    if (!stream) return;
    const el = stream.el;
    el.classList.remove("is-streaming");
    el.querySelector(".rp-stream-status")?.remove();

    const resolved = resolve(msg.content || "");
    const { prose, thoughts } = extractThoughts(resolved, context.charName);
    const proseEl = el.querySelector(".rp-message__prose");
    proseEl.removeAttribute("aria-busy");
    proseEl.removeAttribute("role");
    proseEl.removeAttribute("aria-live");
    proseEl.classList.remove("is-streaming");
    proseEl.innerHTML = formatProse(prose);

    const content = el.querySelector(".rp-message__content");
    const head = content.querySelector(".rp-message__head");
    const drawerHtml = thoughtDrawerHtml(thoughts, msg.id);
    if (drawerHtml) head.insertAdjacentHTML("afterend", drawerHtml);

    const meta = head.querySelector(".rp-message__meta");
    if (meta) {
      meta.querySelector(".rp-message__tokens")?.remove();
      meta.querySelector(".rp-message__forks")?.remove();
      const timeStr = `<span class="rp-message__time rp-tnum">${escapeHtml(timeText(msg.timestamp))}</span>`;
      const pill = thoughtPillHtml(thoughts, msg.id);
      const tokens = tokenMetaHtml(estimateTokens(msg.content || "")) + forkMetaHtml((msg.forks || []).length);
      meta.innerHTML = `${timeStr}${pill}${tokens}`;
    }
    content.insertAdjacentHTML("beforeend", trayHtml(msg, {
      showDelete: true,
      showReroll: true,
      showFork: true,
    }));
    // The provisional stream key is replaced by the real message id, so the
    // next reconcile reuses this node instead of rebuilding it.
    const oldKey = String(el.dataset.msgId);
    el.dataset.msgId = msg.id;
    el.dataset.sig = signatureOf(msg);
    nodes.delete(oldKey);
    nodes.set(String(msg.id), el);
  }

  function failStream(stream) {
    if (!stream) return;
    nodes.delete(String(stream.el.dataset.msgId));
    stream.el.remove();
  }

  function updateMessage(msg) {
    const id = String(msg.id);
    const existing = nodes.get(id);
    const isLastAssistant = lastMessages.length && lastMessages[lastMessages.length - 1].id === msg.id && msg.role !== "user";
    const opts = { showDelete: lastMessages.length > 1, showReroll: isLastAssistant, showFork: lastMessages.length > 1 };
    const fresh = buildMessage(msg, opts);
    if (existing) {
      existing.replaceWith(fresh);
    } else {
      mount.appendChild(fresh);
    }
    nodes.set(id, fresh);
  }

  function removeMessage(id) {
    const el = nodes.get(String(id));
    el?.remove();
    nodes.delete(String(id));
  }

  function getElement(id) {
    return nodes.get(String(id)) || null;
  }

  function getProse(id) {
    return nodes.get(String(id))?.querySelector(".rp-message__prose") || null;
  }

  function scrollToMessage(id, { behavior = "smooth" } = {}) {
    const el = nodes.get(String(id));
    if (!el) return false;
    el.scrollIntoView({ block: "start", behavior });
    return true;
  }

  // --- one delegated listener ---------------------------------------------

  mount.addEventListener("click", (e) => {
    const thoughtBtn = e.target.closest("[data-action='toggle-thought']");
    if (thoughtBtn) {
      const targetId = thoughtBtn.getAttribute("data-target");
      const drawer = targetId ? document.getElementById(targetId) : null;
      if (drawer) {
        const isHidden = drawer.hasAttribute("hidden");
        if (isHidden) {
          drawer.removeAttribute("hidden");
          thoughtBtn.setAttribute("aria-expanded", "true");
          thoughtBtn.classList.add("is-active");
        } else {
          drawer.setAttribute("hidden", "");
          thoughtBtn.setAttribute("aria-expanded", "false");
          thoughtBtn.classList.remove("is-active");
        }
      }
      return;
    }

    const head = e.target.closest(".rp-message__head");
    if (head) {
      const card = head.closest(".rp-message");
      const tray = card?.querySelector(".rp-message__tray");
      const open = tray?.getAttribute("data-open") !== "true";
      tray?.setAttribute("data-open", open ? "true" : "false");
      head.querySelector(".rp-message__title")?.setAttribute("aria-expanded", open ? "true" : "false");
      return;
    }
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const msgId = btn.dataset.msgId;
    const el = btn.closest(".rp-message");
    onAction(action, msgId, { button: btn, element: el });
  });

  return {
    setContext,
    setMessages,
    renderEmpty,
    clear,
    beginStream,
    appendChunk,
    settleStream,
    failStream,
    updateMessage,
    removeMessage,
    getElement,
    getProse,
    scrollToMessage,
    get count() { return nodes.size; },
  };
}
