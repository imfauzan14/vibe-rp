// Library page bootstrap: the only script the library entry point loads.
//
// Contract
//   - Wires the shared modules to the page markup. It owns no reusable logic:
//     catalogue state lives in library_controller.js, rendering in
//     library_view.js, dialogs in their own modules.
//   - Responsibilities here are page-level only: the DOM element handles, the
//     LocalDb-backed adapters, the URL parameter handoff and the demo seed.
//
// Exports
//   None. Importing this module starts the page.

import { LocalDb } from "../local_db.js";
import { BrowserChatEngine } from "../browser_engine.js";
import { extractSessionToken } from "../remote_import.js";
import { createLibraryController } from "./library_controller.js";
import { mountLibrary } from "./library_view.js";
import { createToastHost } from "./toast.js";
import { openDetailModal } from "./detail_modal.js";
import { openImportModal, importCardFromUrl, SESSION_STORAGE_KEY } from "./import_flow.js";
import { openSettingsModal } from "./settings/settings_modal.js";
import { confirmAction, confirmDelete } from "./confirm.js";
import { compressImage } from "./image.js";
import { initTheme, toggleTheme, getTheme, onThemeChange } from "./theme.js";

const DEMO_CARDS = [
  {
    id: "card_valen_shadow",
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "Valen Vance",
      creator: "Ministry of Whispers",
      description:
        "A disgraced royal archivist now brokering forbidden manuscripts in the lower smog districts. Speaks with dry precision, calculating each gesture.",
      personality: "Cynical, erudite, razor-sharp, protective of lost history.",
      scenario: "A dimly lit subterranean ledger vault during curfew.",
      first_mes:
        "The rain outside is corrosive tonight. Step away from the glass. If you have brought the seventh treatise, place it on the scale.",
      tags: ["Gothic", "Occult", "Archivist"],
    },
  },
  {
    id: "card_kestrel_drifter",
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "Kestrel Rowan",
      creator: "Wanderer's Guild",
      description:
        "A borderlands scout and desert cartographer who navigates shifting salt flats. Carries antique bronze surveyor tools and observes long silences.",
      personality: "Stoic, vigilant, intuitive, observant of minute environmental shifts.",
      scenario: "An abandoned frontier watchtower as a sand squall approaches.",
      first_mes: "Keep your lantern shuttered. The wind here carries sound three leagues further than the open road.",
      tags: ["Frontier", "Survival", "Atmospheric"],
    },
  },
];

const el = (id) => document.getElementById(id);

const grid = el("card-grid");
const statusLine = el("library-status");
const tagFilter = el("library-tags");
const searchInput = el("library-search");
const sortSelect = el("library-sort");
const importBtn = el("import-btn");
const settingsBtn = el("toggle-settings-btn");
const themeBtn = el("theme-toggle");

initTheme();

const host = createToastHost({ root: document.body });

// Theme toggle
function paintThemeButton() {
  if (!themeBtn) return;
  const paper = getTheme() === "paper";
  themeBtn.setAttribute("aria-pressed", paper ? "true" : "false");
  themeBtn.setAttribute("aria-label", paper ? "Switch to the dark theme" : "Switch to the paper theme");
}
themeBtn?.addEventListener("click", () => toggleTheme());
onThemeChange(paintThemeButton);
paintThemeButton();

// Controller and catalogue mount
const controller = createLibraryController({
  db: LocalDb,
  onError: (error) => host.toast(`Could not load the library: ${error.message}`, { tone: "danger" }),
});

const view = mountLibrary({
  grid,
  tagFilter,
  status: statusLine,
  controller,
  handlers: {
    onOpenDetail: (card) => openDetail(card),
    onNewChat: (card) => startConversation(card),
    onResume: (card, session) => {
      void card;
      void session;
      // The anchor performs the navigation; this hook exists so a future
      // in-app router can intercept it without changing the view.
    },
    onImport: () => openImport(),
    onClearFilters: () => {
      controller.setQuery("");
      controller.setTag("");
      if (searchInput) searchInput.value = "";
    },
  },
});

// Dialogs
async function confirmDeleteThing(kind, label) {
  const noun = kind === "character" ? "character" : kind === "chat" ? "chat" : kind === "directive" ? "prompt" : kind;
  return confirmAction({
    title: `Delete ${noun} "${label}"?`,
    body:
      kind === "character"
        ? "Every conversation for this character is deleted too. This cannot be undone."
        : "This cannot be undone.",
    confirmLabel: "Delete",
    tone: "danger",
    initialFocus: "cancel",
  });
}

function openDetail(card) {
  openDetailModal({
    card,
    sessions: controller.sessionsFor(card.id),
    // The dialog re-reads this after a rename or a delete, so the list always
    // matches the store rather than the snapshot taken at open time.
    loadSessions: (target) => controller.sessionsFor(target.id),
    host,
    handlers: {
      onStartNew: (target, opening) => startConversation(target, opening),
      onDeleteCard: async (target) => {
        await controller.removeCard(target.id);
        host.toast(`"${target.data?.name || target.name || "Character"}" deleted.`, { tone: "info" });
      },
      onConfirmDelete: confirmDeleteThing,
      onChangeAvatar: async (target) => {
        const file = await pickImageFile();
        if (!file) return undefined;
        const dataUrl = await compressImage(file, 384);
        const next = { ...target, avatar: dataUrl, data: { ...(target.data || {}), avatar: dataUrl } };
        await LocalDb.saveCard(next);
        await controller.refresh();
        return dataUrl;
      },
      onRenameSession: async (session, title) => {
        await controller.renameSession(session.id, title);
      },
      onDeleteSession: async (session) => {
        await controller.removeSession(session.id);
        host.toast("Chat deleted.", { tone: "info" });
      },
    },
  });
}

/** Opens a file picker and resolves the chosen image, or null when cancelled. */
function pickImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", () => resolve(input.files?.[0] || null), { once: true });
    // A cancelled picker fires no change event in most engines; the listener
    // simply stays unused and is collected with the element.
    input.click();
  });
}

function openImport() {
  openImportModal({ controller, host });
}

function openSettings(initialTab) {
  openSettingsModal({
    host,
    tab: initialTab,
    confirm: confirmDeleteThing,
    compressImage,
    getSettings: () => LocalDb.getSettings(),
    saveSettings: (patch) => LocalDb.saveSettings({ ...LocalDb.getSettings(), ...patch }),
    fetchModels: ({ endpoint, key }) => BrowserChatEngine.fetchAvailableModels(endpoint, key),
    saveSession: (raw) => {
      const token = extractSessionToken(raw);
      if (!token) return { ok: false, message: "No session token found in that JSON." };
      try {
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(token));
      } catch (error) {
        return { ok: false, message: `Could not save the session: ${error.message}` };
      }
      const expiry = token.expiresAt ? new Date(token.expiresAt * 1000).toLocaleString() : "unknown";
      return { ok: true, message: `Session saved. It expires ${expiry}.` };
    },
    listPersonas: () => LocalDb.getAllPersonas(),
    savePersona: (persona) => LocalDb.savePersona(persona),
    deletePersona: (id) => LocalDb.deletePersona(id),
    setDefaultPersona: (id) => LocalDb.setDefaultPersona(id),
    listDirectives: () => LocalDb.getAllDirectives(),
    saveDirective: (directive) => LocalDb.saveDirective(directive),
    deleteDirective: (id) => LocalDb.deleteDirective(id),
    setDefaultDirective: (id) => LocalDb.setDefaultDirective(id),
    onDataChanged: async () => {
      await controller.load();
      render();
    },
  });
}

async function startConversation(card, customOpening) {
  const count = controller.sessionsFor(card.id).length;
  const data = card.data || card;
  const opening =
    customOpening || data.first_mes || "The door closes behind you. Silence settles into the corridor.";
  const session = {
    id: `sess_${Date.now()}`,
    cardId: card.id,
    title: `Chat ${count + 1}`,
    messages: [{ id: `msg_${Date.now()}`, role: "assistant", content: opening, timestamp: Date.now() }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await LocalDb.saveSession(session);
  window.location.href = `chat.html?cardId=${encodeURIComponent(card.id)}&sessionId=${encodeURIComponent(session.id)}`;
}

// Event listeners
let searchTimer = 0;
searchInput?.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const value = searchInput.value;
  searchTimer = setTimeout(() => controller.setQuery(value), 120);
});

sortSelect?.addEventListener("change", () => controller.setSort(sortSelect.value));

tagFilter?.addEventListener("change", () => controller.setTag(tagFilter.value));

importBtn?.addEventListener("click", () => openImport());
settingsBtn?.addEventListener("click", () => openSettings());

// Initialization
async function seedRosterIfEmpty() {
  const cards = await LocalDb.getAllCards();
  if (cards.length > 0) return;
  for (const card of DEMO_CARDS) await LocalDb.saveCard(card);
}

/** Reads `?openSettings=1&tab=...` and the legacy hash form, then clears it. */
function applyUrlParameters() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("openSettings")) return;
  const hashToTab = {
    "#tab-engine": "settings-engine-tab",
    "#tab-params": "settings-params-tab",
    "#tab-directives": "settings-directives-tab",
    "#tab-personas": "settings-personas-tab",
  };
  const tab = params.get("tab") || hashToTab[window.location.hash] || null;
  openSettings(tab);
  history.replaceState(null, "", window.location.pathname);
}

await seedRosterIfEmpty();
await controller.refresh();
applyUrlParameters();

if ("serviceWorker" in navigator && window.isSecureContext) {
  try {
    navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => {});
  } catch (_) {
    /* offline shell is optional */
  }
}
