// Settings modal: one shell for engine, parameters, personas and directives.
//
// Contract
//   - `openSettingsModal(options)` builds the whole Settings surface as a
//     single `.rp-dialog` with an APG tablist, then delegates each panel to its
//     own module. `options`:
//       getSettings() / saveSettings(patch)
//       fetchModels({endpoint, key})
//       saveSession(rawText) -> { ok, message }
//       listPersonas() / savePersona(p) / deletePersona(id) / setDefaultPersona(id)
//       listDirectives() / saveDirective(d) / deleteDirective(id) / setDefaultDirective(id)
//       confirm(kind, label) -> Promise<boolean>   (from confirm.js)
//       host                toast host
//       tab                 initial tab id, e.g. "settings-personas-tab"
//   - The persona and directive editors are opened from this module through
//     their own modules, so editing stays inside the dialog stack.
//   - Returns `{ close, element, selectTab }`.
//
// Exports
//   openSettingsModal(options) -> { close, element, selectTab }

import { el } from "../dom.js";
import { openModal, closeModal } from "../modal.js";
import { initTabs } from "../tabs.js";
import { mountEnginePanel } from "./engine_panel.js";
import { mountParamsPanel } from "./params_panel.js";
import { mountPersonaList } from "./persona_list.js";
import { mountDirectiveList } from "./directive_list.js";
import { openPersonaEditor } from "../editors/persona_editor.js";
import { openDirectiveEditor } from "../editors/directive_editor.js";

// Slider rows, declared once so the panel markup stays declarative.
function sliderRow({ id, valueId, label, hint, min, max, step, value }) {
  return el("div", { class: "rp-field" }, [
    el("div", { class: "rp-field__head" }, [
      el("label", { class: "rp-label", for: id, text: label }),
      el("span", { class: "rp-badge rp-badge--count rp-tnum", id: valueId, text: String(value) }),
    ]),
    el("input", { type: "range", id, class: "rp-range", min, max, step, value }),
    el("p", { class: "rp-help", text: hint }),
  ]);
}

const PARAM_FIELDS = [
  sliderRow({ id: "popup-slider-temp", valueId: "popup-val-temp", label: "Temperature", hint: "Lower is focused and deterministic; higher is creative and descriptive.", min: 0.1, max: 2, step: 0.05, value: 0.85 }),
  sliderRow({ id: "popup-slider-topp", valueId: "popup-val-topp", label: "Top P", hint: "Nucleus sampling: considers only the top P probability mass.", min: 0.1, max: 1, step: 0.05, value: 0.95 }),
  sliderRow({ id: "popup-slider-minp", valueId: "popup-val-minp", label: "Min P", hint: "Trims low-probability noise without truncating creative tails.", min: 0, max: 0.5, step: 0.01, value: 0.05 }),
  sliderRow({ id: "popup-slider-tokens", valueId: "popup-val-tokens", label: "Max response tokens", hint: "Token ceiling per turn. 1500 tokens is roughly four rich paragraphs.", min: 200, max: 4096, step: 50, value: 1500 }),
  sliderRow({ id: "popup-slider-freq", valueId: "popup-val-freq", label: "Frequency penalty", hint: "Higher values reduce repetitive verbal tics.", min: -2, max: 2, step: 0.05, value: 0.25 }),
  sliderRow({ id: "popup-slider-pres", valueId: "popup-val-pres", label: "Presence penalty", hint: "Encourages new topics and vocabulary.", min: -2, max: 2, step: 0.05, value: 0.15 }),
  sliderRow({ id: "popup-slider-context", valueId: "popup-val-context", label: "Max context budget", hint: "Folds the continuity ledger when history approaches this budget.", min: 2048, max: 131072, step: 2048, value: 32768 }),
];

const TABS = [
  { id: "settings-engine-tab", label: "Engine" },
  { id: "settings-params-tab", label: "Parameters" },
  { id: "settings-personas-tab", label: "Personas" },
  { id: "settings-directives-tab", label: "System prompts" },
];

function guidance(title, text) {
  return el("div", { class: "rp-settings__guidance" }, [
    el("p", { class: "rp-settings__guidance-title", text: title }),
    el("p", { class: "rp-settings__guidance-text", text }),
  ]);
}

export function openSettingsModal(options = {}) {
  const { host, confirm, tab } = options;

  const tablist = el(
    "div",
    { class: "rp-tabs rp-settings__tabs" },
    TABS.map((entry) => el("button", { type: "button", class: "rp-tab", id: `${entry.id}-btn`, text: entry.label }))
  );
  TABS.forEach((entry, index) => {
    tablist.children[index].setAttribute("aria-controls", entry.id);
  });

  // Engine panel.
  const enginePanel = el("div", { class: "rp-tabpanel rp-settings__panel", id: "settings-engine-tab" }, [
    guidance(
      "Inference engine and models",
      "Connect any OpenAI-compatible completions API such as OpenRouter, vLLM, Ollama or LM Studio. Settings stay in this browser."
    ),
    el("div", { class: "rp-field" }, [
      el("label", { class: "rp-label", for: "popup-api-endpoint", text: "API base URL" }),
      el("input", { type: "text", id: "popup-api-endpoint", class: "rp-input", placeholder: "https://api.example.com/v1" }),
      el("p", { class: "rp-help", text: "The base URL of your provider, ending in /v1." }),
    ]),
    el("div", { class: "rp-field" }, [
      el("label", { class: "rp-label", for: "popup-api-key", text: "API key" }),
      el("input", { type: "password", id: "popup-api-key", class: "rp-input", placeholder: "sk-..." }),
      el("p", { class: "rp-help", text: "Stored in this browser only." }),
    ]),
    el("div", { class: "rp-field" }, [
      el("div", { class: "rp-settings__list-head" }, [
        el("label", { class: "rp-label", for: "popup-model-select", text: "Primary story model" }),
        el("button", { type: "button", id: "popup-fetch-models-btn", class: "rp-btn rp-btn--ghost rp-btn--sm", text: "Fetch models" }),
      ]),
      el("select", { id: "popup-model-select", class: "rp-select" }),
      el("p", { class: "rp-help", text: "Used to generate prose, narration and dialogue." }),
    ]),
    el("div", { class: "rp-panel rp-panel--raised rp-settings__check-box" }, [
      el("label", { class: "rp-settings__check" }, [
        el("input", { type: "checkbox", id: "popup-enable-thoughts" }),
        el("span", {}, [
          el("span", { class: "rp-settings__check-title", text: "Character inner thoughts" }),
          el("span", { class: "rp-help", text: "Characters produce private monologue before speaking in scene." }),
        ]),
      ]),
      el("div", { id: "popup-thought-model-wrap", class: "rp-field" }, [
        el("label", { class: "rp-label", for: "popup-subagent-model-select", text: "Thought reasoning model" }),
        el("select", { id: "popup-subagent-model-select", class: "rp-select" }),
      ]),
    ]),
    // The session-import control is a library-only concern (it unlocks full
    // card definitions during import). Only render it when the caller supplies
    // a `saveSession` handler, so the chat surface does not carry a hidden
    // import affordance it cannot service.
    ...(options.saveSession
      ? [
          el("div", { class: "rp-field rp-settings__divider", id: "popup-import-session-wrap", hidden: true }, [
            el("label", { class: "rp-label", for: "popup-import-session-input", text: "Import session" }),
            el("textarea", {
              id: "popup-import-session-input",
              class: "rp-textarea rp-textarea--mono",
              rows: 3,
              placeholder: "Paste exported session cookies JSON",
            }),
            el("p", { class: "rp-help", text: "Grants access to fetch full character definitions from character pages. Treat it like a password." }),
            el("div", {}, [
              el("button", { type: "button", id: "popup-save-import-session-btn", class: "rp-btn rp-btn--secondary rp-btn--sm", text: "Save session" }),
            ]),
          ]),
        ]
      : []),
    el("p", { id: "popup-engine-status", class: "rp-settings__status", attrs: { role: "status" } }),
    el("div", { class: "rp-settings__footer" }, [
      el("span", { class: "rp-settings__footer-spacer", id: "popup-secret-session-trigger" }),
      el("button", { type: "button", id: "popup-save-engine-btn", class: "rp-btn rp-btn--primary", text: "Save engine settings" }),
    ]),
  ]);

  // Parameters panel.
  const paramsPanel = el("div", { class: "rp-tabpanel rp-settings__panel", id: "settings-params-tab", hidden: true }, [
    guidance(
      "Sampler and context controls",
      "Balance creative unpredictability against narrative coherence. These values go to the model on every request."
    ),
    ...PARAM_FIELDS,
    el("p", { id: "popup-params-status", class: "rp-settings__status", attrs: { role: "status" } }),
    el("div", { class: "rp-settings__footer" }, [
      el("button", { type: "button", id: "popup-save-params-btn", class: "rp-btn rp-btn--primary", text: "Save parameters" }),
    ]),
  ]);

  // Personas panel.
  const personaRoot = el("div", { class: "rp-settings__list" });
  const personasPanel = el("div", { class: "rp-tabpanel rp-settings__panel", id: "settings-personas-tab", hidden: true }, [
    guidance(
      "Author personas",
      "A persona is who you are in the scene. Set one as the global default, or override it per character."
    ),
    el("div", { class: "rp-settings__list-head" }, [
      el("span", { class: "rp-settings__list-title", text: "Saved personas" }),
      el("button", { type: "button", id: "rp-create-persona", class: "rp-btn rp-btn--primary rp-btn--sm", text: "Create persona" }),
    ]),
    personaRoot,
  ]);

  // Directives panel.
  const directiveRoot = el("div", { class: "rp-settings__list" });
  const directivesPanel = el("div", { class: "rp-tabpanel rp-settings__panel", id: "settings-directives-tab", hidden: true }, [
    guidance(
      "System prompts",
      "The system prompt is the contract every reply obeys: voice, banned clichés, register and pacing."
    ),
    el("div", { class: "rp-settings__list-head" }, [
      el("span", { class: "rp-settings__list-title", text: "Saved prompts" }),
      el("button", { type: "button", id: "rp-create-directive", class: "rp-btn rp-btn--primary rp-btn--sm", text: "New prompt" }),
    ]),
    directiveRoot,
  ]);

  const dialog = el("dialog", { class: "rp-dialog rp-dialog--wide", attrs: { "aria-labelledby": "rp-settings-title" } }, [
    el("div", { class: "rp-dialog__panel" }, [
      el("div", { class: "rp-sheet__handle", attrs: { "aria-hidden": "true" } }),
      el("header", { class: "rp-dialog__header" }, [
        el("div", {}, [
          el("h2", { class: "rp-dialog__title", id: "rp-settings-title", text: "Settings" }),
          el("p", { class: "rp-dialog__desc", text: "Engine, parameters, personas and craft contracts." }),
        ]),
        el("button", {
          type: "button",
          class: "rp-btn rp-btn--ghost rp-btn--icon rp-dialog__close",
          text: "\u00d7",
          attrs: { "aria-label": "Close settings" },
        }),
      ]),
      el("div", { class: "rp-dialog__body" }, [tablist, enginePanel, paramsPanel, personasPanel, directivesPanel]),
    ]),
  ]);

  document.body.appendChild(dialog);
  const tabs = initTabs(tablist, { activation: "auto" });

  const engine = mountEnginePanel(enginePanel, {
    getSettings: options.getSettings,
    saveSettings: options.saveSettings,
    fetchModels: options.fetchModels,
    saveSession: options.saveSession,
    host,
  });
  const params = mountParamsPanel(paramsPanel, {
    getParams: options.getSettings,
    saveParams: options.saveSettings,
    host,
  });
  const personas = mountPersonaList(personaRoot, {
    load: options.listPersonas,
    createButton: dialog.querySelector("#rp-create-persona"),
    onEdit: (persona) =>
      openPersonaEditor({
        persona,
        compressImage: options.compressImage,
        host,
        onSave: async (payload) => {
          await options.savePersona?.(payload);
          await personas.refresh();
        },
      }),
    onCreate: () =>
      openPersonaEditor({
        persona: null,
        compressImage: options.compressImage,
        host,
        onSave: async (payload) => {
          await options.savePersona?.(payload);
          await personas.refresh();
        },
      }),
    onDelete: async (persona) => {
      const ok = await confirm?.("persona", persona.name);
      if (!ok) return false;
      await options.deletePersona?.(persona.id);
      return true;
    },
    onSetDefault: (persona) => options.setDefaultPersona?.(persona.id),
    host,
  });
  const directives = mountDirectiveList(directiveRoot, {
    load: options.listDirectives,
    createButton: dialog.querySelector("#rp-create-directive"),
    onEdit: (directive) =>
      openDirectiveEditor({
        directive,
        host,
        onSave: async (payload) => {
          await options.saveDirective?.(payload);
          await directives.refresh();
        },
      }),
    onCreate: () =>
      openDirectiveEditor({
        directive: null,
        host,
        onSave: async (payload) => {
          await options.saveDirective?.(payload);
          await directives.refresh();
        },
      }),
    onDelete: async (directive) => {
      const ok = await confirm?.("directive", directive.name);
      if (!ok) return false;
      await options.deleteDirective?.(directive.id);
      return true;
    },
    onSetDefault: (directive) => options.setDefaultDirective?.(directive.id),
    host,
  });

  function refreshAll() {
    engine.refresh();
    params.refresh();
    personas.refresh();
    directives.refresh();
  }
  refreshAll();

  let settled = false;
  function close() {
    if (settled) return;
    settled = true;
    engine.destroy();
    params.destroy();
    personas.destroy();
    directives.destroy();
    tabs.destroy();
    closeModal(dialog);
    dialog.remove();
    options.onClose?.();
  }

  dialog.querySelector(".rp-dialog__close").addEventListener("click", close);

  // Select the requested tab BEFORE opening. `openModal` moves focus to the
  // selected tab on the next frame, and auto activation treats a focus change
  // as a tab change: selecting afterwards would be undone by that focus.
  // The routes layer and the chat surface address this panel as
  // "settings-system-prompts-tab"; the library panel id is
  // "settings-directives-tab". Accept the alias so /directives and the
  // history "Manage" button land on Directives instead of the default tab.
  const initialTab = tab === "settings-system-prompts-tab" ? "settings-directives-tab" : tab;
  if (initialTab) tabs.select(initialTab);

  openModal({
    element: dialog,
    onClose: () => {
      if (settled) return;
      settled = true;
      options.onClose?.();
    },
    initialFocus: tablist.querySelector('[aria-selected="true"]'),
  });

  return { close, element: dialog, selectTab: tabs.select };
}
