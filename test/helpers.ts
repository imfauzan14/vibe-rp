// Shared test fixtures — single source for helpers duplicated across test files.
//
// Growth rule: new tests MUST import from here instead of redefining
// words/SSE_OK/preset chunks/capture helpers. If a new fixture is needed,
// add it here so the next file reuses it.
import { estimateTokens } from "../public/browser_engine.js";

/** N words of filler prose. Shared by 7+ files needing lockstep filler. */
export const words = (n: number): string => "word ".repeat(n).trim();

/** Minimal valid SSE stream body for faked generation calls. */
export const SSE_OK = 'data: {"choices":[{"delta":{"content":"reply"}}]}\n\ndata: [DONE]\n\n';

export function sseResponse(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

/** Canonical Elena Voss preset chunk (mixed markdown/JSON/table). */
export const ELENA_CHUNK =
  "## Character Sheet\n\nElena Voss is a cartographer of dead cities. " +
  "```json\n{\"name\":\"Elena Voss\",\"notes\":\"Härte über alles.\"}\n```\n" +
  "| stat | value |\n|---|---|\n| resolve | 8/10 |\n";

/** A preset whose system-prompt cost is approximately `tokens`. */
export function presetOfTokens(tokens: number): string {
  return ELENA_CHUNK.repeat(Math.max(1, Math.ceil(tokens / estimateTokens(ELENA_CHUNK))));
}

type CardExtra = Record<string, string | null>;

interface ElenaCard {
  data: {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    mes_example: string;
    system_prompt: string;
    post_history_instructions: string;
    character_book: null;
  } & CardExtra;
}

/** Elena Voss character card with a description sized to ~`descTokens`. */
export function elenaCard(descTokens = 0, extra: CardExtra = {}): ElenaCard {
  return {
    data: {
      name: "Elena Voss",
      description: descTokens ? presetOfTokens(descTokens) : "",
      personality: "",
      scenario: "",
      mes_example: "",
      system_prompt: "",
      post_history_instructions: "",
      character_book: null,
      ...extra,
    },
  };
}

export const TEST_SETTINGS = { apiEndpoint: "https://x.test/v1", model: "m" };

interface CapturedBodies {
  gen: Array<Record<string, unknown>>;
  folds: Array<Record<string, unknown>>;
}

/**
 * Captures outgoing generation bodies while serving a valid SSE reply.
 * Fold (non-stream) calls are answered with a canned ledger.
 */
export function captureGeneration(ledger = "ledger"): CapturedBodies {
  const gen: Array<Record<string, unknown>> = [];
  const folds: Array<Record<string, unknown>> = [];
  const fakeFetch = async (_url: string | URL | Request, init?: { body?: unknown }): Promise<Response> => {
    const raw = typeof init?.body === "string" ? init.body : String(init?.body ?? "{}");
    const body = JSON.parse(raw) as Record<string, unknown>;
    if (body["stream"] === false) {
      folds.push(body);
      return jsonResponse({ choices: [{ message: { content: ledger }, finish_reason: "stop" }] });
    }
    gen.push(body);
    return sseResponse(SSE_OK);
  };
  // Reason: tests replace the network boundary with a deterministic fake.
  globalThis.fetch = fakeFetch as unknown as typeof fetch;
  return { gen, folds };
}

/** Reset the fetch fake between tests. */
export function resetFetch(): void {
  // Reason: restores the network boundary to unmocked state between tests.
  globalThis.fetch = undefined as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Controller fakes: SessionController seam (db + engine + card).
// ---------------------------------------------------------------------------
/** Minimal card for controller tests. */
export function makeControllerCard(id = "card_1") {
  return { id, name: "Test Char", data: { name: "Test Char", first_mes: "Hello there." } };
}

/** Fake db: structured-clone persistence like a real database. */
export function makeControllerDb({ cards = [makeControllerCard()], sessions = [] }: { cards?: Array<Record<string, unknown>>; sessions?: Array<Record<string, unknown>> } = {}) {
  const saved: Array<Record<string, unknown>> = [];
  const store: Record<string, Record<string, unknown>> = {};
  for (const s of sessions) {
    const id = typeof s.id === "string" ? s.id : String(s.id);
    store[id] = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
  }
  let settings: Record<string, unknown> = { maxContextTokens: 8192, maxTokens: 1200, temperature: 0.5, agentsContract: "contract" };
  return {
    saved,
    savedSessions: saved,
    getSettings: () => ({ ...settings }),
    saveSettings: (patch: Record<string, unknown>) => { settings = { ...settings, ...patch }; },
    getAllCards: async () => cards,
    getSessionsForCard: async () => Object.values(store).map((s) => JSON.parse(JSON.stringify(s))),
    saveSession: async (s: Record<string, unknown>) => {
      saved.push(s);
      const id = typeof s.id === "string" ? s.id : String(s.id);
      store[id] = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
    },
    saveCard: async () => {},
    resolvePersonaForCard: async () => ({ name: "User" }),
    resolveDirectiveForCard: async () => ({ name: "D", content: "do" }),
  };
}

interface ControllerEngineOpts {
  onStream?: ((args: { userPrompt?: string; onChunk: (c: string) => void } & Record<string, unknown>) => Promise<string>) | null;
  choices?: Array<string | { id?: string; text: string; label?: string }>;
  choiceError?: unknown;
  streamError?: unknown;
  streamText?: string;
  chunks?: string[];
}

/** Fake engine: records calls, streams streamText, serves choices. */
export function makeControllerEngine({ onStream = null, choices = null, choiceError = null, streamError = null, streamText = "Hello world!", chunks = null }: ControllerEngineOpts = {}) {
  const engine: Record<string, unknown> & {
    calls: string[];
    streamCalls: number;
    choiceCalls: number;
    lastArgs: unknown;
    lastChoiceArgs: unknown;
  } = {
    calls: [],
    streamCalls: 0,
    choiceCalls: 0,
    lastArgs: null,
    lastChoiceArgs: null,
    async streamTurn(args: { userPrompt?: string; onChunk: (c: string) => void } & Record<string, unknown>) {
      engine.calls.push(typeof args.userPrompt === "string" ? args.userPrompt : "");
      engine.streamCalls += 1;
      engine.lastArgs = args;
      if (streamError) throw streamError;
      if (onStream) return onStream(args);
      const parts = chunks ?? (streamText === "The reply." ? ["The ", "reply."] : ["Hello", " world", "!"]);
      for (const chunk of parts) args.onChunk(chunk);
      return streamText;
    },
    async generateChoices(args: Record<string, unknown>) {
      engine.choiceCalls += 1;
      engine.lastChoiceArgs = args;
      if (choiceError) throw choiceError;
      const list = choices ?? ["Ask about the letter.", "Stay silent.", "Leave the room."];
      return {
        choices: list.map((c, i) => (
          typeof c === "string"
            ? { id: `c${i + 1}`, text: c, label: `Label ${i + 1}` }
            : { id: c.id || `c${i + 1}`, text: c.text, label: c.label || "" }
        )),
        usage: null,
        request: {},
      };
    },
  };
  return engine;
}

/** SessionController wired to fakes, initialized on card_1. Needs the controller class. */
export async function makeControllerFake(
  SessionControllerClass: new (deps: { db: unknown; engine: unknown }) => { init: (cardId: string, sessionId: null) => Promise<void> },
  { db = null, engine = null }: { db?: unknown; engine?: unknown } = {},
) {
  const resolvedDb = db ?? makeControllerDb();
  const resolvedEngine = engine ?? makeControllerEngine();
  const ctl = new SessionControllerClass({ db: resolvedDb, engine: resolvedEngine });
  await ctl.init("card_1", null);
  return { ctl, db: resolvedDb, engine: resolvedEngine };
}

// ---------------------------------------------------------------------------
// IndexedDB fake: in-memory surface LocalDb uses (open/upgrade, tx, index).
// ---------------------------------------------------------------------------
function idbStringList(names: string[]) {
  return {
    contains: (n: string) => names.includes(n),
    length: names.length,
    [Symbol.iterator]: () => names[Symbol.iterator](),
  };
}

interface IdbStoreRec {
  name: string;
  keyPath: string;
  records: Map<string, Record<string, unknown>>;
  indexes: Map<string, string>;
}

interface IdbDbRec {
  name: string;
  version: number;
  stores: Map<string, IdbStoreRec>;
}

/** In-memory IndexedDB fake with scan/transaction stats, fault flags, seed(). */
export function createFakeIndexedDB() {
  const dbs = new Map<string, IdbDbRec>();
  const stats = { fullScans: 0, indexScans: 0, transactions: 0 };
  const flags: { blockNextOpen: boolean; failNextPutWith: unknown } = { blockNextOpen: false, failNextPutWith: null };

  const makeRequest = () => ({ result: undefined as unknown, error: null as unknown, onsuccess: null as ((e: { target: unknown }) => void) | null, onerror: null as ((e: { target: unknown }) => void) | null });

  interface Tx { _ops: Array<() => void>; error: unknown; oncomplete: ((e: { target: unknown }) => void) | null; onerror: ((e: { target: unknown }) => void) | null; onabort: ((e: { target: unknown }) => void) | null; _drained: boolean; objectStore?: (n: string) => unknown; abort?: () => void }

  function makeStoreHandle(rec: IdbDbRec, name: string, tx: Tx) {
    const store = rec.stores.get(name);
    if (!store) throw new Error(`NotFoundError: ${name}`);
    const handle = {
      get keyPath() { return store.keyPath; },
      get indexNames() { return idbStringList([...store.indexes.keys()]); },
      createIndex(ixName: string, keyPath: string) {
        if (!store.indexes.has(ixName)) store.indexes.set(ixName, keyPath);
        return handle.index(ixName);
      },
      index(ixName: string) {
        const keyPath = store.indexes.get(ixName);
        if (!keyPath) throw new Error(`NotFoundError: index ${ixName}`);
        return {
          getAll(value: unknown) {
            const req = makeRequest();
            tx._ops.push(() => {
              stats.indexScans++;
              req.result = [...store.records.values()].filter((r) => r[keyPath] === value).map((r) => structuredClone(r));
              if (req.onsuccess) req.onsuccess({ target: req });
            });
            return req;
          },
          getAllKeys(value: unknown) {
            const req = makeRequest();
            tx._ops.push(() => {
              stats.indexScans++;
              req.result = [...store.records.values()].filter((r) => r[keyPath] === value).map((r) => r[store.keyPath]);
              if (req.onsuccess) req.onsuccess({ target: req });
            });
            return req;
          },
        };
      },
      getAll() {
        const req = makeRequest();
        tx._ops.push(() => {
          stats.fullScans++;
          req.result = [...store.records.values()].map((r) => structuredClone(r));
          if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
      },
      put(value: Record<string, unknown>) {
        const req = makeRequest();
        tx._ops.push(() => {
          if (flags.failNextPutWith) {
            const err = flags.failNextPutWith;
            flags.failNextPutWith = null;
            throw err;
          }
          const key = String(value[store.keyPath]);
          store.records.set(key, structuredClone(value));
          req.result = value[store.keyPath];
          if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
      },
      delete(key: string) {
        const req = makeRequest();
        tx._ops.push(() => {
          store.records.delete(key);
          if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
      },
      clear() {
        const req = makeRequest();
        tx._ops.push(() => {
          store.records.clear();
          if (req.onsuccess) req.onsuccess({ target: req });
        });
        return req;
      },
    };
    return handle;
  }

  function makeVersionChangeTx(rec: IdbDbRec) {
    const dummy: Tx = { _ops: [], error: null, oncomplete: null, onerror: null, onabort: null, _drained: false };
    return { objectStore: (n: string) => makeStoreHandle(rec, n, dummy), abort() {} };
  }

  function makeStore(name: string, keyPath: string): IdbStoreRec {
    return { name, keyPath, records: new Map(), indexes: new Map() };
  }

  function makeDbHandle(rec: IdbDbRec) {
    return {
      name: rec.name,
      get version() { return rec.version; },
      get objectStoreNames() { return idbStringList([...rec.stores.keys()]); },
      createObjectStore(name: string, opts: { keyPath?: string }) {
        rec.stores.set(name, makeStore(name, (opts && opts.keyPath) || "id"));
        return makeStoreHandle(rec, name, { _ops: [], error: null, oncomplete: null, onerror: null, onabort: null, _drained: false });
      },
      transaction(names: string | string[], mode = "readonly") {
        stats.transactions++;
        const list = Array.isArray(names) ? names : [names];
        for (const n of list) if (!rec.stores.has(n)) throw new Error(`NotFoundError: ${n}`);
        const tx: Tx = { error: null, oncomplete: null, onerror: null, onabort: null, _ops: [], _drained: false };
        tx.objectStore = (n: string) => makeStoreHandle(rec, n, tx);
        tx.abort = () => {
          tx.error = tx.error || new Error("AbortError");
          queueMicrotask(() => { if (tx.onabort) tx.onabort({ target: tx }); });
        };
        queueMicrotask(() => {
          if (tx._drained) return;
          tx._drained = true;
          try {
            while (tx._ops.length) (tx._ops.shift() as () => void)();
          } catch (err) {
            tx.error = err;
            if (tx.onabort) tx.onabort({ target: tx });
            if (tx.onerror) tx.onerror({ target: tx });
            return;
          }
          if (tx.oncomplete) tx.oncomplete({ target: tx });
        });
        return tx;
      },
      close() {},
    };
  }

  return {
    stats,
    flags,
    open(name: string, version: number) {
      const req: Record<string, unknown> & { result: unknown; error: unknown; onsuccess: ((e: { target: unknown }) => void) | null; onerror: ((e: { target: unknown }) => void) | null; onblocked: ((e: { target: unknown }) => void) | null; onupgradeneeded: ((e: { target: unknown; oldVersion: number; newVersion: number }) => void) | null; transaction?: unknown } = { result: undefined, error: null, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
      queueMicrotask(() => {
        if (flags.blockNextOpen) {
          flags.blockNextOpen = false;
          if (req.onblocked) req.onblocked({ target: req });
          return;
        }
        let rec = dbs.get(name);
        if (!rec) {
          rec = { name, version: 0, stores: new Map() };
          dbs.set(name, rec);
        }
        const target: IdbDbRec = rec;
        if (version > target.version) {
          const oldVersion = target.version;
          target.version = version;
          req.result = makeDbHandle(target);
          req.transaction = makeVersionChangeTx(target);
          if (req.onupgradeneeded) req.onupgradeneeded({ target: req, oldVersion, newVersion: version });
        }
        req.result = makeDbHandle(target);
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
    seed(name: string, version: number, { cards = [], sessions = [] }: { cards?: Array<Record<string, unknown>>; sessions?: Array<Record<string, unknown>> } = {}) {
      const rec: IdbDbRec = { name, version, stores: new Map() };
      const cardStore = makeStore("cards", "id");
      for (const c of cards) cardStore.records.set(String(c.id), structuredClone(c));
      const sessionStore = makeStore("sessions", "id");
      for (const s of sessions) sessionStore.records.set(String(s.id), structuredClone(s));
      rec.stores.set("cards", cardStore);
      rec.stores.set("sessions", sessionStore);
      dbs.set(name, rec);
    },
  };
}

// ---------------------------------------------------------------------------
// DOM fake: tiny document/element surface (detail_modal superset).
// ---------------------------------------------------------------------------
interface FakeNode {
  tagName: string;
  children: FakeNode[];
}

/** Class set for a fake node. */
export function fakeClassesOf(node: { className?: string }) {
  return new Set(String(node.className || "").split(/\s+/).filter(Boolean));
}

/** All descendant object children. */
export function fakeDescendants(node: FakeNode) {
  const out: FakeNode[] = [];
  for (const child of node.children) {
    if (!child || typeof child !== "object") continue;
    out.push(child, ...fakeDescendants(child));
  }
  return out;
}

function fakeMatchesOne(node: { tagName: string; getAttribute: (k: string) => string | null } & { className?: string }, sel: string) {
  if (!sel || /[\s>:+~]/.test(sel)) return false;
  let rest = sel;
  const tag = rest.match(/^([a-zA-Z][\w-]*)/);
  if (tag) {
    if (node.tagName !== tag[1].toUpperCase()) return false;
    rest = rest.slice(tag[1].length);
  } else if (rest[0] !== "." && rest[0] !== "[") {
    return false;
  }
  while (rest.length) {
    if (rest[0] === ".") {
      const m = rest.match(/^\.([\w-]+)/);
      if (!m || !fakeClassesOf(node).has(m[1])) return false;
      rest = rest.slice(m[0].length);
    } else if (rest[0] === "[") {
      const m = rest.match(/^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/);
      if (!m) return false;
      const actual = node.getAttribute(m[1]);
      if (actual === null) return false;
      const want = m[2] ?? m[3] ?? m[4];
      if (want !== undefined && actual !== want) return false;
      rest = rest.slice(m[0].length);
    } else {
      return false;
    }
  }
  return true;
}

/** Comma-separated selector match over the detail_modal compound syntax. */
export function fakeMatches(node: { tagName: string; getAttribute: (k: string) => string | null } & { className?: string }, selector: string) {
  return String(selector).split(",").map((s) => s.trim()).filter(Boolean).some((part) => fakeMatchesOne(node, part));
}

/** Fake element with the surface openDetailModal/renderCard/toast touch. */
export function makeFakeElement(tag: string) {
  const el: Record<string, unknown> & {
    tagName: string;
    children: Array<Record<string, unknown>>;
    attributes: Record<string, string>;
    dataset: Record<string, string>;
    style: Record<string, string>;
    className: string;
    textContent: string;
    parentNode: null | { children: Array<Record<string, unknown>> };
  } = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    dataset: {},
    style: {},
    className: "",
    textContent: "",
    parentNode: null,
  } as Record<string, unknown> & {
    tagName: string;
    children: Array<Record<string, unknown>>;
    attributes: Record<string, string>;
    dataset: Record<string, string>;
    style: Record<string, string>;
    className: string;
    textContent: string;
    parentNode: null | { children: Array<Record<string, unknown>> };
  };
  const listeners: Record<string, Array<(e: { type: string; target: unknown }) => void>> = {};
  const node = el as unknown as {
    tagName: string;
    children: Array<{ tagName: string; children: never[] } & Record<string, unknown>>;
    classList: { add: (...c: string[]) => void; remove: (...c: string[]) => void; contains: (c: string) => boolean; toggle: (c: string, force?: boolean) => boolean };
    hasAttribute(k: string): boolean;
    setAttribute(k: string, v: string): void;
    getAttribute(k: string): string | null;
    removeAttribute(k: string): void;
    appendChild(child: Record<string, unknown>): Record<string, unknown>;
    append(...nodes: unknown[]): void;
    prepend(...nodes: unknown[]): void;
    replaceChildren(...nodes: unknown[]): void;
    remove(): void;
    contains(n: unknown): boolean;
    focus(): void;
    addEventListener(t: string, fn: (e: { type: string; target: unknown }) => void): void;
    removeEventListener(t: string, fn: (e: { type: string; target: unknown }) => void): void;
    dispatch(t: string): void;
    firstElementChild: Record<string, unknown> | null;
    lastElementChild: Record<string, unknown> | null;
    querySelector(s: string): unknown;
    querySelectorAll(s: string): unknown[];
  };
  node.classList = {
    add: (...c) => { const set = fakeClassesOf(el); c.forEach((x) => set.add(x)); el.className = [...set].join(" "); },
    remove: (...c) => { const set = fakeClassesOf(el); c.forEach((x) => set.delete(x)); el.className = [...set].join(" "); },
    contains: (c) => fakeClassesOf(el).has(c),
    toggle: (c, force) => {
      const set = fakeClassesOf(el);
      const on = force === undefined ? !set.has(c) : Boolean(force);
      if (on) set.add(c); else set.delete(c);
      el.className = [...set].join(" ");
      return on;
    },
  };
  node.hasAttribute = (k) => Object.prototype.hasOwnProperty.call(el.attributes, k);
  node.setAttribute = (k, v) => { el.attributes[k] = String(v); };
  node.getAttribute = (k) => (Object.prototype.hasOwnProperty.call(el.attributes, k) ? el.attributes[k] : null);
  node.removeAttribute = (k) => { delete el.attributes[k]; };
  const adopt = (child: unknown) => {
    if (child && typeof child === "object") (child as { parentNode: unknown }).parentNode = el;
  };
  node.appendChild = (child) => { (el.children as Array<Record<string, unknown>>).push(child); adopt(child); return child; };
  node.append = (...nodes) => {
    for (const n of nodes) {
      if (n === null || n === undefined || n === false) continue;
      (el.children as Array<unknown>).push(n);
      adopt(n);
    }
  };
  node.prepend = (...nodes) => {
    for (const n of nodes) {
      if (n === null || n === undefined || n === false) continue;
      (el.children as Array<unknown>).unshift(n);
      adopt(n);
    }
  };
  node.replaceChildren = (...nodes) => { el.children = []; node.append(...nodes); };
  node.remove = () => {
    if (!el.parentNode) return;
    const i = el.parentNode.children.indexOf(el);
    if (i >= 0) el.parentNode.children.splice(i, 1);
    el.parentNode = null;
  };
  node.contains = (n) => {
    if (n === el) return true;
    return (fakeDescendants(el as unknown as FakeNode) as unknown[]).includes(n);
  };
  node.focus = () => {};
  node.addEventListener = (t, fn) => { (listeners[t] ||= []).push(fn); };
  node.removeEventListener = (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); };
  node.dispatch = (t) => { for (const fn of listeners[t] || []) fn({ type: t, target: el }); };
  Object.defineProperty(el, "firstElementChild", { get: () => el.children[0] || null });
  Object.defineProperty(el, "lastElementChild", { get: () => el.children[el.children.length - 1] || null });
  Object.defineProperty(el, "href", {
    get: () => (el.attributes.href === undefined ? "" : el.attributes.href),
    set: (v: string) => { el.attributes.href = String(v); },
  });
  const scopeChild = (s: string) => {
    const m = /^\s*:scope\s*>\s*(.+?)\s*$/.exec(s);
    if (!m) return null;
    const inner = m[1];
    return ((el.children as unknown[]).find((n) => n !== null && typeof n === "object" && fakeMatches(n as unknown as { tagName: string; getAttribute: (k: string) => string | null }, inner)) || null) as unknown;
  };
  node.querySelector = (s) => scopeChild(s) ?? (fakeDescendants(el as unknown as FakeNode).find((n) => fakeMatches(n as unknown as { tagName: string; getAttribute: (k: string) => string | null }, s)) || null) as unknown;
  node.querySelectorAll = (s) => fakeDescendants(el as unknown as FakeNode).filter((n) => fakeMatches(n as unknown as { tagName: string; getAttribute: (k: string) => string | null }, s)) as unknown[];
  return el;
}
