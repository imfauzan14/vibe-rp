// The chat turn machine.
//
// chat_boot.js is the chat page's composition root: it owns the DOM objects
// (composer, feed, notifier, choice panel, settings) and knows how to render.
// This module owns the *turn lifecycle*: starting a stream, carrying chunks
// into the feed, reconciling the settled reply, stopping, classifying
// failures, and the entry points a page needs (submit, reroll, retry an
// unanswered turn).
//
// The split is deliberate: everything DOM lives in the injected
// collaborators, so this module has no `document` or `window` references at
// module scope. The page supplies callbacks for the two shapes that are its
// own — repainting the feed after a settle, and the Choice Mode side effects
// (repaint when a turn fails, request a fresh set after a settled turn).
// The machine decides *when*; the page decides *what to paint*.
//
// Usage:
//   const machine = createTurnMachine({
//     controller, composer, feed, notifier, showToast,
//     onSettled: () => renderFeed(),
//     onChoiceTurnFailed: () => renderChoices(),   // only in choice mode
//     onChoiceTurnSettled: () => requestChoices(), // only in choice mode
//     isChoiceMode: () => mode === "choice",
//   });
//   await machine.submitTurn(text);

function clockNow() {
  return Date.now();
}

/**
 * Classifies a turn failure for the reader. Returns null when the reply was
 * intentionally stopped (no toast, no retry card), or { text, retry } where
 * `retry` says whether re-running the same turn could succeed.
 */
export function describeFailure(err) {
  const raw = String(err?.message || err || "");
  if (err?.name === "AbortError" || /aborted/i.test(raw)) return null;
  if (/\b401\b|unauthor/i.test(raw)) return { text: "The provider rejected the API key. Check it in settings.", retry: true };
  if (/\b429\b|rate limit/i.test(raw)) return { text: "The provider is rate limiting. Wait a moment, then retry.", retry: true };
  if (/\b5\d\d\b|server error/i.test(raw)) return { text: "The provider had a server error. Retry in a moment.", retry: true };
  if (/HTTP \d+/.test(raw)) return { text: `The provider returned ${raw}.`, retry: true };
  if (/quota/i.test(raw)) return { text: "Storage quota exceeded. Free some space, then retry.", retry: false };
  return { text: raw || "The reply failed.", retry: true };
}

export function createTurnMachine({
  controller,
  composer,
  feed,
  notifier,
  showToast,
  isNearBottom = () => true,
  scrollFeed = () => {},
  requestAnimationFrame = (fn) => fn(),
  matchFinePointer = () => false,
  clearComposerInput = () => {},
  onSettled = () => {},
  onChoiceTurnFailed = () => {},
  onChoiceTurnSettled = async () => {},
  isChoiceMode = () => false,
  onFinally = () => {},
} = {}) {
  if (!controller) throw new Error("createTurnMachine needs a controller");
  if (!composer) throw new Error("createTurnMachine needs a composer");
  if (!feed) throw new Error("createTurnMachine needs a feed");

  // The one turn currently running, or null. Stop aborts the whole turn, fold
  // included; the engine rolls its placeholder back, so the settle path still
  // owns the rendering.
  let activeStream = null;

  function setBusy(busy) {
    composer.setBusy(busy);
    if (notifier && typeof notifier.setStatus === "function") {
      if (busy) notifier.setStatus("Writing a reply.");
      else notifier.setStatus("");
    }
  }

  function stopTurn() {
    controller.cancel();
    if (activeStream) activeStream.stopped = true;
    else {
      setBusy(false);
      if (notifier) notifier.setStatus("");
    }
  }

  async function streamTurn(promptHint, { persistPending = true } = {}) {
    setBusy(true);
    // Stickiness stays owned by the boot (its scrollFeed no-ops unless pinned
    // to the bottom, and its renderFeed re-pins on every paint), so the follow
    // below schedules the page's own scroll — never a shadowed copy.
    const autoFollow = isNearBottom();
    let settledOk = false;
    const streamId = `msg_${clockNow() + 1}`;
    const stream = feed.beginStream(streamId, { autoFollow });
    const partial = { id: streamId, role: "assistant", content: "", timestamp: clockNow() };
    const turn = { stream, msg: partial, stopped: false };
    activeStream = turn;

    let scrollScheduled = false;
    const follow = () => {
      if (scrollScheduled) return;
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
          if (showToast) showToast(notice, "info");
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
      onSettled();
      settledOk = true;
      clearComposerInput(promptHint);
    } catch (err) {
      feed.failStream(stream);
      if (turn.stopped) {
        if (showToast) showToast("Stopped.", "info");
      } else {
        const described = describeFailure(err);
        if (described) {
          if (notifier && typeof notifier.toast === "function") {
            notifier.toast(described.text, {
              tone: "error",
              actionLabel: described.retry ? "Retry" : "",
              onAction: described.retry ? () => streamTurn(promptHint, { persistPending }) : null,
            });
          } else if (showToast) {
            showToast(described.text, "error");
          }
        }
      }
      // The controller drops a pending selection when its turn fails, so the
      // panel must be repainted or it would sit in the disabled `submitting`
      // state with no way forward.
      if (isChoiceMode()) onChoiceTurnFailed();
    } finally {
      activeStream = null;
      setBusy(false);
      onFinally();
      // In Choice Mode the panel owns focus after a turn; only the normal
      // composer is refocused, and only on a fine pointer.
      if (!isChoiceMode() && matchFinePointer()) composer.focus();
    }

    // Choice Mode: a successful turn is exactly when a fresh menu is wanted.
    // This is auxiliary and awaited only for ordering, never for success: a
    // choice failure cannot turn the settled reply into a failed turn.
    if (settledOk && isChoiceMode()) {
      await onChoiceTurnSettled();
    }
  }

  async function submitTurn(text) {
    const value = typeof text === "string" ? text.trim() : "";
    if (!value || composer.busy) return;
    controller.appendMessage({ role: "user", content: value });
    onSettled();
    await streamTurn(value);
  }

  async function rerollLastTurn() {
    if (composer.busy) return;
    const lastUserPrompt = controller.reroll();
    onSettled();
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

  return {
    streamTurn,
    submitTurn,
    rerollLastTurn,
    retryUnansweredTurn,
    stopTurn,
    describeFailure,
    get busy() {
      return activeStream !== null;
    },
  };
}
