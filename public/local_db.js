// The default craft directive.
//
// Phrased outcome-first. The earlier version stated most rules as prohibitions
// ("Never...", "Do NOT...", "Non-Negotiable...") under absolutist headings; the
// current vendor guidance is the opposite — tell the model what to do rather
// than what not to do, and drop scaffolding that only older models needed.
//
// Each line covers several rules at once, joined by commas and dashes, because
// the same requirement written across three bulleted clauses costs three times
// the tokens and reads as three demands. Every rule the previous version
// carried is still here; only the voice, the framing, and the density changed.
//
// Where a rule lives is deliberate. The authority order is stated here, once,
// rather than again in a separate precedence section: one rule, one home. The
// reader's *role* is not here at all — it is the persona slot's line, which is
// the only place that can also carry the reader's name and perspective.
export const DEFAULT_AGENTS_CONTRACT = `# AGENTS.md – Author's Craft Directive

You write long-form interactive fiction with the reader, one turn at a time, holding continuity, atmosphere, and narrative momentum.

## 1. The Reader's Turn Is Theirs
- Agency: {{user}}'s actions, dialogue, and inner life are theirs. You write {{char}}, the other characters, and the living world. Never write {{user}}'s response or dictate their unstated reactions.
- Turn shape: continue from the last beat, carry {{char}}'s reaction, spoken line, or physical action as far as it organically goes, then hand control back on an active beat.
- Authority: the User Persona and the System Directives govern language, register, and medium; the Character Preset governs character voice and worldview.
- Universal linguistic adaptation: mirror the language, regional vernacular, writing script, grammatical person (POV), and tense established by {{user}} and the opening scene. Never switch languages unless {{user}} initiates the switch.
- Medium fidelity: hold the medium set by the scenario and card directives—whether literary prose, instant messaging, screenplay, or epistolary correspondence.
- Closed narrative frame: stay inside the story rather than commenting from beside it. When the reader steps out of character in double parentheses – ((like this)) – respond briefly in kind without breaking character in the story prose.
- Narrative commitment: honor the scene's dramatic stakes and pacing without lecturing, moralizing, or sanitizing in-world conflict.

## 2. Character Integrity & Earned Progression
- Core resilience: {{char}}'s disposition, motives, flaws, boundaries, and friction hold firm under pressure, including pressure to be agreeable. Never flatten {{char}} into a compliant assistant.
- Earned shifts: while {{char}}'s core never dissolves for convenience, genuine story events, shared ordeals, kept promises, or undeniable proof earn proportionate shifts in trust, posture, and emotional openness over time.
- Bounded knowledge: characters act strictly on what they have witnessed, been told on the page, or can infer from immediate sensory cues. Unrevealed facts stay silent.

## 3. Reading & Grounding the Scene
- Voice & cadence: calibrate sentence length, paragraph density, and pacing to the scene's tension—spare and kinetic during urgent action, textured and lingering during quiet beats.
- Subtext over exposition: let characters deflect, understate, test boundaries, or pursue objectives obliquely. Show emotion through posture, breath, gaze, and hesitation rather than labeling feelings abstractly.
- Concrete continuity: physical state, injuries, fatigue, clothing, weather, lighting, spatial positions, and spent resources persist across turns until an action on the page changes them.
`;

// Universal directive export. In accordance with strictly universal localization,
// all interaction languages and regions are handled inherently at the model behavior
// and processing level without per-language templates.
export const DEFAULT_AGENTS_CONTRACT_ID = DEFAULT_AGENTS_CONTRACT;


export const DEFAULT_SETTINGS = {
  // Inference Endpoint
  apiEndpoint: "",
  apiKey: "",
  model: "",
  availableModels: [], // Cached list from endpoint fetch

  // Core Generation Samplers (Optimized for creative RP prose)
  // Tuned for modern instruct-tuned chat models; adjust if targeting
  // base completions models or reasoning models instead.
  temperature: 0.95, // 0.8-1.1 creative-prose sweet spot; pairs with min_p (when set) as the tail control since top_p is left at provider default
  topP: 1, // omitted from request body (buildRequestBody skips >=1): standard guidance is temperature OR top_p, not both
  minP: 0, // omitted from request body (buildRequestBody skips <=0): some providers silently ignore min_p, so 0 = cross-provider "send provider default"
  frequencyPenalty: 0, // not sent: anti-slop is enforced by the AGENTS contract; penalties degrade instruct-tuned coherence and punish legitimately repeated story vocabulary (names, refrains)
  presencePenalty: 0, // not sent: same rationale as frequencyPenalty
  maxTokens: 1200, // <thought> blocks eat ~200-600 before visible prose; 1200 leaves 600-1000 visible tokens (typical RP reply 300-800) without truncating mid-scene
  // Total request window: input + requested output + a small estimator margin.
  // `maxTokens` is a ceiling, honoured in full whenever the input leaves room
  // for it; the only thing that can shrink it is the need to leave a minimum
  // input floor. There is no fixed-percentage reservation.
  //
  // This is a *guess* at the model's real window, and the app cannot do better
  // than a guess: no OpenAI-compatible endpoint exposes its context size. It is
  // deliberately generous, because a window that is too large keeps the verbatim
  // transcript — which is strictly better continuity than a folded ledger — and
  // costs nothing where the provider caches. The two failure modes are handled
  // elsewhere rather than by shrinking this number:
  //   - too large for the model in use: the provider rejects, the engine reads
  //     the real window out of the error and re-fits, and the value it learned
  //     is persisted, so the mistake happens once per model rather than per turn;
  //   - a provider that adds a hidden preamble: measured per endpoint and
  //     charged against the window, so the budget reflects what is really sent.
  maxContextTokens: 65536,
  // Directives & Block 0 contract
  agentsContract: DEFAULT_AGENTS_CONTRACT,

  // Turn mode: "normal" (freeform author input) or "choice" (interactive choice menu)
  choiceMode: "normal",
  choiceModel: "",
  // The model that performs folds ("" = same as the main model). A fold is
  // extraction over tokens already paid for once — read the transcript, merge it
  // into the ledger — and it writes none of the prose the reader sees. Measured
  // on a real endpoint, one fold generates ~2,200 tokens, ~72% of them invisible
  // reasoning, which makes it about as expensive as a full narrative turn while
  // being a far simpler task. Pointing it at a cheap tier is the largest
  // structural saving available, and empty keeps every existing setup unchanged.
  summaryModel: "",
  // Choice deliberation: "auto" (default) asks the choice model to think the
  // scene through silently only when no reasoning effort is configured, so a
  // reasoning model is not taxed with a manual chain-of-thought instruction.
  // "always" for a weak local model, "never" for the leanest possible request.
  choiceDeliberation: "auto",
  reasoningEffort: "", // optional: "low", "medium", "high", or "" (default/auto)
};

const DB_NAME = "vibe_rp";
// Every localStorage key this app owns carries this prefix. It is the namespace
// boundary: `snapshot()` exports exactly these, `clearAll()` removes exactly
// these, and `restore()` accepts exactly these. One prefix, one meaning, so the
// export and import paths cannot disagree about what belongs to the app.
const KEY_PREFIX = "vibe_rp";
// v2 adds the sessions.cardId index (defect 6). The upgrade path below creates
// it in place, so existing databases keep every row.
const DB_VERSION = 2;

/**
 * Rejected when the browser refuses a write for lack of space. Surfacing a
 * typed error turns a silent data loss (or an unbounded hang) into something
 * the caller can catch, report, and recover from.
 */
export class LocalDbQuotaError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "QuotaExceededError";
    this.code = "QUOTA_EXCEEDED";
    this.cause = cause;
  }
}

/**
 * Rejected when an upgrade is blocked by another open connection. Without this,
 * `open()` would simply never settle.
 */
export class LocalDbBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalDbBlockedError";
    this.code = "BLOCKED";
  }
}

// Generic presets store (personas and directives; sync via localStorage).
// The card→preset resolution rule (card root, then card.data, then default)
// lives in exactly one place: #presets().resolveForCard.
//
// The default persona is deliberately thin. The previous one restated the
// identity and perception rules the craft contract already states for every
// character — agency, observable demeanour, no access to unspoken thoughts —
// which put two versions of one rule in every request and made the weakest copy
// the one nearest the reader's own turn. What belongs here is only what no
// other slot can say: who the reader is, and the perspective their turn is
// written from. The absence of a name is carried by the empty string, which
// renders as the bare `[User Persona]` label rather than inventing one.
export const PERSONA_PRESETS = {
  key: "vibe_rp_personas",
  prefix: "persona",
  defaultFactory() {
    return {
      id: "persona_default",
      name: "",
      avatar: "U",
      description:
        "The viewpoint protagonist: the reader's own character, present in the scene and perceiving it from their own narrative distance. Match the point of view, pronouns, language, and register established in the reader's turns and the opening scene.",
      isDefault: true,
    };
  },
  cardField: "userPersonaId",
  dataField: "userPersonaId",
};

// Built-in craft contract directive: strictly universal architecture with zero
// per-language templates. Adapts inherently to any language, dialect, or region
// at the model behavior level.
const DIRECTIVE_PRESETS = {
  key: "vibe_rp_directives",
  prefix: "directive",
  builtins: () => [
    {
      id: "directive_default",
      name: "Author's Craft Directive",
      description: "Canonical AGENTS.md contract with universal sensory grounding, momentum, and anti-cliche rules.",
      content: DEFAULT_AGENTS_CONTRACT,
      isDefault: true,
      builtin: true,
      updatedAt: Date.now(),
    },
  ],
  defaultFactory: () => ({
    id: "directive_default",
    name: "Author's Craft Directive",
    description: "Canonical AGENTS.md contract with universal sensory grounding, momentum, and anti-cliche rules.",
    content: DEFAULT_AGENTS_CONTRACT,
    isDefault: true,
    builtin: true,
    updatedAt: Date.now(),
  }),
  cardField: "directivePresetId",
  dataField: "directivePresetId",
};


// ---------------------------------------------------------------------------
// Backend: IndexedDB (cards and sessions)
// ---------------------------------------------------------------------------

/**
 * Owns the IndexedDB connection cache and every card/session transaction. The
 * connection is cached on the instance, so an injected store carries its own
 * handle instead of sharing one global. Storage failures are normalised into
 * typed errors callers can branch on.
 */
class IdbStore {
  db = null;

  async open() {
    if (this.db) return this.db;
    if (typeof indexedDB === "undefined") {
      throw new Error("IndexedDB is not supported in this environment");
    }
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("cards")) {
          db.createObjectStore("cards", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("sessions")) {
          db.createObjectStore("sessions", { keyPath: "id" });
        }
        // Index upgrade for existing v1 databases: create the cardId index in
        // place. IndexedDB runs this inside the version-change transaction, so
        // no existing session row is touched (defect 6, no data loss).
        const sessions = e.target.transaction.objectStore("sessions");
        if (!sessions.indexNames.contains("cardId")) {
          sessions.createIndex("cardId", "cardId", { unique: false });
        }
      };
      req.onsuccess = () => {
        this.db = req.result;
        if (typeof navigator !== "undefined" && navigator?.storage?.persist) {
          try { navigator.storage.persist().catch(() => {}); } catch {}
        }
        resolve(req.result);
      };
      req.onerror = () => reject(IdbStore.#wrapStorageError(req.error, "open"));
      // Another tab holds an older version open: without this handler the
      // promise would never settle. Surface it so the UI can ask the user to
      // close the other tab instead of hanging (defect 7).
      req.onblocked = () =>
        reject(new LocalDbBlockedError("Database upgrade blocked by another open tab or window."));
    });
  }

  /** Normalises IndexedDB failures into typed errors callers can branch on. */
  static #wrapStorageError(err, context) {
    const name = err && err.name;
    if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") {
      return new LocalDbQuotaError(`Storage quota exceeded during ${context}.`, err);
    }
    return err || new Error(`IndexedDB failure during ${context}.`);
  }

  async getAllCards() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("cards", "readonly");
      const req = tx.objectStore("cards").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(IdbStore.#wrapStorageError(req.error, "getAllCards"));
    });
  }

  async saveCard(card) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("cards", "readwrite");
      tx.objectStore("cards").put(card);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(IdbStore.#wrapStorageError(tx.error, "saveCard"));
      tx.onabort = () => reject(IdbStore.#wrapStorageError(tx.error, "saveCard"));
    });
  }

  async saveSession(session) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").put(session);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(IdbStore.#wrapStorageError(tx.error, "saveSession"));
      tx.onabort = () => reject(IdbStore.#wrapStorageError(tx.error, "saveSession"));
    });
  }

  async getSessionsForCard(characterId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readonly");
      // Served by the cardId index: one indexed lookup instead of a full-store
      // scan per card (defect 6).
      const req = tx.objectStore("sessions").index("cardId").getAll(characterId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(IdbStore.#wrapStorageError(req.error, "getSessionsForCard"));
    });
  }

  async getAllSessions() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readonly");
      const req = tx.objectStore("sessions").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(IdbStore.#wrapStorageError(req.error, "getAllSessions"));
    });
  }

  async countSessions() {
    const db = await this.open();
    return new Promise((resolve) => {
      try {
        const tx = db.transaction("sessions", "readonly");
        const store = tx.objectStore("sessions");
        if (typeof store.count === "function") {
          const req = store.count();
          req.onsuccess = () => resolve(req.result || 0);
          req.onerror = () => resolve(0);
        } else {
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result?.length || 0);
          req.onerror = () => resolve(0);
        }
      } catch (_) {
        resolve(0);
      }
    });
  }

  async deleteSession(sessionId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").delete(sessionId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(IdbStore.#wrapStorageError(tx.error, "deleteSession"));
      tx.onabort = () => reject(IdbStore.#wrapStorageError(tx.error, "deleteSession"));
    });
  }

  async deleteCard(cardId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      // Card and its sessions share one transaction: the fan-out delete either
      // commits entirely or not at all, so no orphaned sessions survive a
      // failure (defect 6).
      const tx = db.transaction(["cards", "sessions"], "readwrite");
      tx.objectStore("cards").delete(cardId);
      const sessionStore = tx.objectStore("sessions");
      const req = sessionStore.index("cardId").getAllKeys(cardId);
      req.onsuccess = () => {
        for (const key of req.result || []) sessionStore.delete(key);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(IdbStore.#wrapStorageError(tx.error, "deleteCard"));
      tx.onabort = () => reject(IdbStore.#wrapStorageError(tx.error, "deleteCard"));
    });
  }

  async clearAllSessions() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(IdbStore.#wrapStorageError(tx.error, "clearAllSessions"));
      tx.onabort = () => reject(IdbStore.#wrapStorageError(tx.error, "clearAllSessions"));
    });
  }

  async clearAllCards() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["cards", "sessions"], "readwrite");
      tx.objectStore("cards").clear();
      tx.objectStore("sessions").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(IdbStore.#wrapStorageError(tx.error, "clearAllCards"));
      tx.onabort = () => reject(IdbStore.#wrapStorageError(tx.error, "clearAllCards"));
    });
  }

  /** Bulk write of a backup's rows; `replace` clears both stores first. */
  async importRows({ cards, sessions, mode = "merge" }) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["cards", "sessions"], "readwrite");
      const cardStore = tx.objectStore("cards");
      const sessionStore = tx.objectStore("sessions");

      if (mode === "replace") {
        cardStore.clear();
        sessionStore.clear();
      }

      for (const card of cards) {
        if (card && card.id) cardStore.put(card);
      }
      for (const session of sessions) {
        if (session && session.id) sessionStore.put(session);
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(IdbStore.#wrapStorageError(tx.error, "importRows"));
      tx.onabort = () => reject(IdbStore.#wrapStorageError(tx.error, "importRows"));
    });
  }
}

// ---------------------------------------------------------------------------
// Backend: localStorage (presets, settings, import-session cache)
// ---------------------------------------------------------------------------

/**
 * Owns every synchronous key-value concern: the persona/directive preset
 * stores (seeded on first read) and the settings blob. Kept apart from
 * IdbStore because the two have nothing in common but a name — one is async
 * and transactional, the other is a synchronous string map.
 */
class LocalStore {
  #presetStores = new Map();

  /**
   * A preset store over one localStorage key. `cardField`/`dataField` name the
   * card fields that point at a preset id; the resolution rule (card root,
   * then card.data, then default) lives here and only here.
   */
  presets(spec) {
    const existing = this.#presetStores.get(spec.key);
    if (existing) return existing;
    const { key, prefix, defaultFactory, cardField, dataField, builtins } = spec;
    // A store may ship more than one built-in. `defaultFactory()` stays the
    // single-object answer everywhere else; `seed()` is the only place that
    // needs the plural, so the plural lives here and nowhere else.
    const seed = () => (builtins ? builtins() : [defaultFactory()]);
    const read = () => {
      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          const list = JSON.parse(raw);
          if (Array.isArray(list) && list.length > 0) return list;
        }
      } catch (_) {}
      const fresh = seed();
      localStorage.setItem(key, JSON.stringify(fresh));
      return fresh;
    };
    const store = {
      async list() {
        return read();
      },
      async get(id) {
        if (!id) return null;
        return read().find((p) => p.id === id) || null;
      },
      async save(preset) {
        const items = read();
        if (!preset.id) preset.id = `${prefix}_${Date.now()}`;
        preset.updatedAt = Date.now();
        const idx = items.findIndex((p) => p.id === preset.id);
        if (idx >= 0) items[idx] = preset;
        else items.push(preset);
        localStorage.setItem(key, JSON.stringify(items));
        return preset;
      },
      async remove(id) {
        localStorage.setItem(key, JSON.stringify(read().filter((p) => p.id !== id)));
      },
      async setDefault(id) {
        const items = read();
        for (const p of items) p.isDefault = p.id === id;
        localStorage.setItem(key, JSON.stringify(items));
      },
      async getDefault() {
        const items = read();
        return items.find((p) => p.isDefault) || items[0] || defaultFactory();
      },
      async resolveForCard(card) {
        const id = card?.[cardField] || card?.data?.[dataField];
        if (id) {
          const preset = await this.get(id);
          if (preset) return preset;
        }
        return this.getDefault();
      },
    };
    this.#presetStores.set(key, store);
    return store;
  }

  getSettings() {
    try {
      const raw = localStorage.getItem("vibe_rp_settings");
      if (raw) {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      }
    } catch (_) {}
    return { ...DEFAULT_SETTINGS };
  }

  saveSettings(settings) {
    localStorage.setItem("vibe_rp_settings", JSON.stringify(settings));
  }

  resetSettings() {
    localStorage.removeItem("vibe_rp_settings");
    return { ...DEFAULT_SETTINGS };
  }

  clearImportSession() {
    try {
      localStorage.removeItem("vibe_rp_import_session");
      localStorage.removeItem("vibe_rp_import_session_refresh_lock");
    } catch (_) {}
  }

  /** Re-seeds a preset store from its default factory (or its built-in set). */
  resetPresets({ key, defaultFactory, builtins }) {
    const fresh = builtins ? builtins() : [defaultFactory()];
    localStorage.setItem(key, JSON.stringify(fresh));
    return fresh;
  }

  /** Every vibe_rp* key currently stored, for export and replace-import. */
  snapshot() {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(KEY_PREFIX)) out[k] = localStorage.getItem(k);
      }
    } catch (_) {}
    return out;
  }

  /** Removes every vibe_rp* key. */
  clearAll() {
    try {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(KEY_PREFIX)) keysToRemove.push(k);
      }
      for (const k of keysToRemove) localStorage.removeItem(k);
    } catch (_) {}
  }

  /**
   * Writes a backup's key/value map back, returning how many keys landed.
   *
   * Only this app's own namespace is accepted, mirroring `snapshot()`. A backup
   * file is untrusted input (the reader was handed it, or downloaded it from a
   * stranger), and without the filter a crafted one writes ARBITRARY keys into
   * the origin's localStorage — including keys belonging to whatever else is
   * served from the same origin. `snapshot()` already decides what this app
   * owns; the restore path has to agree with it, or the two disagree about the
   * same namespace.
   *
   * The values stay raw: a backup legitimately carries an opaque settings blob
   * and preset lists, and re-validating their shapes here would duplicate rules
   * the readers of those keys already own. The key set is the boundary.
   */
  restore(map) {
    let count = 0;
    if (map && typeof map === "object") {
      try {
        for (const [k, v] of Object.entries(map)) {
          if (typeof k !== "string" || !k.startsWith(KEY_PREFIX)) continue;
          if (typeof v !== "string") continue;
          localStorage.setItem(k, v);
          count++;
        }
      } catch (_) {}
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

/**
 * The storage seam. An instance holds the two backends it talks to, so a
 * caller can construct one with injected stores (a fake IndexedDB, an
 * in-memory key-value map) instead of reaching for module globals. The static
 * surface delegates to a shared default instance, so every existing call site
 * keeps working unchanged while the migration to instances is incremental.
 */
export class LocalDb {
  static #defaultInstance = new LocalDb();

  constructor({ idb = new IdbStore(), local = new LocalStore() } = {}) {
    this.idb = idb;
    this.local = local;
  }

  // --- instance surface (the injectable seam) ---

  get db() {
    return this.idb.db;
  }

  set db(value) {
    this.idb.db = value;
  }

  open() {
    return this.idb.open();
  }

  getAllCards() { return this.idb.getAllCards(); }
  saveCard(card) { return this.idb.saveCard(card); }
  saveSession(session) { return this.idb.saveSession(session); }
  getSessionsForCard(characterId) { return this.idb.getSessionsForCard(characterId); }
  getAllSessions() { return this.idb.getAllSessions(); }
  deleteSession(sessionId) { return this.idb.deleteSession(sessionId); }
  deleteCard(cardId) { return this.idb.deleteCard(cardId); }
  clearAllSessions() { return this.idb.clearAllSessions(); }
  clearAllCards() { return this.idb.clearAllCards(); }

  getAllPersonas() { return this.local.presets(PERSONA_PRESETS).list(); }
  getPersona(id) { return this.local.presets(PERSONA_PRESETS).get(id); }
  savePersona(p) { return this.local.presets(PERSONA_PRESETS).save(p); }
  deletePersona(id) { return this.local.presets(PERSONA_PRESETS).remove(id); }
  getDefaultPersona() { return this.local.presets(PERSONA_PRESETS).getDefault(); }
  setDefaultPersona(id) { return this.local.presets(PERSONA_PRESETS).setDefault(id); }
  resolvePersonaForCard(card) { return this.local.presets(PERSONA_PRESETS).resolveForCard(card); }

  getAllDirectives() { return this.local.presets(DIRECTIVE_PRESETS).list(); }
  getDirective(id) { return this.local.presets(DIRECTIVE_PRESETS).get(id); }
  saveDirective(d) { return this.local.presets(DIRECTIVE_PRESETS).save(d); }
  deleteDirective(id) { return this.local.presets(DIRECTIVE_PRESETS).remove(id); }
  getDefaultDirective() { return this.local.presets(DIRECTIVE_PRESETS).getDefault(); }
  setDefaultDirective(id) { return this.local.presets(DIRECTIVE_PRESETS).setDefault(id); }
  resolveDirectiveForCard(card) { return this.local.presets(DIRECTIVE_PRESETS).resolveForCard(card); }

  getSettings() { return this.local.getSettings(); }
  saveSettings(settings) { return this.local.saveSettings(settings); }
  resetSettings() { return this.local.resetSettings(); }

  resetPersonas() { return this.local.resetPresets(PERSONA_PRESETS); }
  resetDirectives() { return this.local.resetPresets(DIRECTIVE_PRESETS); }
  clearImportSession() { return this.local.clearImportSession(); }

  async wipeAllData({ resetCache = false } = {}) {
    await this.idb.clearAllCards();
    this.local.clearAll();
    this.local.resetPresets(PERSONA_PRESETS);
    this.local.resetPresets(DIRECTIVE_PRESETS);
    this.local.resetSettings();

    if (resetCache && typeof globalThis.caches !== "undefined") {
      try {
        const names = await globalThis.caches.keys();
        for (const name of names) {
          if (name.startsWith("vibe-rp")) await globalThis.caches.delete(name);
        }
      } catch (_) {}
    }
  }

  async getStorageStats() {
    if (typeof indexedDB === "undefined") {
      const personas = (await this.local.presets(PERSONA_PRESETS).list()) || [];
      const directives = (await this.local.presets(DIRECTIVE_PRESETS).list()) || [];
      return {
        cardCount: 0,
        sessionCount: 0,
        personaCount: personas.length,
        directiveCount: directives.length,
        usage: 0,
        quota: 0,
      };
    }
    const cards = await this.idb.getAllCards();
    const sessionCount = await this.idb.countSessions();

    const personas = await this.local.presets(PERSONA_PRESETS).list();
    const directives = await this.local.presets(DIRECTIVE_PRESETS).list();

    let storageEstimate = null;
    if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
      try {
        storageEstimate = await navigator.storage.estimate();
      } catch (_) {}
    }
    let isPersisted = null;
    if (typeof navigator !== "undefined" && navigator.storage?.persisted) {
      try {
        isPersisted = Boolean(await navigator.storage.persisted());
      } catch (_) {}
    }

    return {
      cardCount: cards.length,
      sessionCount,
      personaCount: personas.length,
      directiveCount: directives.length,
      usage: storageEstimate?.usage || 0,
      quota: storageEstimate?.quota || 0,
      persisted: isPersisted,
    };
  }

  async exportAllData({ cookies = [] } = {}) {
    const cards = await this.idb.getAllCards();
    const sessions = await this.idb.getAllSessions();
    const localData = this.local.snapshot();

    const sessionData = {};
    if (typeof sessionStorage !== "undefined") {
      try {
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k && k.startsWith(KEY_PREFIX)) {
            sessionData[k] = sessionStorage.getItem(k);
          }
        }
      } catch (_) {}
    }

    return {
      format: "vibe-rp-full-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        indexedDb: {
          cards,
          sessions,
        },
        localStorage: localData,
        sessionStorage: sessionData,
        cookies: Array.isArray(cookies) ? cookies : [],
      },
    };
  }

  async importAllData(payload, { mode = "merge" } = {}) {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid backup: data is empty or not an object.");
    }

    if (payload.format === "vibe-rp-conversation") {
      if (!Array.isArray(payload.messages) || !payload.messages.length) {
        throw new Error("Legacy conversation export has no messages.");
      }
      const legacySession = {
        id: `sess_import_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        title: payload.title || "Restored chat",
        cardId: payload.cardId || "imported",
        messages: payload.messages,
        ledger: payload.ledger || "",
        consumed: payload.consumed || 0,
        updatedAt: Date.now(),
      };
      await this.idb.saveSession(legacySession);
      return {
        ok: true,
        cardsImported: 0,
        sessionsImported: 1,
        localStorageKeysImported: 0,
        cookies: [],
      };
    }

    const payloadData = payload.data || payload;
    if (payload.format !== "vibe-rp-full-backup" || !payloadData) {
      throw new Error("Invalid backup format: expected vibe-rp-full-backup.");
    }

    const { indexedDb: idbData = {}, localStorage: lsData = {}, sessionStorage: ssData = {}, cookies = [] } = payloadData;
    const cards = Array.isArray(idbData.cards) ? idbData.cards : [];
    const sessions = Array.isArray(idbData.sessions) ? idbData.sessions : [];

    await this.idb.importRows({ cards, sessions, mode });

    if (mode === "replace") this.local.clearAll();

    const lsCount = this.local.restore(lsData);

    if (ssData && typeof ssData === "object" && typeof sessionStorage !== "undefined") {
      try {
        for (const [k, v] of Object.entries(ssData)) {
          // Same namespace boundary as LocalStore.restore(): a backup is
          // untrusted input, so only this app's own prefix may land.
          if (typeof k !== "string" || !k.startsWith(KEY_PREFIX)) continue;
          if (typeof v !== "string") continue;
          sessionStorage.setItem(k, v);
        }
      } catch (_) {}
    }

    return {
      ok: true,
      cardsImported: cards.length,
      sessionsImported: sessions.length,
      localStorageKeysImported: lsCount,
      cookies: Array.isArray(cookies) ? cookies : [],
    };
  }

  // --- connection (proxied so `LocalDb.db = null` still resets the cache) ---

  static get db() {
    return this.#defaultInstance.idb.db;
  }

  static set db(value) {
    this.#defaultInstance.idb.db = value;
  }

  static open() {
    return this.#defaultInstance.idb.open();
  }

  // --- cards and sessions ---

  static getAllCards() { return this.#defaultInstance.idb.getAllCards(); }
  static saveCard(card) { return this.#defaultInstance.idb.saveCard(card); }
  static saveSession(session) { return this.#defaultInstance.idb.saveSession(session); }
  static getSessionsForCard(characterId) { return this.#defaultInstance.idb.getSessionsForCard(characterId); }
  static getAllSessions() { return this.#defaultInstance.idb.getAllSessions(); }
  static deleteSession(sessionId) { return this.#defaultInstance.idb.deleteSession(sessionId); }
  static deleteCard(cardId) { return this.#defaultInstance.idb.deleteCard(cardId); }
  static clearAllSessions() { return this.#defaultInstance.idb.clearAllSessions(); }
  static clearAllCards() { return this.#defaultInstance.idb.clearAllCards(); }

  // --- presets (personas and directives) ---

  static getAllPersonas() { return this.#defaultInstance.local.presets(PERSONA_PRESETS).list(); }
  static getPersona(id) { return this.#defaultInstance.local.presets(PERSONA_PRESETS).get(id); }
  static savePersona(p) { return this.#defaultInstance.local.presets(PERSONA_PRESETS).save(p); }
  static deletePersona(id) { return this.#defaultInstance.local.presets(PERSONA_PRESETS).remove(id); }
  static getDefaultPersona() { return this.#defaultInstance.local.presets(PERSONA_PRESETS).getDefault(); }
  static setDefaultPersona(id) { return this.#defaultInstance.local.presets(PERSONA_PRESETS).setDefault(id); }
  static resolvePersonaForCard(card) { return this.#defaultInstance.local.presets(PERSONA_PRESETS).resolveForCard(card); }

  static getAllDirectives() { return this.#defaultInstance.local.presets(DIRECTIVE_PRESETS).list(); }
  static getDirective(id) { return this.#defaultInstance.local.presets(DIRECTIVE_PRESETS).get(id); }
  static saveDirective(d) { return this.#defaultInstance.local.presets(DIRECTIVE_PRESETS).save(d); }
  static deleteDirective(id) { return this.#defaultInstance.local.presets(DIRECTIVE_PRESETS).remove(id); }
  static getDefaultDirective() { return this.#defaultInstance.local.presets(DIRECTIVE_PRESETS).getDefault(); }
  static setDefaultDirective(id) { return this.#defaultInstance.local.presets(DIRECTIVE_PRESETS).setDefault(id); }
  static resolveDirectiveForCard(card) { return this.#defaultInstance.local.presets(DIRECTIVE_PRESETS).resolveForCard(card); }

  // --- settings ---

  static getSettings() { return this.#defaultInstance.local.getSettings(); }
  static saveSettings(settings) { return this.#defaultInstance.local.saveSettings(settings); }
  static resetSettings() { return this.#defaultInstance.local.resetSettings(); }

  // --- reset and import cache ---

  static resetPersonas() { return this.#defaultInstance.local.resetPresets(PERSONA_PRESETS); }
  static resetDirectives() { return this.#defaultInstance.local.resetPresets(DIRECTIVE_PRESETS); }
  static clearImportSession() { return this.#defaultInstance.local.clearImportSession(); }

  static wipeAllData(options) { return this.#defaultInstance.wipeAllData(options); }

  // --- stats and backup ---

  static getStorageStats() { return this.#defaultInstance.getStorageStats(); }

  static exportAllData(options) { return this.#defaultInstance.exportAllData(options); }

  static importAllData(payload, options) { return this.#defaultInstance.importAllData(payload, options); }
}
