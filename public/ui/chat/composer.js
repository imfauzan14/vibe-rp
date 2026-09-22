// The composer dock: input, send/stop state machine, live draft figure.
//
// Behaviour contract:
//   - Enter sends, Shift+Enter inserts a newline.
//   - The textarea grows with its content up to a cap, then scrolls.
//   - While a turn streams, Send is replaced by Stop. The input stays usable so
//     the reader can draft the next line; Stop calls back and always returns the
//     dock to a usable state, so a hung provider cannot brick the composer.
//   - The draft's token figure sits inline in the identity row, always visible,
//     never behind a disclosure.

const MAX_INPUT_PX = 200;

export function createComposer({
  root,
  input,
  sendButton,
  stopButton,
  statsEl = null,
  personaNameEl = null,
  personaAvatarEl = null,
  estimateTokens = () => 0,
  onSend = () => {},
  onStop = () => {},
}) {
  if (!input || !sendButton) throw new Error("createComposer needs an input and a send button");

  let busy = false;

  function resize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, MAX_INPUT_PX)}px`;
  }

  function updateStats() {
    if (!statsEl) return;
    // A compact, always-visible figure: it can never push the send controls.
    statsEl.textContent = `~${estimateTokens(input.value || "").toLocaleString()} tokens`;
  }

  function updateSendState() {
    const hasText = input.value.trim().length > 0;
    sendButton.disabled = busy || !hasText;
    sendButton.setAttribute("aria-disabled", sendButton.disabled ? "true" : "false");
    root?.classList.toggle("has-content", hasText);
  }

  function setBusy(next) {
    const was = busy;
    busy = Boolean(next);
    root?.classList.toggle("is-streaming", busy);
    if (sendButton) sendButton.hidden = busy;
    if (stopButton) stopButton.hidden = !busy;
    updateSendState();
    // Move focus to Stop when a turn starts, but only if the reader is not
    // already typing: stealing focus from the textarea would close a mobile
    // keyboard mid-sentence.
    if (busy && !was && document.activeElement !== input) stopButton?.focus?.();
  }

  function send() {
    if (busy) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    resize();
    updateStats();
    updateSendState();
    onSend(text);
  }

  function setPersona({ name = "You", avatar = null } = {}) {
    if (personaNameEl) personaNameEl.textContent = name;
    if (personaAvatarEl) {
      if (avatar && (avatar.startsWith("data:") || avatar.startsWith("http"))) {
        const img = document.createElement("img");
        img.src = avatar;
        img.alt = "";
        img.style.cssText = "width:100%;height:100%;object-fit:cover;";
        personaAvatarEl.replaceChildren(img);
      } else {
        personaAvatarEl.textContent = (name.charAt(0) || "U").toUpperCase();
      }
    }
    // One short placeholder for every pointer type. The long "Enter to send,
    // Shift and Enter for a new line" hint wrapped to a second line at phone
    // widths, and the integer-rounded box left the wrapped line a hair short,
    // so its descenders were shaved. A single line cannot wrap, so it cannot
    // clip. The keyboard contract lives in the accessible description instead
    // (see the textarea's aria-describedby in chat.html).
    input.placeholder = `Write as ${name}.`;
    // The placeholder counts toward scrollHeight, so re-fit after swapping it:
    // a long persona name can still wrap, and this keeps the box tall enough
    // to show every line instead of clipping the last one.
    resize();
  }

  input.addEventListener("input", () => {
    resize();
    updateStats();
    updateSendState();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!busy) send();
    }
  });

  // Send is wired through the form's submit event (Enter and the button both
  // fire it), so there is exactly one path and no double send. The send button
  // is type="submit"; Enter is intercepted above only to honour Shift+Enter.
  stopButton?.addEventListener("click", () => {
    onStop();
  });

  resize();
  updateStats();
  updateSendState();

  return {
    setBusy,
    setPersona,
    updateStats,
    updateSendState,
    resize,
    focus: () => input.focus(),
    getValue: () => input.value,
    setValue: (v) => {
      input.value = v;
      resize();
      updateStats();
      updateSendState();
    },
    get busy() {
      return busy;
    },
  };
}
