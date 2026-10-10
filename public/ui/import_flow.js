// Import flow: file, URL and drag-and-drop import into one dialog.
//
// Contract
//   - `openImportModal({ controller, host, sessionKey })` shows a `.rp-dialog`
//     with two mutually exclusive methods. Arming a file disables the URL row
//     and vice versa, so there is never an ambiguous import.
//   - `controller.importCard(card, { onDuplicate })` owns persistence and the
//     duplicate decision; this module supplies the duplicate UI and reports the
//     outcome through the injected toast host.
//   - Parsing is delegated to the shared card_parse.js and remote_import.js
//     modules. A stored session token in localStorage is used for character
//     page URLs, and an expired token is reported instead of silently dropping
//     to an anonymous fetch.
//   - Returns a Promise that resolves when the dialog closes.
//
// Exports
//   openImportModal(options) -> Promise<void>
//   parseCardFile(file) -> Promise<card>
//   importCardFromUrl(url, { controller, host, sessionKey }) -> Promise<boolean>

import { el } from "./dom.js";
import { openModal, closeModal } from "./modal.js";
import { stripJsonComments, normalizeCard, parseJsonLoose, parsePngChara, parseWebpChara } from "../card_parse.js";
import { parseCardUrl, isCharacterPageUrl, extractSessionToken } from "../remote_import.js";
import { compressImage } from "./image.js";

export const SESSION_STORAGE_KEY = "vibe_rp_import_session";

const ACCEPTED = ".json,.jsonc,.png,.webp,.txt";

/** Reads a picked file into a normalised card. Throws a readable error. */
export async function parseCardFile(file) {
  const ext = (file.name || "").toLowerCase().split(".").pop();
  if (ext === "json" || ext === "jsonc" || ext === "txt") {
    const json = parseJsonLoose(stripJsonComments(await file.text()));
    if (!json) throw new Error("That JSON file is empty or malformed.");
    return normalizeCard(json);
  }
  if (ext === "png" || ext === "webp") {
    const buffer = await file.arrayBuffer();
    const raw = ext === "png" ? await parsePngChara(buffer) : parseWebpChara(buffer);
    if (!raw) {
      throw new Error(
        `No character data embedded in this ${ext.toUpperCase()}. On chub.ai, export as PNG (V2) or JSON.`
      );
    }
    const card = normalizeCard(raw);
    try {
      const avatar = await compressImage(file, 384);
      if (avatar) {
        card.avatar = avatar;
        if (card.data) card.data.avatar = avatar;
      }
    } catch (_) {
      /* a missing portrait must not fail the import */
    }
    return card;
  }
  throw new Error("Unsupported file type. Use a JSON card or a PNG (V2) card.");
}

/** Reads the stored import session, reporting an expired one instead of ignoring it. */
function readStoredSession(sessionKey, host) {
  try {
    const stored = JSON.parse(localStorage.getItem(sessionKey) || "null");
    if (!stored?.accessToken) return null;
    if (stored.expiresAt && Date.now() / 1000 > stored.expiresAt) {
      host?.toast?.(
        "Your saved import session has expired, so character definitions cannot be fetched. Paste fresh session cookies in Settings, Engine, Import session.",
        { tone: "danger" }
      );
      return null;
    }
    return stored;
  } catch (_) {
    return null;
  }
}

/** Imports from a URL, returning true on success. */
export async function importCardFromUrl(url, { controller, host, sessionKey = SESSION_STORAGE_KEY } = {}) {
  const trimmed = String(url || "").trim();
  if (!trimmed) return false;
  try {
    const session = readStoredSession(sessionKey, host);
    const incoming = await parseCardUrl(trimmed, session);
    if (isCharacterPageUrl(trimmed)) {
      const avatarUrl = incoming.data?.extensions?.source?.avatar_url;
      if (incoming.data?.extensions?.source) delete incoming.data.extensions.source.avatar_url;
      if (avatarUrl) {
        try {
          const response = await fetch(avatarUrl);
          if (response.ok) {
            const dataUrl = await compressImage(await response.blob(), 384);
            if (dataUrl) {
              incoming.avatar = dataUrl;
              if (incoming.data) incoming.data.avatar = dataUrl;
            }
          }
        } catch (_) {
          /* portrait is optional */
        }
      }
    }
    const stored = await controller.importCard(incoming, { onDuplicate: (dup, card) => promptDuplicate(dup, card) });
    if (!stored) return false;
    host?.toast?.(`"${stored.data?.name || stored.name || "Character"}" imported.`, { tone: "success" });
    return true;
  } catch (error) {
    host?.toast?.(`Could not import that card: ${error.message}`, { tone: "danger" });
    return false;
  }
}

/**
 * The three-way duplicate question. Resolves "replace", "add" or "abort".
 * Built on a real dialog so it is keyboard reachable and non-blocking.
 */
function promptDuplicate(dup, incoming) {
  const name = incoming?.data?.name || incoming?.name || "this character";
  return new Promise((resolve) => {
    const id = `rp-dup-${Date.now()}`;
    const dialog = el("dialog", { class: "rp-dialog", attrs: { "aria-labelledby": `${id}-title` } });

    let settled = false;
    const finish = (choice) => {
      if (settled) return;
      settled = true;
      closeModal(dialog);
      dialog.remove();
      resolve(choice);
    };

    const choice = (label, description, className) => {
      const button = el("button", { type: "button", class: `rp-btn ${className} rp-btn--block rp-dup__choice` }, [
        el("span", { class: "rp-dup__choice-label", text: label }),
        el("span", { class: "rp-dup__choice-desc", text: description }),
      ]);
      return button;
    };

    const replaceBtn = choice("Replace the preset", "Update the character data and keep every conversation.", "rp-btn--primary");
    replaceBtn.addEventListener("click", () => finish("replace"));
    const addBtn = choice("Add as a separate preset", "Keep both, side by side in the library.", "rp-btn--secondary");
    addBtn.addEventListener("click", () => finish("add"));
    const abortBtn = el("button", { type: "button", class: "rp-btn rp-btn--ghost rp-btn--block", text: "Cancel import" });
    abortBtn.addEventListener("click", () => finish("abort"));

    dialog.appendChild(
      el("div", { class: "rp-dialog__panel" }, [
        el("div", { class: "rp-sheet__handle", attrs: { "aria-hidden": "true" } }),
        el("header", { class: "rp-dialog__header" }, [
          el("div", {}, [
            el("h2", {
              class: "rp-dialog__title",
              id: `${id}-title`,
              text: dup.kind === "exact" ? "Already imported" : "Character already exists",
            }),
            el("p", {
              class: "rp-dialog__desc",
              text:
                dup.kind === "exact"
                  ? `"${name}" is identical to an existing preset.`
                  : `"${name}" matches an existing preset name but has different content, possibly an update.`,
            }),
          ]),
        ]),
        el("div", { class: "rp-dialog__body rp-dup__body" }, [replaceBtn, addBtn, abortBtn]),
      ])
    );

    document.body.appendChild(dialog);
    openModal({ element: dialog, onClose: () => finish("abort"), initialFocus: replaceBtn });
  });
}

export function openImportModal({ controller, host, sessionKey = SESSION_STORAGE_KEY } = {}) {
  return new Promise((resolve) => {
    let mode = null; // null | "file" | "url"
    let busy = false;
    let dragDepth = 0;

    const fileInput = el("input", {
      type: "file",
      accept: ACCEPTED,
      class: "visually-hidden",
      attrs: { "aria-hidden": "true", tabindex: "-1" },
    });

    const dropZone = el("button", { type: "button", class: "rp-dropzone" }, [
      el("span", { class: "rp-dropzone__icon", attrs: { "aria-hidden": "true" } }),
      el("span", { class: "rp-dropzone__title", text: "Drop a card here" }),
      el("span", { class: "rp-dropzone__hint", text: "JSON, JSONC, PNG or WebP, or browse your files" }),
    ]);

    const fileChip = el("div", { class: "rp-import__chip", hidden: true });
    const fileName = el("span", { class: "rp-import__chip-name" });
    const removeFile = el("button", { type: "button", class: "rp-btn rp-btn--ghost rp-btn--sm", text: "Remove file" });
    fileChip.append(fileName, removeFile);

    const note = el("p", { class: "rp-import__note", attrs: { "role": "status" }, hidden: true });
    const urlInput = el("input", {
      type: "url",
      class: "rp-input",
      id: "rp-import-url",
      placeholder: "Paste a card URL or character page link",
      attrs: { "aria-label": "Import a card from a URL" },
    });
    const urlSubmit = el("button", { type: "button", class: "rp-btn rp-btn--primary", text: "Fetch", disabled: true });

    const dialog = el("dialog", { class: "rp-dialog", attrs: { "aria-labelledby": "rp-import-title" } }, [
      el("div", { class: "rp-dialog__panel" }, [
        el("div", { class: "rp-sheet__handle", attrs: { "aria-hidden": "true" } }),
        el("header", { class: "rp-dialog__header" }, [
          el("div", {}, [
            el("h2", { class: "rp-dialog__title", id: "rp-import-title", text: "Import a character" }),
            el("p", { class: "rp-dialog__desc", text: "Add a card file or fetch one from a link. One method at a time." }),
          ]),
          el("button", {
            type: "button",
            class: "rp-btn rp-btn--ghost rp-btn--icon rp-dialog__close",
            text: "\u00d7",
            attrs: { "aria-label": "Close dialog" },
          }),
        ]),
        el("div", { class: "rp-dialog__body" }, [
          fileInput,
          dropZone,
          fileChip,
          note,
          el("div", { class: "rp-import__divider", text: "or import from a URL" }),
          el("div", { class: "rp-import__url-row" }, [urlInput, urlSubmit]),
        ]),
      ]),
    ]);

    document.body.appendChild(dialog);

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      closeModal(dialog);
      dialog.remove();
      resolve();
    };

    function syncState() {
      const fileArmed = mode === "file";
      const urlArmed = mode === "url";
      urlInput.disabled = fileArmed;
      urlSubmit.disabled = fileArmed || busy || urlInput.value.trim() === "";
      if (fileArmed) urlInput.value = "";
      fileChip.hidden = !fileArmed;
      dropZone.disabled = urlArmed || busy;
      dropZone.setAttribute("aria-disabled", urlArmed || busy ? "true" : "false");
      if (fileArmed) {
        note.hidden = false;
        note.textContent = "URL import is disabled while a file is selected. Remove the file to import from a URL instead.";
      } else if (urlArmed) {
        note.hidden = false;
        note.textContent = "File import is disabled while a URL is entered. Clear the URL to choose a file instead.";
      } else {
        note.hidden = true;
        note.textContent = "";
      }
    }

    async function runFile(file) {
      if (busy || !file) return;
      busy = true;
      mode = "file";
      fileName.textContent = file.name || "card";
      syncState();
      try {
        const card = await parseCardFile(file);
        const stored = await controller.importCard(card, { onDuplicate: (dup, incoming) => promptDuplicate(dup, incoming) });
        // A resolved importCard means the user made a decision (imported,
        // replaced or aborted). The dialog closes either way, as it always
        // has; only a thrown parse or storage failure keeps it open.
        if (stored) host?.toast?.(`"${stored.data?.name || stored.name || "Character"}" imported.`, { tone: "success" });
        finish();
        return;
      } catch (error) {
        host?.toast?.(`Could not import that card: ${error.message}`, { tone: "danger" });
      }
      busy = false;
      syncState();
    }

    async function submitUrl() {
      if (busy) return;
      const url = urlInput.value.trim();
      if (!url || mode !== "url") return;
      busy = true;
      urlSubmit.classList.add("is-loading");
      urlSubmit.disabled = true;
      const ok = await importCardFromUrl(url, { controller, host, sessionKey });
      urlSubmit.classList.remove("is-loading");
      if (ok) {
        finish();
        return;
      }
      busy = false;
      syncState();
    }

    // File import: click, keyboard, and drag-and-drop.
    dropZone.addEventListener("click", () => {
      if (mode === "url" || busy) return;
      fileInput.click();
    });
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (file) runFile(file);
    });

    const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
    dropZone.addEventListener("dragenter", (event) => {
      if (mode === "url" || busy || !hasFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      dropZone.classList.add("is-dragover");
    });
    dropZone.addEventListener("dragover", (event) => {
      if (mode === "url" || busy || !hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      dropZone.classList.add("is-dragover");
    });
    dropZone.addEventListener("dragleave", () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dropZone.classList.remove("is-dragover");
    });
    dropZone.addEventListener("drop", (event) => {
      if (mode === "url" || busy) return;
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      event.preventDefault();
      dragDepth = 0;
      dropZone.classList.remove("is-dragover");
      runFile(file);
    });

    removeFile.addEventListener("click", () => {
      mode = null;
      fileName.textContent = "";
      syncState();
      dropZone.focus();
    });

    // URL import input handling.
    urlInput.addEventListener("input", () => {
      const hasText = urlInput.value.trim() !== "";
      if (hasText && mode !== "file") mode = "url";
      else if (!hasText && mode === "url") mode = null;
      syncState();
    });
    urlInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitUrl();
      }
    });
    urlSubmit.addEventListener("click", submitUrl);

    dialog.querySelector(".rp-dialog__close").addEventListener("click", finish);
    syncState();
    openModal({ element: dialog, onClose: finish, initialFocus: dropZone });
  });
}
