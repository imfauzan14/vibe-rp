// Per-chat usage history — what the provider actually reported, over time.
//
// Why this exists. The Context sheet can show one reconciliation: what the
// provider reported as input for the last reply, how much it served from
// its cache, how much the model spent thinking. One sample cannot show a trend,
// and for cache reuse a single number is close to meaningless. The first reply
// after anything changes in the setup is necessarily cold and the second is
// warm, so a reader looking at "Served from cache: 0%" cannot tell a prompt
// that is never reused from one that was rebuilt a moment ago. The answer is
// the shape over time, not the last point of it.
//
// Why the scope. Cache reuse is a property of a *prefix over time*, so two
// samples are only comparable when they were measured against the same prefix.
// The static part of a request is built from the character card, the speaking
// persona and the system prompt, and the cache that holds it belongs to one
// endpoint and model. Change any of those and the next reply starts cold — so
// samples are grouped by that identity and a trend never averages across a
// change. Two chats of the same card are separate for the same reason: their
// transcripts are different, and this module never merges them.
//
// What a sample is. `session.usageHistory` is an append-only array of samples,
// oldest first. A sample records what was measured and never a guess: an
// endpoint that reported nothing yields a sample with `cached: null`, which the
// trend counts as *unreported*. A miss is `cached: 0`. Those are two different
// facts and the panel must not conflate them.
//
// Deliberately no DOM, no I/O and no clock: the caller stamps `at`, so the
// history is a pure function of the turns it was given.
//
// Exports
//   USAGE_HISTORY_CAP / USAGE_SCOPE_CAP
//   scopeKeyOf(parts) -> string
//   usageSampleFrom({ report, scope, at, folded }) -> sample
//   rateOf(sample) -> number|null
//   recordUsageSample(session, { report, scope, at, folded }) -> sample
//   usageTrend(samples, scopeKey) -> view model

/** Samples kept per scope. Beyond this the oldest of that scope is dropped. */
export const USAGE_HISTORY_CAP = 30;

/** Distinct scopes kept per chat. Beyond this the least recently used goes. */
export const USAGE_SCOPE_CAP = 8;

const part = (value) => String(value ?? "").trim();

/**
 * The identity of the prefix a sample was measured against.
 *
 * Five parts, because each of them independently resets a provider's cache: a
 * different endpoint or model has a different cache, and a different card,
 * persona or system prompt is a different prefix. Two turns share a scope only
 * when all five match, which is exactly when their hit rates are comparable.
 *
 * The result is an internal key. It is never shown to a reader — the panel
 * receives a label the caller resolved from names.
 */
export function scopeKeyOf(parts = {}) {
  return [parts.endpoint, parts.model, parts.cardId, parts.personaId, parts.directiveId].map(part).join("|");
}

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * One turn, as measured. Fields the provider did not report stay `null` rather
 * than becoming `0`, so nothing downstream can read an absent measurement as a
 * measured absence.
 */
export function usageSampleFrom({ report = null, scope = "", at = 0, folded = false } = {}) {
  return {
    at: Number(at) || 0,
    scope: part(scope),
    // The rate is derived from these two rather than stored beside them, so the
    // panel can show the rate *and* the size of the prompt it came from: 90% of
    // a 200-token prompt and 90% of a 60,000-token one are not the same fact.
    billed: report ? finite(report.totalInput ?? report.billedInput) : null, // legacy storage key: total input volume, not currency
    cached: report ? finite(report.cachedTokens) : null,
    estimated: report ? finite(report.estimatedInput) : null,
    reasoning: report ? finite(report.reasoningTokens) : null,
    // The one provider behaviour that changes what the reader should expect
    // next, so it travels with the figures rather than only in the store.
    ceiling: Boolean(report && report.ceilingIgnored),
    // The recap was rebuilt during this turn, so this reply's prompt was new
    // even though nothing the reader did changed. A cold sample here has a
    // cause the panel can name.
    folded: Boolean(folded),
  };
}

/**
 * The share of total reported input served from cache, or null when no cache
 * figure was reported. `billed` is the legacy field name for total input volume.
 * Clamped, because a provider reporting more cached tokens than total input is
 * describing something the app cannot interpret as a share.
 */
export function rateOf(sample) {
  if (!sample || typeof sample.billed !== "number" || typeof sample.cached !== "number") return null;
  if (sample.billed <= 0) return null;
  return Math.max(0, Math.min(1, sample.cached / sample.billed));
}

/**
 * Appends one sample for one completed turn and keeps the store bounded.
 *
 * Pruning is per scope. A global cap would let a chatty preset evict a quiet
 * one's entire history, which is the mixing this module exists to prevent. The
 * dropped count is kept so a trend can say what it is showing instead of
 * presenting a window as the whole story.
 */
export function recordUsageSample(session, { report = null, scope = "", at = 0, folded = false } = {}) {
  if (!session) return null;
  const sample = usageSampleFrom({ report, scope, at, folded });
  const history = Array.isArray(session.usageHistory) ? session.usageHistory : [];
  history.push(sample);

  const mine = history.filter((s) => s && s.scope === sample.scope);
  if (mine.length > USAGE_HISTORY_CAP) {
    const drop = mine.length - USAGE_HISTORY_CAP;
    const dropped = new Set(mine.slice(0, drop));
    session.usageHistory = history.filter((s) => !dropped.has(s));
    session.usagePruned = { ...(session.usagePruned || {}), [sample.scope]: (session.usagePruned?.[sample.scope] || 0) + drop };
  } else {
    session.usageHistory = history;
  }

  evictStaleScopes(session);
  return sample;
}

/**
 * Bounds the number of distinct scopes a chat can accumulate, oldest first.
 * A chat that has run under many presets must not grow without limit, and the
 * scope to lose is the one nothing has been measured against for longest.
 */
function evictStaleScopes(session) {
  const history = Array.isArray(session.usageHistory) ? session.usageHistory : [];
  const newest = new Map();
  for (const s of history) {
    if (!s) continue;
    const seen = newest.get(s.scope);
    if (seen === undefined || s.at > seen) newest.set(s.scope, s.at);
  }
  if (newest.size <= USAGE_SCOPE_CAP) return;
  const keep = new Set(
    [...newest.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, USAGE_SCOPE_CAP)
      .map(([key]) => key)
  );
  session.usageHistory = history.filter((s) => s && keep.has(s.scope));
  // A pruned count for a scope that is gone describes nothing.
  const pruned = { ...(session.usagePruned || {}) };
  for (const key of newest.keys()) if (!keep.has(key)) delete pruned[key];
  session.usagePruned = pruned;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Which way reuse is going, over the measured samples only.
 *
 * Null below three samples: with two points the "trend" is the difference
 * between them, which is noise. Null too when every sample is identical — a
 * constant is not a direction, and "and it is steady" beside a run of zeros
 * says nothing a reader did not already read. The 0.1 band is wide on purpose:
 * a reader acts on "rising" or "falling", and a 4-point move between two replies
 * is neither.
 */
function directionOf(rates) {
  if (rates.length < 3) return null;
  if (Math.max(...rates) === Math.min(...rates)) return null;
  const half = Math.floor(rates.length / 2);
  const older = median(rates.slice(0, half));
  const newer = median(rates.slice(rates.length - half));
  const diff = newer - older;
  if (diff > 0.1) return "warming";
  if (diff < -0.1) return "cooling";
  return "steady";
}

/**
 * The trend for one scope, and the honest count of what was left out of it.
 *
 * `otherSamples` and `otherScopes` describe history this chat holds under a
 * different setup. They are reported as counts and never folded into the
 * figures above them — a reply measured against another prefix says nothing
 * about this one.
 */
export function usageTrend(samples, scopeKey, { dropped = 0 } = {}) {
  const all = Array.isArray(samples) ? samples.filter(Boolean) : [];
  const key = part(scopeKey);
  const mine = all.filter((s) => s.scope === key);
  const others = all.filter((s) => s.scope !== key);

  const rates = [];
  const series = [];
  let unreported = 0;
  let cold = 0;
  for (const s of mine) {
    const rate = rateOf(s);
    if (rate === null) {
      unreported += 1;
      series.push({ at: s.at, rate: null, folded: Boolean(s.folded) });
      continue;
    }
    rates.push(rate);
    if (rate === 0) cold += 1;
    series.push({ at: s.at, rate, folded: Boolean(s.folded) });
  }

  const billed = mine.map((s) => s.billed).filter((n) => typeof n === "number");
  return {
    scopeKey: key,
    total: mine.length,
    measured: rates.length,
    unreported,
    cold,
    series,
    median: median(rates),
    latest: rates.length ? rates[rates.length - 1] : null,
    best: rates.length ? Math.max(...rates) : null,
    worst: rates.length ? Math.min(...rates) : null,
    direction: directionOf(rates),
    largestPrompt: billed.length ? Math.max(...billed) : null,
    // How many of this scope's samples the cap has already discarded. Supplied
    // by the caller, which owns the session: this module reads no store.
    dropped: Math.max(0, Number(dropped) || 0),
    otherSamples: others.length,
    otherScopes: new Set(others.map((s) => s.scope)).size,
  };
}
