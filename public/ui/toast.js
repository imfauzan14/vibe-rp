// Toasts: one implementation for the whole app.
//
// Contract
//   - `createToastHost({ root })` mounts a single `.rp-toast-region`
//     (`role="status"`, `aria-live="polite"`) inside `root` and returns
//     `{ toast, dismiss, destroy }`. The region is created once; every later
//     call reuses it, so the live region is stable for screen readers.
//   - `toast(message, { tone, duration, action, onExpire })` returns a dismiss
//     function. `tone` is `"info"` (default), `"success"` or `"danger"`.
//     `action` is `{ label, onSelect }` for a single inline control such as
//     Undo; an action toast renders NO generic close control, because the
//     action and the window are its only, deliberate exits. `onExpire` runs
//     once, when that window closes the toast.
//   - Messages are set with textContent. A toast never renders markup.
//   - Errors stay until dismissed; everything else auto-dismisses. Under
//     `prefers-reduced-motion` the entrance transition is skipped.
//
// Exports
//   createToastHost(options) -> { toast, dismiss, destroy, region }
//   createNotifier(options)  -> { toast, setStatus, clear, region }  (chat adapter)

const DEFAULT_DURATION = 3500;
const ERROR_DURATION = 8000;
const MAX_VISIBLE = 4;

function prefersReducedMotion() {
  try {
    return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  } catch (_) {
    return false;
  }
}

/**
 * Normalises every toast entry point to one `showToast(message, tone)` shape.
 * Accepts a notifier (`{ toast }`), a toast host (`{ toast }`), or a legacy
 * bare function `(msg, tone)`, so callers never branch on which they were
 * handed.
 */
export function toastAdapter(source) {
  return (message, tone = "info") => {
    if (typeof source === "function") return source(message, tone);
    if (source && typeof source.toast === "function") return source.toast(message, { tone });
    return undefined;
  };
}

/**
 * Mounts the toast region inside `root` (defaults to document.body).
 * Returns an object with `toast`, `dismiss` and `destroy`.
 */
export function createToastHost({ root = document.body, region: provided = null } = {}) {
  let region = provided || root.querySelector(":scope > .rp-toast-region");
  if (!region) {
    region = document.createElement("div");
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "false");
    root.appendChild(region);
  }
  region.setAttribute("data-rp-keep-active", "");


  const live = new Map();

  function remove(id) {
    const entry = live.get(id);
    if (!entry) return;
    live.delete(id);
    clearTimeout(entry.timer);
    entry.node.remove();
  }

  /* The toast's own window closed it. This is the one exit that must also
     settle the caller's deferred work, so `onExpire` runs here and nowhere
     else: a programmatic dismiss or a destroy stays silent. */
  function expire(id) {
    const entry = live.get(id);
    if (!entry) return;
    remove(id);
    try {
      Promise.resolve(entry.onExpire?.()).catch(() => {
        /* a deferred commit must not surface as an unhandled rejection */
      });
    } catch (_) {
      /* a commit handler must not throw into the timer path */
    }
  }

  function dismiss(id) {
    remove(id);
  }

  function toast(message, { tone = "info", duration, action = null, onExpire = null } = {}) {
    const text = String(message ?? "").trim();
    if (!text) return () => {};

    const hasAction = Boolean(action && action.label);

    // Drop the oldest toast that carries NO action when the stack is full, so
    // a burst cannot bury the page. An action toast is never the victim: its
    // window is the reader's only chance to take the action back, so a full
    // stack may exceed MAX_VISIBLE rather than silently foreclose an Undo.
    if (live.size >= MAX_VISIBLE) {
      for (const [victimId, entry] of live) {
        if (!entry.hasAction) {
          remove(victimId);
          break;
        }
      }
    }

    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const node = document.createElement("div");
    node.className = "rp-toast";
    if (tone === "danger") node.classList.add("rp-toast--danger");
    else if (tone === "success") node.classList.add("rp-toast--success");
    if (tone === "danger") node.setAttribute("role", "alert");

    const label = document.createElement("span");
    label.className = "rp-toast__message";
    label.textContent = text;
    node.appendChild(label);

    if (hasAction) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "rp-btn rp-btn--ghost rp-btn--sm rp-toast__action";
      button.textContent = String(action.label);
      button.addEventListener("click", () => {
        remove(id);
        try {
          action.onSelect?.();
        } catch (_) {
          /* an undo handler must not throw into the click path */
        }
      });
      node.appendChild(button);
    } else {
      // No action to foreclose, so a plain dismissal is safe.
      const close = document.createElement("button");
      close.type = "button";
      close.className = "rp-btn rp-btn--ghost rp-btn--sm rp-toast__close";
      close.setAttribute("aria-label", "Dismiss notification");
      close.textContent = "\u00d7";
      close.addEventListener("click", () => remove(id));
      node.appendChild(close);
    }

    if (prefersReducedMotion()) node.classList.add("is-shown");
    region.appendChild(node);

    const ms = duration ?? (tone === "danger" ? ERROR_DURATION : DEFAULT_DURATION);
    const timer = ms > 0 ? setTimeout(() => expire(id), ms) : 0;
    live.set(id, { node, timer, hasAction, onExpire });

    if (!prefersReducedMotion()) {
      requestAnimationFrame(() => node.classList.add("is-shown"));
    }
    return () => remove(id);
  }

  function destroy() {
    for (const id of Array.from(live.keys())) remove(id);
    region.remove();
  }

  return { toast, dismiss, destroy, region };
}

/**
 * Chat-surface adapter over the shared host. Preserves the notifier shape the
 * chat page already consumes: `{ toast, setStatus, clear, region }`.
 *
 *   toast(message, { tone, duration, actionLabel, onAction, onExpire })
 *     -> { dismiss() }   ("error" maps to the shared danger style)
 *   setStatus(message)   writes the polite status line, when one was given
 *   clear()              empties the region and the status line
 *
 * The toast's lifetime IS the caller's window: there is no separate grace
 * period, so an action toast can never outlive the deadline it announces.
 * `onExpire` fires once, when that window closes the toast.
 */
export function createNotifier({ region, status = null } = {}) {
  if (!region) throw new Error("createNotifier needs a toast region element");
  const host = createToastHost({ region });

  function toast(message, options = {}) {
    const {
      tone = "info",
      duration = 4200,
      actionLabel = "",
      onAction = null,
      onExpire = null,
    } = options;
    const normalizedTone = tone === "error" ? "danger" : tone;
    // The reader sees the toast for exactly as long as the caller's window.
    // There is deliberately no `persist` option adding a grace period: that
    // grace was the bug, because it kept an Undo control clickable after the
    // action had already committed.
    const dismiss = host.toast(message, {
      tone: normalizedTone,
      duration,
      onExpire,
      action:
        actionLabel && typeof onAction === "function"
          ? { label: actionLabel, onSelect: onAction }
          : null,
    });
    return { dismiss };
  }

  function setStatus(message) {
    if (!status) return;
    status.textContent = String(message ?? "");
  }

  function clear() {
    region.textContent = "";
    setStatus("");
  }

  return { toast, setStatus, clear, region };
}
