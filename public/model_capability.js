// Model capabilities and learned telemetry store (pure ES module, zero DOM).
//
// What an endpoint has been observed to accept, reject, ignore, or charge for.
// Learned at runtime, never guessed from the model name. Persisted so facts
// learned in one session survive page reloads and cross-session turns.

import { LEDGER_OPEN } from "./context_plan.js";

const modelCapabilities = new Map();
const CAPABILITY_STORE_KEY = "vibe_rp_model_caps";
// Bounded so a user who tries many endpoints cannot grow the store without
// limit. Least-recently-written entries are dropped first.
const CAPABILITY_STORE_MAX = 64;
/** How many overhead samples the median is taken over. */
const OVERHEAD_SAMPLES = 5;

function capabilityKey(endpoint, model) {
  return `${String(endpoint || "").trim()}::${String(model || "").trim()}`;
}

function capabilityStorage() {
  try {
    const store = globalThis.localStorage;
    return store && typeof store.getItem === "function" ? store : null;
  } catch {
    // A host that throws on property access (some sandboxes) is the same as
    // one that has no storage.
    return null;
  }
}

let capabilitiesHydrated = false;
function hydrateCapabilities() {
  if (capabilitiesHydrated) return;
  capabilitiesHydrated = true;
  const store = capabilityStorage();
  if (!store) return;
  try {
    const raw = store.getItem(CAPABILITY_STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value === "object") modelCapabilities.set(key, value);
    }
  } catch {
    // Corrupt or unreadable: start clean rather than fail every lookup.
    try {
      store.removeItem(CAPABILITY_STORE_KEY);
    } catch {
      /* nothing further to do */
    }
  }
}

function persistCapabilities() {
  const store = capabilityStorage();
  if (!store) return;
  try {
    const entries = [...modelCapabilities.entries()];
    // Map iteration is insertion-ordered; the tail is the most recent.
    const kept = entries.slice(Math.max(0, entries.length - CAPABILITY_STORE_MAX));
    store.setItem(CAPABILITY_STORE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Quota or a hostile store: the in-memory map still serves this session.
  }
}

export function getModelCapability(endpoint, model) {
  hydrateCapabilities();
  return modelCapabilities.get(capabilityKey(endpoint, model)) || {};
}

export function updateModelCapability(endpoint, model, updates) {
  hydrateCapabilities();
  const key = capabilityKey(endpoint, model);
  const current = modelCapabilities.get(key) || {};
  // Re-insert so the key moves to the recent end of the eviction order.
  modelCapabilities.delete(key);
  modelCapabilities.set(key, { ...current, ...updates });
  persistCapabilities();
}

/**
 * Records one observation of how many tokens the endpoint bills *before* the
 * payload the app sent. A gateway that injects a hidden preamble bills a
 * constant the app cannot see; measuring it is the only way to budget for it.
 *
 * Kept as a median over the last few samples so one anomalous response cannot
 * move the figure, and only recorded when the delta is a plausible preamble —
 * a negative or absurd value means the provider reports usage differently, and
 * storing it would corrupt every later budget.
 */
export function notePromptOverhead(endpoint, model, billed, sent) {
  if (typeof billed !== "number" || typeof sent !== "number") return;
  if (!Number.isFinite(billed) || !Number.isFinite(sent)) return;
  const delta = billed - sent;
  if (delta < 0 || delta > 32768) return;
  const cap = getModelCapability(endpoint, model);
  const samples = Array.isArray(cap.promptOverheadSamples) ? cap.promptOverheadSamples.slice() : [];
  samples.push(Math.round(delta));
  while (samples.length > OVERHEAD_SAMPLES) samples.shift();
  // Lower median: with an even count this takes the smaller of the middle two,
  // so the figure errs toward under-claiming. An overhead that is too small
  // leaves the existing safety margin to absorb it and the overflow re-fit to
  // catch it; one that is too large would silently shrink every request.
  const sorted = samples.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  updateModelCapability(endpoint, model, { promptOverheadSamples: samples, promptOverheadTokens: median });
}

/**
 * The measured per-request overhead for this endpoint, or 0 when it has never
 * been observed. Zero is the honest default: it means "assume the provider
 * bills what we sent", which is the behaviour of every provider that does not
 * inject anything.
 */
export function promptOverheadTokens(settings = {}) {
  const cap = getModelCapability(settings?.apiEndpoint, settings?.model);
  return typeof cap.promptOverheadTokens === "number" && cap.promptOverheadTokens > 0
    ? cap.promptOverheadTokens
    : 0;
}

/**
 * The per-request overhead frozen for one session.
 *
 * `planRequest` charges the measured preamble against the window, and the
 * measured value is a median over a sliding window of samples — so on an
 * endpoint whose reports jitter it moves from turn to turn. Every move re-plans
 * the request, and a re-plan can change the system message, the recap, or where
 * the history is cut, all of which sit *before* the new content. Measured: a
 * single re-plan cost 49.5 points of cache-served input at a 6,144-token window,
 * and the charged value moved on 43% of turns under the jitter a real gateway
 * showed.
 *
 * Freezing it for the life of a session removes that whole class of
 * self-inflicted prefix break while still learning across sessions: the store
 * keeps sampling, and the next session starts from whatever it learned.
 *
 * Keyed weakly on the session object, so there is no schema change, nothing to
 * clean up, and nothing that outlives the session.
 */
let sessionOverhead = new WeakMap();

/**
 * The overhead to charge for one session: the value frozen at the first plan
 * that had one, otherwise the learned value, which is then frozen.
 *
 * A session that begins before the endpoint has ever reported an overhead
 * charges nothing and freezes nothing, so the first observation still lands and
 * every turn after it is stable.
 */
export function sessionOverheadTokens(settings = {}, session = null) {
  const learned = promptOverheadTokens(settings);
  if (!session || typeof session !== "object") return learned;
  const frozen = sessionOverhead.get(session);
  if (frozen !== undefined) return frozen;
  if (learned <= 0) return 0;
  sessionOverhead.set(session, learned);
  return learned;
}

export function clearModelCapabilities() {
  modelCapabilities.clear();
  // A frozen overhead derives from the store, so forgetting the store forgets it.
  sessionOverhead = new WeakMap();
  // Re-arm hydration rather than latching it shut: clearing means "forget
  // everything", including what was read from storage, so a later read picks up
  // whatever the store holds then. The store is emptied here too, so in normal
  // use the next read finds nothing.
  capabilitiesHydrated = false;
  const store = capabilityStorage();
  if (!store) return;
  try {
    store.removeItem(CAPABILITY_STORE_KEY);
  } catch {
    /* nothing further to do */
  }
}

/**
 * Records the model's real context window, as named by a provider error.
 *
 * A context-length rejection is the only portable signal of the model's true
 * window over an OpenAI-compatible API, so recovering it is worth the parse. The
 * value is remembered against the endpoint+model, which is what turns a
 * per-turn mistake into a per-model one: without this, every session on a model
 * whose window is smaller than the configured guess pays a rejected request
 * before it can send anything.
 */
export function noteContextWindow(endpoint, model, window) {
  const n = Number(window);
  if (!Number.isFinite(n) || n < 2048) return;
  updateModelCapability(endpoint, model, { contextWindow: Math.round(n) });
}

/**
 * The window to actually plan against: the configured value, lowered to the
 * learned one when a provider has told the app it is smaller.
 *
 * Clamping rather than overriding is deliberate. The learned value is evidence
 * about the model; the configured value is the user's intent, and a user who
 * later raises the setting has raised it on purpose. Taking the minimum keeps
 * both: the learned limit is respected, and the setting still governs.
 */
export function effectiveContextWindow(settings = {}) {
  const configured = Math.max(2048, Number(settings?.maxContextTokens) || 16384);
  const cap = getModelCapability(settings?.apiEndpoint, settings?.model);
  const learned = Number(cap.contextWindow);
  if (!Number.isFinite(learned) || learned < 2048) return configured;
  return Math.min(configured, learned);
}

/**
 * Detects HTTP 400 parameter rejection errors returned by OpenAI-compatible
 * providers, routers, gateways, and local inference engines.
 */
export function detectParameterRejection(err) {
  const msg = String(err?.message || "").toLowerCase();
  const unsupportedTemp =
    /(?:temperature|sampling).*?(?:not supported|unsupported)/i.test(msg) ||
    /unsupported.*?(?:parameter ['"]?temperature['"]?|temperature|top_p|presence_penalty|frequency_penalty)/i.test(msg);
  const needsMaxCompletionTokens =
    /max_tokens.*?(?:not supported|unsupported|unrecognized)/i.test(msg) ||
    /use ['"]?max_completion_tokens['"]?/i.test(msg);
  const needsMaxTokens =
    /max_completion_tokens.*?(?:not supported|unsupported|unrecognized|unknown)/i.test(msg);
  const unsupportedReasoningEffort =
    /reasoning_effort.*?(?:not supported|unsupported|unrecognized|unknown)/i.test(msg);
  const unsupportedStreamOptions =
    /stream_options.*?(?:not supported|unsupported|unrecognized|unknown)/i.test(msg) ||
    /unsupported.*?parameter ['\"]?stream_options['\"]?/i.test(msg);
  const unsupportedCacheControl =
    /cache_control.*?(?:not supported|unsupported|unrecognized|unknown|invalid)/i.test(msg) ||
    /unsupported.*?parameter ['\"]?cache_control['\"]?/i.test(msg);

  if (unsupportedTemp || needsMaxCompletionTokens || needsMaxTokens || unsupportedReasoningEffort || unsupportedStreamOptions || unsupportedCacheControl) {
    return {
      unsupportedTemp,
      needsMaxCompletionTokens,
      needsMaxTokens,
      unsupportedReasoningEffort,
      unsupportedStreamOptions,
      unsupportedCacheControl,
    };
  }
  return null;
}

/**
 * The model that performs folds.
 *
 * A fold is extraction over tokens that have already been paid for once: read
 * the transcript, merge it into the ledger. It does not write prose, and nothing
 * the reader sees comes from it directly — only the ledger does. Measured on a
 * real endpoint, one fold generates ~2,200 tokens, of which ~72% are invisible
 * reasoning, which makes it about as expensive as a full narrative turn while
 * being a far simpler task.
 *
 * Empty means "use the main model", which keeps every existing configuration
 * working unchanged.
 */
export function summaryModelOf(settings = {}) {
  return String(settings?.summaryModel || "").trim() || String(settings?.model || "").trim();
}

/**
 * Whether this endpoint can be asked to cache the prompt prefix.
 *
 * Prefix caching is the single largest cost lever this app has: measured, 95.9%
 * to 99.2% of a turn's input is a byte-stable prefix, and the four context rules
 * exist precisely to keep it that way. OpenAI-compatible providers that cache
 * automatically get that for free. Anthropic does not — it caches only where an
 * explicit `cache_control` breakpoint says so, which is also where the discount
 * is deepest.
 *
 * The field is an extension, so this is opt-in by shape and reversible by
 * observation: it is sent for endpoints that identify as Anthropic, and switched
 * off for the whole endpoint+model pair the first time a provider rejects it.
 * A provider that accepts and ignores the field is harmless — the request is
 * byte-identical apart from a field it discards.
 */
export function shouldUseCacheBreakpoints(settings = {}, capability = null) {
  const cap = capability || getModelCapability(settings?.apiEndpoint, settings?.model);
  if (cap.supportsCacheControl === false) return false;
  if (cap.supportsCacheControl === true) return true;
  if (settings?.promptCacheBreakpoints === false) return false;
  const endpoint = String(settings?.apiEndpoint || "").toLowerCase();
  const model = String(settings?.model || "").toLowerCase();
  return endpoint.includes("anthropic") || model.includes("claude");
}

/**
 * Rewrites the payload into Anthropic-style content blocks carrying
 * `cache_control` breakpoints, up to the four the API allows.
 *
 * The breakpoints map onto the layout the app already maintains, which is why
 * they are cheap to add: the stable prefix first (system), then the ledger
 * (replaced in place, so it hits until a fold), then the frozen history. The
 * newest turn is deliberately left unmarked — it is the only part that changes
 * every request, and marking it would buy nothing while writing a cache entry
 * that is never read.
 *
 * Only the marked messages change shape. Everything else stays a plain string,
 * so the array a provider sees is otherwise byte-identical to what the app
 * assembled and measured.
 */
export function withCacheBreakpoints(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const marks = new Set([0]);
  // Message 1 is the ledger whenever one is present; it is worth its own
  // breakpoint because it is replaced in place rather than appended to.
  const second = messages[1];
  if (second && typeof second.content === "string" && second.content.startsWith(LEDGER_OPEN)) {
    marks.add(1);
  }
  // The newest message changes every turn; the one before it does not.
  // When a choice request appends its task after a synthetic `[Writing Guidance:`
  // user message, step back one more slot to land on the frozen assistant turn
  // that the next main turn will share.
  if (messages.length >= 3) {
    const penultimate = messages[messages.length - 2];
    const isSyntheticGuidance =
      messages.length >= 4 &&
      penultimate?.role === "user" &&
      typeof penultimate.content === "string" &&
      penultimate.content.startsWith("[Writing Guidance:");
    const tailMark = isSyntheticGuidance ? messages.length - 3 : messages.length - 2;
    marks.add(tailMark);
    // Use the fourth allowed breakpoint on the prior turn's frozen tail so
    // endpoints that match strictly at marked blocks hit the previous turn's
    // cache before extending it to `tailMark`.
    if (tailMark - 2 >= 2) marks.add(tailMark - 2);
  }
  return messages.map((m, i) => {
    if (!marks.has(i) || typeof m?.content !== "string") return m;
    return { ...m, content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }] };
  });
}

/**
 * Records that a model reasons on its own, inferred from the provider's own
 * usage report rather than from the model's name.
 */
export function noteObservedReasoning(endpoint, model, usage) {
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoning === "number" && reasoning > 0) {
    updateModelCapability(endpoint, model, { observedReasoning: true });
  }
}
