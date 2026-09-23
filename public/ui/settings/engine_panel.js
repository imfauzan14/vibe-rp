// Engine panel: inference endpoint, model list and session import.
//
// Contract
//   - `mountEnginePanel(root, options)` owns the Engine tab. Every query is
//     scoped to `root`, which must contain the field markup the panel looks
//     for by id. No globals, no document-level listeners.
//   - Options:
//       getSettings()          -> the current settings object
//       saveSettings(patch)    -> persist a partial settings object
//       fetchModels({endpoint, key}) -> Promise<string[]> of model ids
//       saveSession(rawText)   -> handle the pasted session JSON
//       host                   -> a toast host from createToastHost (optional)
//   - Returns `{ refresh, destroy }`. `refresh` reloads the fields from
//     `getSettings`; `destroy` removes every listener it added.
//   - Async results are announced through `#popup-engine-status`, which the
//     page marks `role="status"`.
//
// Exports
//   mountEnginePanel(root, options) -> { refresh, destroy }

import { qs } from "../dom.js";

const MODEL_PLACEHOLDER = "Select a model after fetching models";
const SAME_AS_MAIN = "Same as main model";

/** Rebuilds a `<select>` from a model list, keeping `selected` if present. */
function fillModels(select, models, selected, { placeholder = MODEL_PLACEHOLDER } = {}) {
  if (!select) return;
  select.innerHTML = "";
  const set = new Set();
  if (selected) set.add(selected);
  for (const m of models || []) {
    const id = typeof m === "string" ? m : m?.id;
    if (id) set.add(id);
  }
  const placeholderOption = document.createElement("option");
  placeholderOption.value = "";
  placeholderOption.textContent = placeholder;
  placeholderOption.selected = !selected;
  select.appendChild(placeholderOption);
  for (const model of set) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    option.selected = model === selected;
    select.appendChild(option);
  }
}

export function mountEnginePanel(root, options = {}) {
  const { getSettings, saveSettings, fetchModels, saveSession, host } = options;
  if (!root) return { refresh: () => {}, destroy: () => {} };

  const endpoint = qs(root, "#popup-api-endpoint");
  const apiKey = qs(root, "#popup-api-key");
  const modelSelect = qs(root, "#popup-model-select");
  const thoughts = qs(root, "#popup-enable-thoughts");
  const thoughtWrap = qs(root, "#popup-thought-model-wrap");
  const thoughtSelect = qs(root, "#popup-thought-model-select");
  const choiceSelect = qs(root, "#popup-choice-model-select");
  const fetchBtn = qs(root, "#popup-fetch-models-btn");
  const saveBtn = qs(root, "#popup-save-engine-btn");
  const sessionWrap = qs(root, "#popup-import-session-wrap");
  const sessionInput = qs(root, "#popup-import-session-input");
  const saveSessionBtn = qs(root, "#popup-save-import-session-btn");
  const secretTrigger = qs(root, "#popup-secret-session-trigger");
  const status = qs(root, "#popup-engine-status");

  const cleanups = [];
  const on = (node, type, handler) => {
    if (!node) return;
    node.addEventListener(type, handler);
    cleanups.push(() => node.removeEventListener(type, handler));
  };

  function announce(message, tone) {
    if (status) status.textContent = message;
    if (tone === "danger") host?.toast?.(message, { tone: "danger" });
  }

  function syncThoughtVisibility() {
    if (thoughtWrap && thoughts) thoughtWrap.hidden = !thoughts.checked;
  }

  function refresh() {
    const settings = getSettings?.() || {};
    if (endpoint) endpoint.value = settings.apiEndpoint || "";
    if (apiKey) apiKey.value = settings.apiKey || "";
    if (thoughts) thoughts.checked = Boolean(settings.enableSubagentThoughts);
    syncThoughtVisibility();
    fillModels(modelSelect, settings.availableModels || [], settings.model || "");
    fillModels(thoughtSelect, settings.availableModels || [], settings.thoughtModel || "", {
      placeholder: SAME_AS_MAIN,
    });
    fillModels(choiceSelect, settings.availableModels || [], settings.choiceModel || "", {
      placeholder: SAME_AS_MAIN,
    });
  }

  on(thoughts, "change", syncThoughtVisibility);

  on(fetchBtn, "click", async () => {
    if (!fetchBtn) return;
    const original = fetchBtn.textContent;
    fetchBtn.classList.add("is-loading");
    fetchBtn.disabled = true;
    announce("Fetching models.");
    try {
      const models = await fetchModels?.({
        endpoint: endpoint?.value.trim() || undefined,
        key: apiKey?.value.trim() || undefined,
      });
      const list = Array.isArray(models) ? models : [];
      saveSettings?.({ availableModels: list });
      const settings = getSettings?.() || {};
      fillModels(modelSelect, list, settings.model || "");
      fillModels(thoughtSelect, list, settings.thoughtModel || "", {
        placeholder: SAME_AS_MAIN,
      });
      fillModels(choiceSelect, list, settings.choiceModel || "", {
        placeholder: SAME_AS_MAIN,
      });
      announce(`Fetched ${list.length} ${list.length === 1 ? "model" : "models"}.`);
    } catch (error) {
      announce(`Could not fetch models: ${error.message}`, "danger");
    } finally {
      fetchBtn.classList.remove("is-loading");
      fetchBtn.textContent = original;
      fetchBtn.disabled = false;
    }
  });

  on(saveBtn, "click", () => {
    saveSettings?.({
      apiEndpoint: endpoint?.value.trim() ?? "",
      apiKey: apiKey?.value.trim() ?? "",
      model: modelSelect?.value ?? "",
      enableSubagentThoughts: Boolean(thoughts?.checked),
      thoughtModel: thoughtSelect?.value ?? "",
      choiceModel: choiceSelect?.value ?? "",
    });
    announce("Engine settings saved.");
  });

  on(saveSessionBtn, "click", async () => {
    const raw = sessionInput?.value ?? "";
    const result = await saveSession?.(raw);
    if (result?.ok) {
      if (sessionInput) sessionInput.value = "";
      announce(result.message || "Session saved.");
    } else if (result?.message) {
      announce(result.message, "danger");
    }
  });

  let secretClicks = 0;
  let lastSecretClick = 0;
  const SECRET_THRESHOLD = 5;
  const RESET_TIMEOUT_MS = 2500;

  function handleSecretTap() {
    if (!sessionWrap || !sessionWrap.hidden) return;
    const now = Date.now();
    if (now - lastSecretClick > RESET_TIMEOUT_MS) {
      secretClicks = 0;
    }
    lastSecretClick = now;
    secretClicks++;
    if (secretClicks >= SECRET_THRESHOLD) {
      sessionWrap.hidden = false;
      sessionWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
      announce("Session import unlocked.");
      secretClicks = 0;
    }
  }

  on(secretTrigger, "click", handleSecretTap);
  on(qs(root, ".rp-settings__footer"), "click", (e) => {
    if (e.target !== saveBtn) {
      handleSecretTap();
    }
  });

  return {
    refresh,
    destroy() {
      for (const off of cleanups) off();
    },
  };
}
