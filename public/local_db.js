// Default AGENTS.md craft directive contract
export const DEFAULT_AGENTS_CONTRACT = `# AGENTS.md — Author's Craft Directive

You are the resident author's workstation for long-form narrative fiction and roleplay.
You carry continuity, atmosphere, and momentum across turns without losing voice.

## 1. Craft Rules
- Advance immediately from the trailing beat. Never recap, repeat, or summarize {{user}}'s prior action or dialogue.
- End cleanly on your character's immediate reaction, dialogue, or physical gesture. Never append concluding questions or meta-prompts (e.g. "What do you do next?", "Shall we proceed?").
- Stay in character consciousness. Never invent actions, speech, sensations, or inner thoughts for {{user}}.
- Ground scenes in concrete physical details, sensory specifics, and precise verbs; avoid decorative adjective stacking.
- Ban generic AI vocabulary ("shivers down spine", "testament to", "palpable tension", "intricate tapestry", "dance of shadows").
- Never use em dashes ("—" or "--"). Use commas, periods, or natural syntax for pauses.
- Maintain the character's unique register and worldview without generic morality filters.

## 2. Pacing & Tone
- Energy: active, deliberate, carrying scene momentum.
- Rhythm: varied sentence structure without predictable triplets or theatrical fragments.
- Motion: spatial awareness, physical gestures, and environment interaction.`;

export const DEFAULT_SETTINGS = {
  // Inference Endpoint
  apiEndpoint: "",
  apiKey: "",
  model: "",
  availableModels: [], // Cached list from endpoint fetch

  // Core Generation Samplers (Optimized for creative RP prose)
  // ponytail: tuned for modern instruct-tuned chat models (Claude/GPT/Gemini/DeepSeek
  // via OpenRouter); adjust if targeting base completions models instead.
  temperature: 0.95, // 0.8-1.1 creative-prose sweet spot; pairs with min_p (when set) as the tail control since top_p is left at provider default
  topP: 1, // omitted from request body (buildRequestBody skips >=1): modern provider guidance is temperature OR top_p, not both
  minP: 0, // omitted from request body (buildRequestBody skips <=0): OpenAI/Anthropic silently ignore min_p (llama.cpp/vLLM-ism), so 0 = cross-provider "send provider default"
  frequencyPenalty: 0, // not sent: anti-slop is enforced by the AGENTS contract; penalties degrade instruct-tuned coherence and punish legitimately repeated story vocabulary (names, refrains)
  presencePenalty: 0, // not sent: same rationale as frequencyPenalty
  maxTokens: 1200, // <thought> blocks eat ~200-600 before visible prose; 1200 leaves 600-1000 visible tokens (typical RP reply 300-800) without truncating mid-scene
  // Total request window: input + requested output + a small estimator margin.
  // `maxTokens` is a ceiling, honoured in full whenever the input leaves room
  // for it; the only thing that can shrink it is the need to leave a minimum
  // input floor. There is no fixed-percentage reservation.
  maxContextTokens: 65536, // modern chat models are 128k-1M; 64k gives long RP sessions room before ledger folding while keeping prefix-cache footprint moderate
  // Directives & Block 0 contract
  agentsContract: DEFAULT_AGENTS_CONTRACT,

  // Turn mode: "normal" (freeform author input) or "choice" (interactive choice menu)
  choiceMode: "normal",
  choiceModel: "",
};

const DB_NAME = "vibe_rp";
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
const PERSONA_PRESETS = {
  key: "vibe_rp_personas",
  prefix: "persona",
  defaultFactory: () => ({
    id: "persona_default",
    name: "User",
    avatar: "U",
    description: "The viewpoint protagonist and active participant in the scene. Drives choices, takes physical action, and engages directly in dialogue.",
    isDefault: true,
  }),
  cardField: "userPersonaId",
  dataField: "userPersonaId",
};

const DIRECTIVE_PRESETS = {
  key: "vibe_rp_directives",
  prefix: "directive",
  defaultFactory: () => ({
    id: "directive_default",
    name: "Author's Craft Directive",
    description: "Canonical AGENTS.md contract with sensory grounding, momentum, and anti-cliche rules.",
    content: DEFAULT_AGENTS_CONTRACT,
    isDefault: true,
    updatedAt: Date.now(),
  }),
  cardField: "directivePresetId",
  dataField: "directivePresetId",
};


export class LocalDb {
  static db = null;

  static async open() {
    if (this.db) return this.db;
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
        resolve(req.result);
      };
      req.onerror = () => reject(LocalDb.#wrapStorageError(req.error, "open"));
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

  static async getAllCards() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("cards", "readonly");
      const req = tx.objectStore("cards").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(LocalDb.#wrapStorageError(req.error, "getAllCards"));
    });
  }

  static async saveCard(card) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("cards", "readwrite");
      tx.objectStore("cards").put(card);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(LocalDb.#wrapStorageError(tx.error, "saveCard"));
    });
  }

  static async saveSession(session) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").put(session);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(LocalDb.#wrapStorageError(tx.error, "saveSession"));
    });
  }

  static async getSessionsForCard(characterId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readonly");
      // Served by the cardId index: one indexed lookup instead of a full-store
      // scan per card (defect 6).
      const req = tx.objectStore("sessions").index("cardId").getAll(characterId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(LocalDb.#wrapStorageError(req.error, "getSessionsForCard"));
    });
  }
  static async deleteSession(sessionId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").delete(sessionId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(LocalDb.#wrapStorageError(tx.error, "deleteSession"));
    });
  }

  static async deleteCard(cardId) {
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
      tx.onerror = () => reject(LocalDb.#wrapStorageError(tx.error, "deleteCard"));
      tx.onabort = () => reject(LocalDb.#wrapStorageError(tx.error, "deleteCard"));
    });
  }


  static #presets({ key, prefix, defaultFactory, cardField, dataField }) {
    const read = () => {
      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          const list = JSON.parse(raw);
          if (Array.isArray(list) && list.length > 0) return list;
        }
      } catch (_) {}
      const seed = defaultFactory();
      localStorage.setItem(key, JSON.stringify([seed]));
      return [seed];
    };
    return {
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
  }

  static getAllPersonas() { return this.#presets(PERSONA_PRESETS).list(); }
  static getPersona(id) { return this.#presets(PERSONA_PRESETS).get(id); }
  static savePersona(p) { return this.#presets(PERSONA_PRESETS).save(p); }
  static deletePersona(id) { return this.#presets(PERSONA_PRESETS).remove(id); }
  static getDefaultPersona() { return this.#presets(PERSONA_PRESETS).getDefault(); }
  static setDefaultPersona(id) { return this.#presets(PERSONA_PRESETS).setDefault(id); }
  static resolvePersonaForCard(card) { return this.#presets(PERSONA_PRESETS).resolveForCard(card); }

  static getAllDirectives() { return this.#presets(DIRECTIVE_PRESETS).list(); }
  static getDirective(id) { return this.#presets(DIRECTIVE_PRESETS).get(id); }
  static saveDirective(d) { return this.#presets(DIRECTIVE_PRESETS).save(d); }
  static deleteDirective(id) { return this.#presets(DIRECTIVE_PRESETS).remove(id); }
  static getDefaultDirective() { return this.#presets(DIRECTIVE_PRESETS).getDefault(); }
  static setDefaultDirective(id) { return this.#presets(DIRECTIVE_PRESETS).setDefault(id); }
  static resolveDirectiveForCard(card) { return this.#presets(DIRECTIVE_PRESETS).resolveForCard(card); }

  // Settings (synchronous storage via localStorage).
  static getSettings() {
    try {
      const raw = localStorage.getItem("vibe_rp_settings");
      if (raw) {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      }
    } catch (_) {}
    return { ...DEFAULT_SETTINGS };
  }

  static saveSettings(settings) {
    localStorage.setItem("vibe_rp_settings", JSON.stringify(settings));
  }
}
