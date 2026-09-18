// Default AGENTS.md craft directive contract
export const DEFAULT_AGENTS_CONTRACT = `# AGENTS.md — Author's Craft Directive

You are the resident author's workstation for long-form narrative fiction and roleplay.
You carry continuity, atmosphere, and momentum across turns without losing voice.

## 1. Craft Rules
- Never use em dashes ("—" or "--"). Use commas, periods, or natural syntax for pauses.
- Ban generic AI vocabulary ("shivers down spine", "testament to", "palpable tension", "intricate tapestry", "dance of shadows").
- Ground scenes in concrete physical details, sensory specifics, and precise verbs.
- Maintain the character's unique register and worldview without generic morality filters.
- Stay in character consciousness. Never invent actions or inner thoughts for {{user}}.

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
  temperature: 0.85,
  topP: 0.95,
  minP: 0.05,
  frequencyPenalty: 0.25,
  presencePenalty: 0.15,
  maxTokens: 1200,
  // Total window: input + output. The engine subtracts maxTokens from this to
  // size the prompt, so raising maxTokens shrinks the history budget.
  maxContextTokens: 16384,

  // Directives & Block 0 contract
  agentsContract: DEFAULT_AGENTS_CONTRACT,

  // Cognitive Layer
  enableSubagentThoughts: true,

  // Stable provider routing key for this conversation. Sent as
  // `prompt_cache_key`; it is not part of the rendered prompt, so it cannot
  // invalidate a cached prefix and only improves cache-hit routing.
  cacheKey: "",
};

const DB_NAME = "vibe_rp";
const DB_VERSION = 1;

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
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
  }

  static async getAllCards() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("cards", "readonly");
      const req = tx.objectStore("cards").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  static async saveCard(card) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("cards", "readwrite");
      tx.objectStore("cards").put(card);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  static async saveSession(session) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").put(session);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  static async getSessionsForCard(characterId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readonly");
      const req = tx.objectStore("sessions").getAll();
      req.onsuccess = () => {
        const all = req.result || [];
        const filtered = all.filter((s) => s.cardId === characterId);
        resolve(filtered);
      };
      req.onerror = () => reject(req.error);
    });
  }
  static async deleteSession(sessionId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").delete(sessionId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  static async deleteCard(cardId) {
    const db = await this.open();
    // delete all sessions for this card first
    const sessions = await this.getSessionsForCard(cardId);
    for (const s of sessions) await this.deleteSession(s.id);
    return new Promise((resolve, reject) => {
      const tx = db.transaction("cards", "readwrite");
      tx.objectStore("cards").delete(cardId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // --- User Persona Presets (Fast, Synchronous Storage via localStorage) ---
  static async getAllPersonas() {
    try {
      const raw = localStorage.getItem("vibe_rp_personas");
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list) && list.length > 0) return list;
      }
    } catch (_) {}
    const defaultPersona = {
      id: "persona_default",
      name: "User",
      avatar: "U",
      description: "The interlocutor engaging in the scene.",
      isDefault: true,
      updatedAt: Date.now()
    };
    localStorage.setItem("vibe_rp_personas", JSON.stringify([defaultPersona]));
    return [defaultPersona];
  }

  static async getPersona(personaId) {
    if (!personaId) return null;
    const personas = await this.getAllPersonas();
    return personas.find(p => p.id === personaId) || null;
  }

  static async savePersona(persona) {
    const personas = await this.getAllPersonas();
    if (!persona.id) persona.id = `persona_${Date.now()}`;
    persona.updatedAt = Date.now();
    const idx = personas.findIndex(p => p.id === persona.id);
    if (idx >= 0) personas[idx] = persona;
    else personas.push(persona);
    localStorage.setItem("vibe_rp_personas", JSON.stringify(personas));
    return persona;
  }

  static async deletePersona(personaId) {
    const personas = await this.getAllPersonas();
    const filtered = personas.filter(p => p.id !== personaId);
    localStorage.setItem("vibe_rp_personas", JSON.stringify(filtered));
  }

  static async getDefaultPersona() {
    const personas = await this.getAllPersonas();
    return personas.find(p => p.isDefault) || personas[0] || { id: "persona_default", name: "User", description: "" };
  }

  static async setDefaultPersona(personaId) {
    const personas = await this.getAllPersonas();
    for (const p of personas) {
      p.isDefault = p.id === personaId;
    }
    localStorage.setItem("vibe_rp_personas", JSON.stringify(personas));
  }

  static async resolvePersonaForCard(card) {
    const personaId = card?.userPersonaId || card?.data?.userPersonaId;
    if (personaId) {
      const p = await this.getPersona(personaId);
      if (p) return p;
    }
    return await this.getDefaultPersona();
  }

  // --- AGENTS.md Directives Presets (Fast, Synchronous Storage via localStorage) ---
  static async getAllDirectives() {
    try {
      const raw = localStorage.getItem("vibe_rp_directives");
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list) && list.length > 0) return list;
      }
    } catch (_) {}
    const defaultDirective = {
      id: "directive_default",
      name: "Author's Craft Directive",
      description: "Canonical AGENTS.md contract with sensory grounding, momentum, and anti-cliche rules.",
      content: DEFAULT_AGENTS_CONTRACT,
      isDefault: true,
      updatedAt: Date.now()
    };
    localStorage.setItem("vibe_rp_directives", JSON.stringify([defaultDirective]));
    return [defaultDirective];
  }

  static async getDirective(directiveId) {
    if (!directiveId) return null;
    const directives = await this.getAllDirectives();
    return directives.find(d => d.id === directiveId) || null;
  }

  static async saveDirective(directive) {
    const directives = await this.getAllDirectives();
    if (!directive.id) directive.id = `directive_${Date.now()}`;
    directive.updatedAt = Date.now();
    const idx = directives.findIndex(d => d.id === directive.id);
    if (idx >= 0) directives[idx] = directive;
    else directives.push(directive);
    localStorage.setItem("vibe_rp_directives", JSON.stringify(directives));
    return directive;
  }

  static async deleteDirective(directiveId) {
    const directives = await this.getAllDirectives();
    const filtered = directives.filter(d => d.id !== directiveId);
    localStorage.setItem("vibe_rp_directives", JSON.stringify(filtered));
  }

  static async getDefaultDirective() {
    const directives = await this.getAllDirectives();
    return directives.find(d => d.isDefault) || directives[0] || { id: "directive_default", name: "Default Contract", content: DEFAULT_AGENTS_CONTRACT };
  }

  static async setDefaultDirective(directiveId) {
    const directives = await this.getAllDirectives();
    for (const d of directives) {
      d.isDefault = d.id === directiveId;
    }
    localStorage.setItem("vibe_rp_directives", JSON.stringify(directives));
  }

  static async resolveDirectiveForCard(card) {
    const directiveId = card?.directivePresetId || card?.data?.directivePresetId;
    if (directiveId) {
      const d = await this.getDirective(directiveId);
      if (d) return d;
    }
    return await this.getDefaultDirective();
  }
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
