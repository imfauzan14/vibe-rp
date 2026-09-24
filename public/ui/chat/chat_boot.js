    import { BrowserChatEngine, estimateTokens as estimateTokensModule } from "../../browser_engine.js";
    import { SessionController, CHOICE_STATUS } from "../../session_controller.js";
    import { formatProse } from "../../message_format.js";
    import { substitutePlaceholders } from "../../text.js";
    import { escapeHtml, escapeAttr } from "../../safe_html.js";
    import { LocalDbQuotaError, LocalDbBlockedError } from "../../local_db.js";

    import { initTheme, getTheme, toggleTheme } from "../theme.js";
    import { createNotifier, toastAdapter } from "../toast.js";
    import { openModal, closeTopModal, topModal, bindDismissable } from "../modal.js";
    import { confirmAction, runWithUndo } from "../confirm.js";
    import { createMessageFeed } from "./message_feed.js";
    import { createComposer } from "./composer.js";
    import { createChoicePanel } from "./choice_panel.js";
    import { createSearch } from "./search.js";
    import { compressImage } from "../image.js";
    import { openSettingsModal } from "../settings/settings_modal.js";

    const $ = (id) => document.getElementById(id);
    const controller = new SessionController();
    const estimateTokens = estimateTokensModule;

    const notifier = createNotifier({ region: $("toast-region"), status: $("turn-status") });
    const showToast = toastAdapter(notifier);
    window.showToast = showToast;

    const urlParams = new URLSearchParams(window.location.search);
    const cardId = urlParams.get("cardId");
    const sessionId = urlParams.get("sessionId");

    const chatFeed = $("chat-feed");
    const chatInner = $("chat-inner");
    const authorInput = $("author-input");
    const sendBtn = $("send-btn");
    const stopBtn = $("stop-btn");

    // Placeholders, resolved before formatting so no {{user}} ever shows.
    function resolvePlaceholders(text) {
      return substitutePlaceholders(text, {
        user: controller.currentPersona?.name || "You",
        char: controller.charName,
      });
    }

    const feed = createMessageFeed({
      mount: chatInner,
      resolve: resolvePlaceholders,
      formatProse,
      estimateTokens,
      onAction: handleMessageAction,
    });

    const NEAR_BOTTOM_PX = 80;
    const isNearBottom = () =>
      chatFeed.scrollHeight - chatFeed.scrollTop - chatFeed.clientHeight <= NEAR_BOTTOM_PX;
    let stickToBottom = true;

    function scrollFeed(behavior = "auto") {
      if (stickToBottom) chatFeed.scrollTo({ top: chatFeed.scrollHeight, behavior });
    }

    function renderFeed() {
      if (chatInner.querySelector(".inline-msg-editor")) return;
      stickToBottom = isNearBottom();
      const messages = controller.activeSession?.messages || [];
      feed.setContext({
        card: controller.activeCard,
        persona: controller.currentPersona,
        charName: controller.charName,
        initialLetter: controller.initialLetter,
      });
      if (!messages.length) {
        feed.renderEmpty({
          title: "Scene ready",
          body: `Silence settles over the scene. Write an opening line to ${controller.charName}.`,
        });
        updateContextStats();
        return;
      }
      feed.setMessages(messages);
      if (stickToBottom) chatFeed.scrollTop = chatFeed.scrollHeight;
      updateContextStats();
    }

    // Message actions. One delegated handler; the message header reveals the tray.
    function findMessage(id) {
      return (controller.activeSession?.messages || []).find((m) => m.id === id) || null;
    }

    async function handleMessageAction(action, msgId, { button } = {}) {
      const msg = findMessage(msgId);
      if (!msg) return;

      if (action === "copy") {
        const text = String(msg.content || "").replace(/<thought[\s\S]*?<\/thought>/i, "").trim();
        try {
          await navigator.clipboard.writeText(text);
          const label = button.textContent;
          button.textContent = "Copied";
          setTimeout(() => { button.textContent = label; }, 1500);
        } catch (_) {
          showToast("Copy failed. Your browser blocked clipboard access.", "error");
        }
        return;
      }

      if (action === "edit") {
        const el = feed.getElement(msgId);
        if (el) openInlineEdit(el, msg);
        return;
      }

      if (action === "delete") {
        const ok = await confirmAction({
          title: "Delete this message?",
          body: "The turn is removed from this chat. This cannot be undone.",
          confirmLabel: "Delete message",
          tone: "danger",
        });
        if (!ok) return;
        const index = controller.activeSession.messages.findIndex((m) => m.id === msgId);
        controller.deleteMessage(msgId);
        await persistOrReport();
        renderFeed();
        renderChoices();
        runWithUndo({
          notifier,
          message: "Message deleted.",
          undo: async () => {
            controller.activeSession.messages.splice(index, 0, msg);
            await persistOrReport();
            renderFeed();
            renderChoices();
          },
        });
        return;
      }

      if (action === "reroll") {
        await rerollLastTurn();
        return;
      }

      if (action === "retry") {
        await retryUnansweredTurn();
        return;
      }

      if (action === "fork") {
        await forkFromMessage(msg);
        return;
      }
    }

    /**
     * Forks the conversation from a message: a new session whose transcript is
     * this conversation up to and including that turn. The original session is
     * left untouched, which keeps both transcripts append-only.
     */
    async function forkFromMessage(msg) {
      const messages = controller.activeSession?.messages || [];
      const idx = messages.findIndex((m) => m.id === msg.id);
      if (idx === -1) return;
      const ok = await confirmAction({
        title: "Fork from this message?",
        body: "A new chat starts with this conversation up to this turn. The current chat is kept as it is.",
        confirmLabel: "Fork conversation",
      });
      if (!ok) return;
      const source = controller.activeSession;
      const forked = {
        id: `sess_${Date.now()}`,
        cardId: source.cardId,
        title: `${source.title || "Chat"} (fork)`,
        messages: messages.slice(0, idx + 1).map((m) => ({ ...m })),
        ledger: source.ledger || "",
        consumed: Number(source.consumed) || 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await controller.db.saveSession(forked);
      controller.sessions.push(forked);
      controller.switchSession(forked);
      renderFeed();
      renderChoices();
      showToast("Forked into a new chat. The original is unchanged.", "success");
      updateContextStats();
    }

    async function persistOrReport() {
      try {
        await controller.saveSession();
      } catch (err) {
        reportStorageError(err);
      }
    }

    function reportStorageError(err) {
      if (err instanceof LocalDbQuotaError) {
        showToast("This browser is out of storage space. Free some space, then try again.", "error");
      } else if (err instanceof LocalDbBlockedError) {
        showToast("Another tab is using an older version of this app. Close it, then reload.", "error");
      } else {
        showToast(`Could not save: ${err.message}`, "error");
      }
    }

    // Inline edit. Saving forks the message; the original text is preserved.
    function openInlineEdit(cardEl, msg) {
      const contentCol = cardEl.querySelector(".rp-message__content");
      if (!contentCol || cardEl.classList.contains("is-editing")) return;
      cardEl.classList.add("is-editing");

      const proseEl = contentCol.querySelector(".rp-message__prose");
      const trayEl = contentCol.querySelector(".rp-message__tray");
      proseEl.hidden = true;
      if (trayEl) trayEl.hidden = true;

      const editor = document.createElement("div");
      editor.className = "inline-msg-editor";
      editor.style.display = "flex";
      editor.style.flexDirection = "column";
      editor.style.gap = "var(--space-2)";
      editor.innerHTML = `
        <label class="visually-hidden" for="inline-edit-${escapeAttr(msg.id)}">Edit message</label>
        <textarea id="inline-edit-${escapeAttr(msg.id)}" class="rp-textarea" rows="4"></textarea>
        <div class="rp-help">Saving keeps the current text as an earlier draft, so nothing is lost.</div>
        <div style="display:flex; gap: var(--space-2); justify-content:flex-end;">
          <button type="button" class="rp-btn rp-btn--ghost rp-btn--md" data-cancel>Cancel</button>
          <button type="button" class="rp-btn rp-btn--primary rp-btn--md" data-save>Save as new draft</button>
        </div>`;
      contentCol.appendChild(editor);
      const textarea = editor.querySelector("textarea");
      textarea.value = msg.content || "";
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);

      const close = () => {
        editor.remove();
        cardEl.classList.remove("is-editing");
        proseEl.hidden = false;
        if (trayEl) trayEl.hidden = false;
      };

      const save = async () => {
        const val = textarea.value.trim();
        if (!val) { close(); return; }
        const revision = controller.editMessage(msg.id, val);
        await persistOrReport();
        close();
        if (revision) feed.updateMessage(revision);
        renderChoices();
        showToast("Saved as a new draft. The earlier text is kept.", "success");
      };

      editor.querySelector("[data-cancel]").addEventListener("click", close);
      editor.querySelector("[data-save]").addEventListener("click", save);
      textarea.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
        else if (e.key === "Escape") { e.preventDefault(); close(); }
      });
    }

    const composer = createComposer({
      root: $("composer"),
      input: authorInput,
      sendButton: sendBtn,
      stopButton: stopBtn,
      statsEl: $("composer-live-stats"),
      personaNameEl: $("composer-persona-name"),
      personaAvatarEl: $("composer-speaker-avatar"),
      estimateTokens,
      onSend: (text) => submitTurn(text),
      onStop: () => stopTurn(),
    });

    // ---------------------------------------------------------------- Choice Mode
    //
    // Choice Mode changes how the reader picks the next turn, never how the
    // conversation is stored or generated. A selected choice is appended as an
    // ordinary user message through the same submit path a typed line uses.
    const choicePanelEl = $("choice-panel");
    const modeSwitchEl = $("mode-switch");
    let mode = "normal";

    const choicePanel = createChoicePanel({
      mount: choicePanelEl,
      onSelect: (id) => selectChoice(id),
      onRegenerate: () => requestChoices(),
      onRetry: () => requestChoices(),
      // Never steal focus on arrival: choices are read in-place, shortcuts work globally
      autoFocus: () => false,
    });

    /** Applies the mode to the chrome. Never touches the transcript. */
    function setMode(next, { persist = true } = {}) {
      mode = next === "choice" ? "choice" : "normal";
      $("composer").dataset.mode = mode;
      for (const btn of modeSwitchEl.querySelectorAll("[data-mode]")) {
        btn.setAttribute("aria-pressed", btn.dataset.mode === mode ? "true" : "false");
      }
      if (persist) {
        try {
          const settings = controller.db.getSettings();
          controller.db.saveSettings({ ...settings, choiceMode: mode });
          controller.settings = controller.db.getSettings();
        } catch (err) {
          console.warn("Could not persist the mode", err);
        }
      }
      if (mode === "choice") {
        restoreChoicesForScene();
      } else {
        renderChoices();
      }
    }

    modeSwitchEl.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-mode]");
      if (btn) setMode(btn.dataset.mode);
    });

    /** Paints the panel from the controller's machine state. */
    function renderChoices() {
      const st = controller.choiceState;
      const hasChoices = mode === "choice" && st.status !== "idle";
      $("composer").dataset.hasChoices = hasChoices ? "true" : "false";
      const isContinuation = Array.isArray(st.choices) && st.choices.length > 0 &&
        st.choices.every((c) => c.type === "continuation" || c.type === "story" || c.type === "narrative");
      const { focusTarget } = choicePanel.render({
        mode,
        status: st.status,
        choices: st.choices,
        error: st.error,
        selectedId: st.selectedId || null,
        isContinuation,
      });
      // Focus only when the panel itself changed state (choices arrived, a turn
      // started) and the reader was not typing.
      if (focusTarget && document.activeElement !== authorInput && !composer.busy) {
        focusTarget.focus?.();
      }
    }

    /**
     * Re-syncs the panel to a scene that just changed (session switch, new
     * chat, restore). A valid persisted set is shown without a request; an
     * empty scene (no assistant turn yet) asks for one; a stale set is dropped.
     */
    function restoreChoicesForScene() {
      if (mode !== "choice") {
        renderChoices();
        return;
      }
      const currentSource = controller.choiceScene();
      if (
        controller.choiceState.status === CHOICE_STATUS.READY &&
        controller.choiceState.sourceId &&
        currentSource &&
        String(currentSource.id) === String(controller.choiceState.sourceId)
      ) {
        renderChoices();
        return;
      }
      const restored = controller.restoreChoices();
      renderChoices();
      // No assistant turn awaiting the player means nothing to base choices on:
      // the panel shows its idle state and the reader can still type. Otherwise,
      // a scene with no restored set earns exactly one request.
      if (restored.status === CHOICE_STATUS.IDLE && controller.choiceScene()) {
        requestChoices();
      }
    }

    /** Asks the controller for a fresh set. Auxiliary: never fails the RP turn. */
    async function requestChoices() {
      if (mode !== "choice") return;
      renderChoices(); // paints `generating` immediately
      await controller.requestChoices({ onState: () => renderChoices() });
      renderChoices();
    }

    /** Selection: claim once, append one user turn, run one generation. */
    async function selectChoice(id) {
      const choice = controller.selectChoice(id);
      if (!choice) return; // not ready, or the set went stale between render and click
      // Paint the acknowledged, disabled state immediately, from the controller,
      // so the click is visibly registered before the reply starts.
      renderChoices();
      await submitTurn(choice.text);
    }

    $("composer").addEventListener("submit", (e) => {
      e.preventDefault();
      if (!composer.busy) submitTurn(authorInput.value.trim());
    });

    // Turn flow. Stop aborts the whole turn, fold included.
    let activeStream = null;

    function setBusy(busy) {
      composer.setBusy(busy);
      if (busy) notifier.setStatus("Writing a reply.");
      else notifier.setStatus("");
    }

    /**
     * Aborts the in-flight turn. The engine rolls its placeholder back, so this
     * only marks the stream as stopped and lets `streamTurn`'s own settle path
     * do the rendering, keeping one owner for the composer state.
     */
    function stopTurn() {
      controller.cancel();
      if (activeStream) activeStream.stopped = true;
      else {
        setBusy(false);
        notifier.setStatus("");
      }
    }

    function describeFailure(err) {
      const raw = String(err?.message || err || "");
      if (err?.name === "AbortError" || /aborted/i.test(raw)) return null;
      if (/\b401\b|unauthor/i.test(raw)) return { text: "The provider rejected the API key. Check it in settings.", retry: true };
      if (/\b429\b|rate limit/i.test(raw)) return { text: "The provider is rate limiting. Wait a moment, then retry.", retry: true };
      if (/\b5\d\d\b|server error/i.test(raw)) return { text: "The provider had a server error. Retry in a moment.", retry: true };
      if (/HTTP \d+/.test(raw)) return { text: `The provider returned ${raw}.`, retry: true };
      if (/quota/i.test(raw)) return { text: "Storage quota exceeded. Free some space, then retry.", retry: false };
      return { text: raw || "The reply failed.", retry: true };
    }

    async function streamTurn(promptHint, { persistPending = true } = {}) {
      setBusy(true);
      stickToBottom = isNearBottom();
      let settledOk = false;
      const streamId = `msg_${Date.now() + 1}`;
      const stream = feed.beginStream(streamId, { autoFollow: stickToBottom });
      const partial = { id: streamId, role: "assistant", content: "", timestamp: Date.now() };
      const turn = { stream, msg: partial, stopped: false };
      activeStream = turn;

      let scrollScheduled = false;
      const follow = () => {
        if (!stickToBottom || scrollScheduled) return;
        scrollScheduled = true;
        requestAnimationFrame(() => {
          scrollFeed();
          scrollScheduled = false;
        });
      };

      try {
        const assistantMsg = await controller.streamResponse(
          promptHint,
          (chunk) => {
            if (typeof chunk !== "string" || !chunk) return;
            partial.content += chunk;
            feed.appendChunk(stream, chunk);
            follow();
          },
          (notice) => {
            showToast(notice, "info");
          },
          { persistPending },
        );
        if (assistantMsg) Object.assign(partial, assistantMsg);
        // A Stop mid-stream may leave the engine having persisted the partial
        // reply; keep it as a real turn rather than throwing the text away.
        feed.settleStream(stream, partial);
        // Reconcile once so tray actions that depend on being the newest turn
        // (the "Retry reply" action on a previously unanswered user turn) are
        // recomputed now that a reply exists.
        renderFeed();
        settledOk = true;
        composer.clearIfMatched(promptHint);
      } catch (err) {
        feed.failStream(stream);
        if (turn.stopped) {
          showToast("Stopped.", "info");
        } else {
          const described = describeFailure(err);
          if (described) {
            notifier.toast(described.text, {
              tone: "error",
              actionLabel: described.retry ? "Retry" : "",
              onAction: described.retry ? () => streamTurn(promptHint, { persistPending }) : null,
            });
          }
        }
        // The controller drops a pending selection when its turn fails, so the
        // panel must be repainted or it would sit in the disabled `submitting`
        // state with no way forward.
        if (mode === "choice") renderChoices();
      } finally {
        activeStream = null;
        setBusy(false);
        updateContextStats();
        // In Choice Mode the panel owns focus after a turn; only the normal
        // composer is refocused, and only on a fine pointer.
        if (mode !== "choice" && window.matchMedia("(pointer: fine)").matches) composer.focus();
      }

      // Choice Mode: a successful turn is exactly when a fresh menu is wanted.
      // This is auxiliary and awaited only for ordering, never for success: a
      // choice failure cannot turn the settled reply into a failed turn.
      if (settledOk && mode === "choice") {
        renderChoices();
        await requestChoices();
      }
    }

    async function submitTurn(text) {
      const value = (text ?? authorInput.value).trim();
      if (!value || composer.busy) return;
      controller.appendMessage({ role: "user", content: value });
      renderFeed();
      await streamTurn(value);
    }

    async function rerollLastTurn() {
      if (composer.busy) return;
      const lastUserPrompt = controller.reroll();
      renderFeed();
      await streamTurn(lastUserPrompt || "[Reroll the scene]");
    }

    /**
     * Re-streams a trailing user turn that never got a reply — its generation
     * failed, or the page closed mid-turn. The turn is already canonical, so
     * nothing is appended: the same text goes back through the ordinary
     * pipeline, which is why the reader never has to retype it.
     */
    async function retryUnansweredTurn() {
      if (composer.busy) return;
      const pending = controller.pendingUserTurn();
      if (!pending) return;
      await streamTurn(pending.content);
    }

    // Context stats and ledger calculation.
    const contextLedger = $("ledger-context");

    const formatK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

    function updateContextStats() {
      const sess = controller.activeSession;
      const request = BrowserChatEngine.describeRequest({
        card: controller.activeCard,
        session: sess || { messages: [], ledger: "", consumed: 1 },
        settings: controller.settings,
        persona: controller.currentPersona,
        agentsContract: controller.currentDirective?.content || controller.settings.agentsContract,
      });
      const b = request.breakdown;
      const window = request.contextWindow;
      const used = request.totalTokens;
      const pct = Math.min(100, Math.round((used / Math.max(1, window)) * 100));
      const row = (key, value) =>
        `<div class="rp-ledger__row"><span class="rp-ledger__key">${key}</span><span class="rp-ledger__value">${value}</span></div>`;
      const excluded = request.excludedSections
        .map((id) => (id === "examples" ? "dialogue examples" : id === "constantLore" ? "constant world lore" : id))
        .join(", ");
      contextLedger.innerHTML = `
        ${row("Effective context", `${formatK(window)} tokens`)}
        ${row("Required static", `${formatK(b.requiredStatic)} tokens`)}
        ${row("Optional static", `${formatK(b.optionalStatic)} tokens`)}
        ${row("Persona", `${formatK(b.persona)} tokens`)}
        ${row("Lore / guidance", `${formatK(b.lore)} tokens`)}
        ${row("Continuity ledger", `${formatK(b.ledger)} tokens${request.ledgerCondensed ? " (condensed)" : ""}`)}
        ${row("History", `${formatK(b.history)} tokens`)}
        ${row("Current input", `${formatK(b.currentInput)} tokens`)}
        ${row("Output allowance", `${formatK(b.output)} tokens`)}
        ${row("Safety margin", `${formatK(b.safetyMargin)} tokens`)}
        <div class="rp-chat__ledger-meter"><div class="rp-ledger__meter"><span style="width:${pct}%"></span></div></div>
        ${row("Used", `${formatK(used)} of ${formatK(window)} tokens`)}
        ${row("Remaining", `${formatK(b.remaining)} tokens`)}
        ${row("Excluded / degraded", excluded || "none")}
        ${request.impossible ? row("Status", "request exceeds the window: raise the context window or shrink the preset") : ""}`;
    }

    // Ledger sheet controls.
    const ledgerSheet = $("ledger-sheet");
    const ledgerBtn = $("toggle-ledger-btn");

    function setLedgerOpen(open) {
      ledgerSheet.hidden = !open;
      ledgerSheet.dataset.open = open ? "true" : "false";
      ledgerBtn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) { updateContextStats(); $("close-ledger-btn").focus(); }
      else ledgerBtn.focus();
    }
    ledgerBtn.addEventListener("click", () => setLedgerOpen(ledgerSheet.dataset.open !== "true"));
    $("close-ledger-btn").addEventListener("click", () => setLedgerOpen(false));

    // Escape and a click outside the sheet both dismiss it. The toggle button
    // is exempt so its own click does not dismiss-then-reopen in one gesture.
    bindDismissable({
      element: ledgerSheet,
      isOpen: () => ledgerSheet.dataset.open === "true" && !ledgerSheet.hidden,
      onDismiss: () => setLedgerOpen(false),
      trigger: ledgerBtn,
    });

    // In-chat search panel wiring.
    const searchPanel = $("chat-search");
    const searchInput = $("chat-search-input");
    const search = createSearch({
      input: searchInput,
      container: chatInner,
      countEl: $("chat-search-count"),
      root: searchPanel,
      onChange: (msg) => notifier.setStatus(msg),
    });

    function setSearchOpen(open) {
      searchPanel.dataset.open = open ? "true" : "false";
      $("toggle-search-btn").setAttribute("aria-expanded", open ? "true" : "false");
      if (open) searchInput.focus();
      else { search.clear(); $("toggle-search-btn").focus(); }
    }
    $("toggle-search-btn").addEventListener("click", () => setSearchOpen(searchPanel.dataset.open !== "true"));
    $("chat-search-next").addEventListener("click", () => search.next());
    $("chat-search-prev").addEventListener("click", () => search.prev());
    $("chat-search-close").addEventListener("click", () => setSearchOpen(false));

    // Dialogs: native <dialog> handles focus trap and Escape. The history
    // modal is page-owned static markup; the settings modal and both editors
    // are built and owned by ui/settings/settings_modal.js, so they are not
    // in this map.
    const dialogs = {
      history: $("history-modal"),
    };
    // The shared modal controller owns the visible stack, focus, the backdrop
    // and Escape. The page mirrors the top of that stack into the controller.
    const nameOf = (el) => Object.keys(dialogs).find((key) => dialogs[key] === el) || null;
    // Payloads are remembered per name so returning to an outer dialog restores
    // that dialog's own payload rather than inheriting the inner one.
    const payloads = new Map();

    function syncModalName() {
      const top = topModal();
      const name = top ? nameOf(top) : null;
      if (name) controller.openModal(name, payloads.get(name) ?? null);
      else controller.closeModal();
    }

    function openDialog(name, payload = null) {
      const el = dialogs[name];
      if (!el) return;
      payloads.set(name, payload);
      controller.openModal(name, payload);
      openModal({
        element: el,
        trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null,
        // Any close path (Escape, backdrop, Close button, a save) lands here,
        // so the controller always names the dialog that is still open.
        onClose: () => syncModalName(),
      });
    }

    function closeDialog() {
      closeTopModal();
    }

    function openHistoryModal() {
      openDialog("history");
      renderHistoryThreads();
    }
    $("toggle-context-drawer-btn").addEventListener("click", openHistoryModal);
    $("close-history-modal-btn").addEventListener("click", closeDialog);
    $("close-history-modal-btn-2").addEventListener("click", closeDialog);

    $("history-manage-personas-btn").addEventListener("click", () => { closeDialog(); openSettingsPopup("settings-personas-tab"); });
    $("history-manage-directives-btn").addEventListener("click", () => { closeDialog(); openSettingsPopup("settings-system-prompts-tab"); });

    // History threads modal rendering.
    async function renderHistoryThreads() {
      controller.sessions = await controller.db.getSessionsForCard(controller.activeCard.id);
      const list = $("history-threads-list");
      list.textContent = "";
      if (!controller.sessions.length) {
        list.innerHTML = `<p class="rp-help">No saved chats for this character yet. Start one with New chat.</p>`;
        return;
      }
      for (const sess of controller.sessions) {
        const row = document.createElement("div");
        row.className = "rp-card";
        row.setAttribute("role", "listitem");
        row.style.padding = "var(--space-3)";
        row.style.marginBottom = "var(--space-2)";
        const active = sess.id === controller.activeSession.id;
        const count = sess.messages?.length || 0;
        const date = sess.updatedAt ? new Date(sess.updatedAt).toLocaleDateString([], { month: "short", day: "numeric" }) : "";
        row.innerHTML = `
          <div class="rp-card__head">
            <div class="rp-card__heading">
              <span class="rp-card__title" style="font-size: var(--text-base);">${escapeHtml(sess.title || "Untitled chat")}</span>
              <span class="rp-card__byline">${count} ${count === 1 ? "message" : "messages"} ${date ? `on ${escapeHtml(date)}` : ""}</span>
            </div>
            <div class="rp-card__actions">
              <button type="button" class="rp-btn rp-btn--ghost rp-btn--sm" data-rename>Rename</button>
              ${controller.sessions.length > 1 ? `<button type="button" class="rp-btn rp-btn--danger-ghost rp-btn--sm" data-delete>Delete</button>` : ""}
              ${active ? `<span class="rp-badge rp-badge--annotation">Active</span>` : `<button type="button" class="rp-btn rp-btn--secondary rp-btn--sm" data-switch>Switch</button>`}
            </div>
          </div>`;

        row.querySelector("[data-switch]")?.addEventListener("click", () => {
          controller.switchSession(sess);
          renderFeed();
          closeDialog();
          restoreChoicesForScene();
          showToast(`Switched to ${sess.title}.`, "info");
        });
        row.querySelector("[data-rename]")?.addEventListener("click", () => enterThreadRename(sess, row));
        row.querySelector("[data-delete]")?.addEventListener("click", async () => {
          const ok = await confirmAction({
            title: "Delete this chat?",
            body: `"${sess.title}" and its messages are removed.`,
            confirmLabel: "Delete chat",
            tone: "danger",
          });
          if (!ok) return;
          await controller.db.deleteSession(sess.id);
          controller.sessions = controller.sessions.filter((s) => s.id !== sess.id);
          if (controller.activeSession.id === sess.id) {
            if (!controller.sessions.length) { window.location.href = "./"; return; }
            controller.activeSession = controller.sessions[0];
            renderFeed();
          }
          renderHistoryThreads();
          showToast("Chat deleted.", "info");
        });
        list.appendChild(row);
      }
    }

    function enterThreadRename(sess, row) {
      const titleEl = row.querySelector(".rp-card__title");
      const oldTitle = sess.title || "";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "rp-input";
      input.value = oldTitle;
      input.maxLength = 80;
      input.setAttribute("aria-label", "Rename chat");
      titleEl.replaceWith(input);
      input.focus();
      input.select();
      let settled = false;
      const finish = async (save) => {
        if (settled) return;
        settled = true;
        const next = (save ? input.value.trim() : oldTitle) || "Untitled chat";
        sess.title = next;
        sess.updatedAt = Date.now();
        if (sess.id === controller.activeSession.id) {
          controller.activeSession.title = next;
        }
        await controller.db.saveSession(sess);
        renderHistoryThreads();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      });
      input.addEventListener("blur", () => finish(true));
    }

    $("history-new-scene-btn").addEventListener("click", async () => {
      await controller.createSession({ title: `Chat ${controller.sessions.length + 1}` });
      renderFeed();
      closeDialog();
      restoreChoicesForScene();
      showToast("New chat started.", "success");
    });

    // Settings surface. The chat page mounts the SAME modal as the library
    // (ui/settings/settings_modal.js) instead of carrying its own copy, so
    // engine, parameters, personas and directives have one implementation and
    // one source of truth. The library-only session-import block is omitted
    // here because no `saveSession` handler is passed.
    const toastHost = { toast: (msg, opts) => showToast(msg, opts?.tone) };
    const confirmPreset = async (kind, label) => {
      const noun = kind === "persona" ? "persona" : "prompt";
      return confirmAction({
        title: `Delete this ${noun}?`,
        body: `"${label}" is removed.`,
        confirmLabel: `Delete ${noun}`,
        tone: "danger",
      });
    };

    let settingsModal = null;
    function openSettingsPopup(tabId = null) {
      if (settingsModal) return settingsModal;
      controller.openModal("settings");
      settingsModal = openSettingsModal({
        host: toastHost,
        tab: tabId,
        confirm: confirmPreset,
        compressImage,
        getSettings: () => controller.db.getSettings(),
        saveSettings: (patch) => {
          const next = { ...controller.db.getSettings(), ...patch };
          controller.db.saveSettings(next);
          controller.settings = next;
          updateContextStats();
          window.dispatchEvent(new CustomEvent("settings-saved", { detail: next }));
        },
        fetchModels: ({ endpoint, key }) => BrowserChatEngine.fetchAvailableModels(endpoint, key),
        listPersonas: () => controller.db.getAllPersonas(),
        savePersona: (p) => controller.db.savePersona(p),
        deletePersona: (id) => controller.db.deletePersona(id),
        setDefaultPersona: (id) => controller.db.setDefaultPersona(id),
        listDirectives: () => controller.db.getAllDirectives(),
        saveDirective: (d) => controller.db.saveDirective(d),
        deleteDirective: (id) => controller.db.deleteDirective(id),
        setDefaultDirective: (id) => controller.db.setDefaultDirective(id),
        onDataChanged: async () => {
          if (cardId) {
            try {
              await controller.loadCard(cardId);
            } catch (e) {
              console.warn("Could not reload card after data change", e);
            }
          }
          renderFeed();
          updateContextStats();
          refreshPresets();
        },
        onClose: () => {
          settingsModal = null;
          controller.closeModal();
          refreshPresets();
        },
      });
      return settingsModal;
    }

    $("toggle-settings-btn").addEventListener("click", () => openSettingsPopup());

    // Persona and directive presets sync.
    $("history-persona-select").addEventListener("change", async (e) => {
      await controller.setCardPersona(e.target.value);
      await refreshPresets();
      renderFeed();
    });
    $("history-directive-select").addEventListener("change", async (e) => {
      await controller.setCardDirective(e.target.value);
      await refreshPresets();
      updateContextStats();
    });

    async function refreshPresets() {
      await controller.refreshPresets();
      const allPersonas = await controller.db.getAllPersonas();
      const defPersona = await controller.db.getDefaultPersona();
      const personaSelect = $("history-persona-select");
      personaSelect.innerHTML =
        `<option value="">Global default (${escapeHtml(defPersona.name)})</option>` +
        allPersonas.map((p) => `<option value="${escapeAttr(p.id)}">${escapeHtml(p.name)}${p.isDefault ? " (global)" : ""}</option>`).join("");
      personaSelect.value = controller.activeCard.userPersonaId || controller.activeCard.data?.userPersonaId || "";

      const allDirectives = await controller.db.getAllDirectives();
      const defDirective = await controller.db.getDefaultDirective();
      const directiveSelect = $("history-directive-select");
      directiveSelect.innerHTML =
        `<option value="">Global default (${escapeHtml(defDirective.name)})</option>` +
        allDirectives.map((d) => `<option value="${escapeAttr(d.id)}">${escapeHtml(d.name)}${d.isDefault ? " (global)" : ""}</option>`).join("");
      directiveSelect.value = controller.activeCard.directivePresetId || controller.activeCard.data?.directivePresetId || "";

      composer.setPersona({ name: controller.currentPersona?.name || "You", avatar: controller.currentPersona?.avatar || null });
      updateContextStats();
    }

    function renderHudCharacter() {
      // The top bar no longer carries the character's identity. The document
      // title is its home now, so a reader still sees who they are talking to.
      document.title = `${controller.charName} - Chat`;
    }

    window.addEventListener("settings-saved", (e) => {
      controller.settings = e.detail;
      updateContextStats();
    });

    // Re-apply stored theme once module runs. theme-boot.js handles pre-paint,
    // and initTheme reconciles if storage was blocked.
    initTheme();

    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && !e.shiftKey) {
        if (controller.openModalName) return;
        e.preventDefault();
        setSearchOpen(true);
      }
    });

    // Boot.
    let booted = false;
    try {
      await controller.init(cardId, sessionId);
      booted = true;
    } catch (err) {
      booted = false;
      renderBootFailure(err);
    }

    function renderBootFailure(err) {
      const blocked = err instanceof LocalDbBlockedError;
      feed.renderEmpty({
        title: blocked ? "This app is open in another tab" : "No character to chat with",
        body: blocked
          ? "Close the other tab or window using this app, then reload this page."
          : "Import a character card in the library first, then open a chat from there.",
        actionLabel: "Go to the library",
        onAction: () => { window.location.href = "./"; },
      });
      // No character to talk to: disable the dock honestly instead of leaving
      authorInput.disabled = true;
      sendBtn.disabled = true;
      stopBtn.hidden = true;
      if (!blocked) console.warn("Chat boot failed:", err);
    }

    if (booted) {
      renderHudCharacter();
      await refreshPresets();
      renderFeed();

      // Choice Mode is a persisted preference, restored before the first paint
      // of the panel. `persist: false` because it is already in storage;
      // `setMode` restores any valid pending set without a request.
      const storedMode = controller.settings?.choiceMode === "choice" ? "choice" : "normal";
      setMode(storedMode, { persist: false });

      if (window.visualViewport) {
        let scheduled = false;
        const syncHeight = () => {
          scheduled = false;
          const vv = window.visualViewport;
          const isPinchZoom = vv.scale > 1.01;
          const editing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
          if (isPinchZoom || !editing) {
            document.documentElement.style.removeProperty("--app-height");
          } else {
            document.documentElement.style.setProperty("--app-height", `${vv.height}px`);
          }
        };
        const onChange = () => {
          if (!scheduled) {
            scheduled = true;
            requestAnimationFrame(syncHeight);
          }
        };
        window.visualViewport.addEventListener("resize", onChange);
        window.visualViewport.addEventListener("scroll", onChange);
        syncHeight();
      }

      chatFeed.addEventListener("scroll", () => {
        stickToBottom = isNearBottom();
      }, { passive: true });

      if ("serviceWorker" in navigator && window.isSecureContext) {
        try { navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => {}); } catch (_) {}
      }

      // Expose a tiny seam for the verification harness. Read-only.
      window.__chat = {
        get messages() { return controller.activeSession?.messages || []; },
        get session() { return controller.activeSession; },
        get busy() { return composer.busy; },
        get theme() { return getTheme(); },
        get mode() { return mode; },
        get choices() { return controller.choiceState.choices.map((c) => ({ ...c })); },
        get choiceStatus() { return controller.choiceState.status; },
        selectChoice: (id) => selectChoice(id),
        regenerateChoices: () => requestChoices(),
        setMode: (m) => setMode(m),
        toggleTheme,
        stop: () => stopTurn(),
      };
    }
