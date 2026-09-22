// Settings surface: engine, parameters, personas, directives, and the two
// editors. Extracted from chat.html so the page script stays a thin bootstrap.
//
// Every query is scoped to `root` (the settings dialog) or `editorRoot`, and
// all state flows through the injected callbacks. No globals.

import { escapeHtml, escapeAttr } from "../../safe_html.js";

const SLIDERS = [
  ["popup-slider-temp", "popup-val-temp", "temperature", 0.85, (v) => parseFloat(v).toFixed(2)],
  ["popup-slider-topp", "popup-val-topp", "topP", 0.95, (v) => parseFloat(v).toFixed(2)],
  ["popup-slider-minp", "popup-val-minp", "minP", 0.05, (v) => parseFloat(v).toFixed(2)],
  ["popup-slider-tokens", "popup-val-tokens", "maxTokens", 1200, (v) => String(v)],
  ["popup-slider-freq", "popup-val-freq", "frequencyPenalty", 0.25, (v) => parseFloat(v).toFixed(2)],
  ["popup-slider-pres", "popup-val-pres", "presencePenalty", 0.15, (v) => parseFloat(v).toFixed(2)],
  ["popup-slider-context", "popup-val-context", "maxContextTokens", 16384, (v) => String(v)],
];

/**
 * @param {object} args
 * @param {HTMLDialogElement} args.root         the settings dialog
 * @param {HTMLDialogElement} args.personaEditor
 * @param {HTMLDialogElement} args.directiveEditor
 * @param {object} args.db                      LocalDb
 * @param {object} args.engine                  BrowserChatEngine
 * @param {(tabId?: string) => void} args.openDialog
 * @param {() => void} args.closeDialog
 * @param {() => void} args.onSettingsChanged   called after a save
 * @param {() => Promise<void>} args.onPresetsChanged
 * @param {(msg: string, tone?: string) => void} args.toast
 * @param {() => object} args.getModalPayload
 */
export function createSettingsPanel({
  root,
  personaEditor,
  directiveEditor,
  db,
  engine,
  openDialog,
  closeDialog,
  onSettingsChanged = () => {},
  onPresetsChanged = async () => {},
  toast = () => {},
  confirm = async () => true,
  getModalPayload = () => null,
}) {
  if (!root) throw new Error("createSettingsPanel needs the settings dialog");
  const q = (id) => root.querySelector(`#${id}`);
  const qp = (id) => personaEditor.querySelector(`#${id}`);
  const qd = (id) => directiveEditor.querySelector(`#${id}`);

  // --- tabs ---------------------------------------------------------------

  function selectTab(tabId) {
    root.querySelectorAll(".rp-tab").forEach((tab) => {
      const selected = tab.dataset.tab === tabId;
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.tabIndex = selected ? 0 : -1;
      if (selected) tab.focus();
    });
    root.querySelectorAll(".rp-tabpanel").forEach((panel) => {
      panel.hidden = panel.id !== tabId;
    });
  }

  root.querySelector(".rp-tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".rp-tab");
    if (tab) selectTab(tab.dataset.tab);
  });
  root.querySelector(".rp-tabs").addEventListener("keydown", (e) => {
    const tabs = [...root.querySelectorAll(".rp-tab")];
    const i = tabs.indexOf(document.activeElement);
    if (i === -1) return;
    let next = null;
    if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
    else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === "Home") next = tabs[0];
    else if (e.key === "End") next = tabs[tabs.length - 1];
    if (next) { e.preventDefault(); selectTab(next.dataset.tab); }
  });

  // --- engine -------------------------------------------------------------

  function renderModels(models, selected, alt) {
    const select = q("popup-model-select");
    const set = new Set((models || []).filter(Boolean));
    if (selected) set.add(selected);
    if (alt) set.add(alt);
    select.textContent = "";
    if (!set.size) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Fetch models first";
      select.appendChild(opt);
      return;
    }
    for (const m of set) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      if (m === selected) opt.selected = true;
      select.appendChild(opt);
    }
  }

  function loadEngine() {
    const s = db.getSettings();
    q("popup-api-endpoint").value = s.apiEndpoint || "";
    q("popup-api-key").value = s.apiKey || "";
    q("popup-cache-key").value = s.cacheKey || "";
    q("popup-enable-thoughts").checked = s.enableSubagentThoughts !== false;
    renderModels(s.availableModels || [], s.model, s.thoughtModel || s.subagentModel || "");
  }

  function saveEngine() {
    const s = db.getSettings();
    s.apiEndpoint = q("popup-api-endpoint").value.trim();
    s.apiKey = q("popup-api-key").value.trim();
    s.model = q("popup-model-select").value;
    s.cacheKey = q("popup-cache-key").value.trim();
    s.enableSubagentThoughts = q("popup-enable-thoughts").checked;
    db.saveSettings(s);
    onSettingsChanged();
    toast("Engine settings saved.", "success");
  }

  // --- parameters ---------------------------------------------------------

  function loadParams() {
    const s = db.getSettings();
    for (const [sliderId, badgeId, key, fallback, fmt] of SLIDERS) {
      const slider = q(sliderId);
      const badge = q(badgeId);
      if (!slider) continue;
      slider.value = s[key] ?? fallback;
      if (badge) badge.textContent = fmt(slider.value);
    }
  }

  function saveParams() {
    const s = db.getSettings();
    for (const [sliderId, , key, , fmt] of SLIDERS) {
      const raw = q(sliderId).value;
      s[key] = key === "maxTokens" || key === "maxContextTokens" ? parseInt(raw, 10) : parseFloat(raw);
      void fmt;
    }
    db.saveSettings(s);
    onSettingsChanged();
    toast("Generation parameters saved.", "success");
  }

  for (const [sliderId, badgeId, , , fmt] of SLIDERS) {
    q(sliderId)?.addEventListener("input", (e) => {
      const badge = q(badgeId);
      if (badge) badge.textContent = fmt(e.target.value);
    });
  }

  q("popup-save-engine-btn").addEventListener("click", saveEngine);
  q("popup-save-params-btn").addEventListener("click", saveParams);

  q("popup-fetch-models-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.classList.add("is-loading");
    try {
      const models = await engine.fetchAvailableModels(
        q("popup-api-endpoint").value.trim() || undefined,
        q("popup-api-key").value.trim() || undefined,
      );
      const s = db.getSettings();
      s.availableModels = models;
      db.saveSettings(s);
      onSettingsChanged();
      renderModels(models, q("popup-model-select").value);
      toast(`Fetched ${models.length} models.`, "success");
    } catch (err) {
      toast(`Fetch models failed: ${err.message}`, "error");
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-loading");
    }
  });

  // --- persona and directive lists ---------------------------------------

  async function renderPersonas() {
    const container = q("settings-personas-list");
    const personas = await db.getAllPersonas();
    container.textContent = "";
    if (!personas.length) {
      container.innerHTML = `<p class="rp-help">No personas yet. Create one to define who you are in a scene.</p>`;
      return;
    }
    for (const p of personas) {
      const isDefault = Boolean(p.isDefault);
      const img = p.avatar && (p.avatar.startsWith("data:") || p.avatar.startsWith("http"));
      const row = document.createElement("article");
      row.className = "rp-panel rp-persona-row";
      row.innerHTML = `
        <div class="rp-persona-row__identity">
          <div class="rp-avatar rp-avatar--lg${img ? " rp-avatar--user" : ""}">${img ? `<img src="${escapeAttr(p.avatar)}" alt="">` : escapeHtml((p.name || "U").charAt(0).toUpperCase())}</div>
          <div class="rp-persona-row__heading">
            <h3 class="rp-persona-row__title">${escapeHtml(p.name || "Unnamed persona")}</h3>
            ${isDefault ? `<span class="rp-badge rp-badge--annotation">Default</span>` : ""}
          </div>
        </div>
        <p class="rp-persona-row__blurb">${escapeHtml(p.description || p.template || "No description yet.")}</p>
        <div class="rp-persona-row__actions">
          ${isDefault ? "" : `<button type="button" class="rp-btn rp-btn--ghost rp-btn--sm" data-default>Set default</button>`}
          <button type="button" class="rp-btn rp-btn--ghost rp-btn--sm" data-edit>Edit</button>
          ${isDefault ? "" : `<button type="button" class="rp-btn rp-btn--danger-ghost rp-btn--sm" data-delete>Delete</button>`}
        </div>`;
      row.querySelector("[data-edit]").addEventListener("click", () => openPersona(p.id));
      row.querySelector("[data-default]")?.addEventListener("click", async () => {
        await db.setDefaultPersona(p.id);
        toast(`${p.name} is now the default persona.`, "info");
        await renderPersonas();
        await onPresetsChanged();
      });
      row.querySelector("[data-delete]")?.addEventListener("click", async () => {
        const ok = await confirm({ title: "Delete this persona?", body: `"${p.name}" is removed.`, confirmLabel: "Delete persona", tone: "danger" });
        if (!ok) return;
        await db.deletePersona(p.id);
        toast("Persona deleted.", "info");
        await renderPersonas();
        await onPresetsChanged();
      });
      container.appendChild(row);
    }
  }

  async function renderDirectives() {
    const container = q("settings-system-prompts-list");
    const directives = await db.getAllDirectives();
    container.textContent = "";
    if (!directives.length) {
      container.innerHTML = `<p class="rp-help">No system prompts yet. Create one to govern narrative voice.</p>`;
      return;
    }
    for (const d of directives) {
      const isDefault = Boolean(d.isDefault);
      const row = document.createElement("article");
      row.className = "rp-panel rp-directive-row";
      row.innerHTML = `
        <div class="rp-directive-row__heading">
          <h3 class="rp-directive-row__title">${escapeHtml(d.name || "Unnamed prompt")}</h3>
          ${isDefault ? `<span class="rp-badge rp-badge--annotation">Default</span>` : ""}
        </div>
        <p class="rp-directive-row__blurb">${escapeHtml(d.description || (d.content ? `${d.content.slice(0, 140)}...` : "No description yet."))}</p>
        <div class="rp-directive-row__actions">
          ${isDefault ? "" : `<button type="button" class="rp-btn rp-btn--ghost rp-btn--sm" data-default>Set default</button>`}
          <button type="button" class="rp-btn rp-btn--ghost rp-btn--sm" data-edit>Edit</button>
          ${isDefault ? "" : `<button type="button" class="rp-btn rp-btn--danger-ghost rp-btn--sm" data-delete>Delete</button>`}
        </div>`;
      row.querySelector("[data-edit]").addEventListener("click", () => openDirective(d.id));
      row.querySelector("[data-default]")?.addEventListener("click", async () => {
        await db.setDefaultDirective(d.id);
        toast(`${d.name} is now the default system prompt.`, "info");
        await renderDirectives();
        await onPresetsChanged();
      });
      row.querySelector("[data-delete]")?.addEventListener("click", async () => {
        const ok = await confirm({ title: "Delete this prompt?", body: `"${d.name}" is removed.`, confirmLabel: "Delete prompt", tone: "danger" });
        if (!ok) return;
        await db.deleteDirective(d.id);
        toast("Prompt deleted.", "info");
        await renderDirectives();
        await onPresetsChanged();
      });
      container.appendChild(row);
    }
  }

  q("create-new-persona-btn").addEventListener("click", () => openPersona(null));
  q("create-new-sysprompt-btn").addEventListener("click", () => openDirective(null));

  // --- editors ------------------------------------------------------------

  let editAvatar = null;

  function paintAvatar() {
    const preview = qp("editor-persona-avatar-preview");
    const name = qp("editor-persona-name").value.trim();
    if (editAvatar && (editAvatar.startsWith("data:") || editAvatar.startsWith("http"))) {
      preview.innerHTML = `<img src="${escapeAttr(editAvatar)}" alt="" style="width:100%;height:100%;object-fit:cover;">`;
      qp("editor-persona-remove-avatar-btn").hidden = false;
    } else {
      preview.innerHTML = `<span class="rp-avatar__initials" id="editor-persona-avatar-text">${escapeHtml((name.charAt(0) || "U").toUpperCase())}</span>`;
      qp("editor-persona-remove-avatar-btn").hidden = true;
    }
  }

  async function compress(file, maxSize = 256) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const img = await new Promise((resolve) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => resolve(null);
      i.src = dataUrl;
    });
    if (!img) return dataUrl;
    let w = img.width;
    let h = img.height;
    if (w > h && w > maxSize) { h = Math.round((h * maxSize) / w); w = maxSize; }
    else if (h > maxSize) { w = Math.round((w * maxSize) / h); h = maxSize; }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/webp", 0.85) || canvas.toDataURL("image/jpeg", 0.85);
  }

  qp("editor-persona-avatar-preview").addEventListener("click", () => qp("editor-persona-avatar-file").click());
  qp("editor-persona-avatar-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      editAvatar = await compress(file);
      paintAvatar();
    } catch (err) {
      toast(`Could not load that image: ${err.message}`, "error");
    }
  });
  qp("editor-persona-remove-avatar-btn").addEventListener("click", () => {
    editAvatar = null;
    paintAvatar();
  });
  qp("editor-persona-name").addEventListener("input", () => {
    if (!editAvatar) paintAvatar();
  });

  async function openPersona(id = null) {
    openDialog("personaEditor", id);
    editAvatar = null;
    qp("editor-persona-title").textContent = id ? "Edit persona" : "Create persona";
    if (id) {
      const persona = await db.getPersona(id);
      if (persona) {
        qp("editor-persona-name").value = persona.name || "";
        qp("editor-persona-desc").value = persona.description || "";
        qp("editor-persona-template").value = persona.template || "";
        editAvatar = persona.avatar || null;
      }
    } else {
      qp("editor-persona-name").value = "";
      qp("editor-persona-desc").value = "";
      qp("editor-persona-template").value = "";
    }
    paintAvatar();
    qp("editor-persona-name").focus();
  }

  async function openDirective(id = null) {
    openDialog("directiveEditor", id);
    qd("editor-directive-title").textContent = id ? "Edit prompt" : "Create prompt";
    if (id) {
      const d = await db.getDirective(id);
      if (d) {
        qd("editor-directive-name").value = d.name || "";
        qd("editor-directive-desc").value = d.description || "";
        qd("editor-directive-content").value = d.content || "";
      }
    } else {
      qd("editor-directive-name").value = "";
      qd("editor-directive-desc").value = "";
      qd("editor-directive-content").value = "";
    }
    qd("editor-directive-name").focus();
  }

  qp("close-editor-modal-btn").addEventListener("click", closeDialog);
  qp("cancel-editor-btn").addEventListener("click", closeDialog);
  qd("close-editor-modal-directive-btn").addEventListener("click", closeDialog);
  qd("cancel-directive-btn").addEventListener("click", closeDialog);

  qp("save-editor-btn").addEventListener("click", async () => {
    const name = qp("editor-persona-name").value.trim();
    if (!name) {
      toast("A persona needs a name.", "error");
      qp("editor-persona-name").focus();
      return;
    }
    await db.savePersona({
      id: getModalPayload() || `persona_${Date.now()}`,
      name,
      description: qp("editor-persona-desc").value.trim(),
      template: qp("editor-persona-template").value,
      avatar: editAvatar || undefined,
    });
    await renderPersonas();
    await onPresetsChanged();
    closeDialog();
    toast(`Persona ${name} saved.`, "success");
  });

  qd("save-directive-btn").addEventListener("click", async () => {
    const name = qd("editor-directive-name").value.trim();
    if (!name) {
      toast("A prompt needs a name.", "error");
      qd("editor-directive-name").focus();
      return;
    }
    await db.saveDirective({
      id: getModalPayload() || `directive_${Date.now()}`,
      name,
      description: qd("editor-directive-desc").value.trim(),
      content: qd("editor-directive-content").value,
    });
    await renderDirectives();
    await onPresetsChanged();
    closeDialog();
    toast(`Prompt ${name} saved.`, "success");
  });

  // --- public API ---------------------------------------------------------

  const api = {
    open(tabId = null) {
      openDialog("settings");
      loadEngine();
      loadParams();
      renderPersonas();
      renderDirectives();
      selectTab(tabId || "settings-engine-tab");
    },
    loadEngine,
    loadParams,
    renderPersonas,
    renderDirectives,
    openPersona,
    openDirective,
    selectTab,
  };
  return api;
}
