// Session refresh for imported character-page sessions.
//
// Access tokens live roughly three hours; the refresh token stored alongside
// them was previously unused, so a stored session simply died. This module
// exchanges the refresh token for a fresh session at the auth service so an
// imported session keeps working without the user re-exporting cookies.
//
// Contract: every export is total — it never throws. Any failure degrades to
// "keep using the session you already have", leaving the import path's own
// auth-failure handling (the stripped-response check) in charge.
//
// Security: token values are never logged, rendered, or embedded in errors.

export const SESSION_STORAGE_KEY = "vibe_rp_import_session";
export const DEFAULT_SKEW_SECONDS = 300;

const REFRESH_LOCK_NAME = "vibe_rp_import_session_refresh";
const STORAGE_LOCK_KEY = "vibe_rp_import_session_refresh_lock";
const STORAGE_LOCK_TTL_MS = 15000;
const STORAGE_LOCK_POLL_MS = 50;
const STORAGE_LOCK_TIMEOUT_MS = 5000;
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// Auth service base URL as published in the source site's public client
// bundle. Preferred source is the access token's own `iss` claim; this is only
// the fallback for tokens whose `iss` is not a URL.
const DEFAULT_AUTH_BASE_URL = "https://auth.janitorai.com/auth/v1";

// Public client ("anon") key, published in the source site's public browser
// bundle and required by the auth service's token endpoint. It is a public
// client key, not a secret, and grants nothing on its own: a refresh still
// needs a valid user refresh token. It lives here so the browser can call the
// endpoint directly.
const PUBLIC_CLIENT_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jbXp4dHpvbW1wbnhreW5kZGJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjgzNzA3NDAsImV4cCI6MjA0Mzk0Njc0MH0.UfRPni4ga9Lmin8j0JjV5ouuK9bXp8tsqPJ8pMTDDAI";

// JWT and session metadata (never throws)

const utf8Decoder = new TextDecoder();

function base64UrlToText(segment) {
  let s = String(segment).replace(/-/g, "+").replace(/_/g, "/");
  const rem = s.length % 4;
  if (rem === 1) return null;
  if (rem) s += "=".repeat(4 - rem);
  if (typeof atob !== "function") return null;
  let bin;
  try { bin = atob(s); } catch { return null; }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  try { return utf8Decoder.decode(bytes); } catch { return null; }
}

// Decodes a JWT payload. Returns an object, or null for a malformed,
// non-JWT, or non-object payload. Never throws.
export function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const text = base64UrlToText(parts[1]);
    if (text == null) return null;
    const json = JSON.parse(text);
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  }
}

// Expiry (unix seconds) from the stored field, else the token's `exp` claim,
// else null when unknown. Never throws.
export function sessionExpiresAt(session) {
  const direct = Number(session?.expiresAt);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const exp = Number(decodeJwtPayload(session?.accessToken)?.exp);
  return Number.isFinite(exp) && exp > 0 ? exp : null;
}

// True when the session should be refreshed before it actually lapses.
// Unknown expiry is treated as "not stale" (nothing to act on).
export function needsRefresh(session, skewSeconds = DEFAULT_SKEW_SECONDS, nowSeconds) {
  if (!session?.accessToken) return true;
  const now = Number.isFinite(nowSeconds) ? nowSeconds : Date.now() / 1000;
  const exp = sessionExpiresAt(session);
  if (exp == null) return false;
  return exp - now <= skewSeconds;
}

// Derives the auth service base URL from the token's `iss` claim.
// Returns null when it cannot be derived.
export function deriveAuthBaseUrl(session) {
  const iss = decodeJwtPayload(session?.accessToken)?.iss;
  if (typeof iss !== "string" || !iss) return null;
  let u;
  try { u = new URL(iss); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const path = u.pathname.replace(/\/+$/, "");
  if (/\/auth\/v1$/.test(path)) return u.origin + path;
  return u.origin + "/auth/v1";
}

// Storage access (guarded: absent in non-browser runtimes)

function getStorage(options) {
  if (options && Object.prototype.hasOwnProperty.call(options, "storage")) return options.storage || null;
  try { return globalThis.localStorage || null; } catch { return null; }
}

function storageKey(options) {
  return options?.storageKey || SESSION_STORAGE_KEY;
}

function normalizeStored(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.accessToken !== "string" || !raw.accessToken) return null;
  return {
    accessToken: raw.accessToken,
    refreshToken: typeof raw.refreshToken === "string" && raw.refreshToken ? raw.refreshToken : null,
    expiresAt: Number.isFinite(raw.expiresAt) ? raw.expiresAt : null,
  };
}

function readStoredSession(options) {
  const storage = getStorage(options);
  if (!storage) return null;
  try { return normalizeStored(JSON.parse(storage.getItem(storageKey(options)) || "null")); } catch { return null; }
}

// Writes the session as a single synchronous (atomic) setItem. Only the three
// extracted fields are ever persisted.
function persistSession(session, options) {
  const storage = getStorage(options);
  if (!storage) return false;
  const value = {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresAt,
  };
  try {
    storage.setItem(storageKey(options), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// Concurrency: in-tab single-flight, cross-tab lock

const inflightByToken = new Map();

// Test hook: drop coalescing state between cases.
export function resetRefreshState() {
  inflightByToken.clear();
}

function withCrossTabLock(fn, options) {
  const locks = (options && Object.prototype.hasOwnProperty.call(options, "locks"))
    ? options.locks
    : (globalThis.navigator && globalThis.navigator.locks) || null;
  if (locks && typeof locks.request === "function") {
    try {
      return Promise.resolve(locks.request(REFRESH_LOCK_NAME, { mode: "exclusive" }, fn));
    } catch { /* fall through to the best-effort lock */ }
  }
  return withStorageLock(fn, options);
}

// Best-effort cross-tab lock for runtimes without navigator.locks. NOT robust:
// localStorage has no compare-and-swap, so two tabs can in principle both
// acquire. The re-check inside the lock and the short TTL make the window
// small; navigator.locks (used when present) is the robust path.
async function withStorageLock(fn, options) {
  const storage = getStorage(options);
  if (!storage) return fn();
  const owner = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const sleep = options?.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeout = Number.isFinite(options?.lockTimeoutMs) ? options.lockTimeoutMs : STORAGE_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  for (;;) {
    let acquired = false;
    try {
      const cur = JSON.parse(storage.getItem(STORAGE_LOCK_KEY) || "null");
      if (!cur || !(Number(cur.expiresAt) > Date.now())) {
        storage.setItem(STORAGE_LOCK_KEY, JSON.stringify({ owner, expiresAt: Date.now() + STORAGE_LOCK_TTL_MS }));
        const check = JSON.parse(storage.getItem(STORAGE_LOCK_KEY) || "null");
        acquired = check && check.owner === owner;
      }
    } catch { /* storage hiccup: treat as not acquired */ }
    if (acquired) {
      try {
        return await fn();
      } finally {
        try {
          const cur = JSON.parse(storage.getItem(STORAGE_LOCK_KEY) || "null");
          if (cur && cur.owner === owner) storage.removeItem(STORAGE_LOCK_KEY);
        } catch { /* nothing to release */ }
      }
    }
    if (Date.now() >= deadline) return fn(); // never deadlock: proceed
    await sleep(STORAGE_LOCK_POLL_MS);
  }
}

// Refresh session

// If another tab already rotated the session, adopt its result instead of
// refreshing again (which would invalidate the rotation it just persisted).
function adoptFreshStoredSession(session, options) {
  const stored = readStoredSession(options);
  if (!stored || !stored.refreshToken) return null;
  if (stored.refreshToken === session?.refreshToken) return null;
  if (needsRefresh(stored, options?.skewSeconds ?? DEFAULT_SKEW_SECONDS, options?.now)) return null;
  return stored;
}

async function performRefresh(session, options) {
  const refreshToken = session?.refreshToken;
  if (typeof refreshToken !== "string" || !refreshToken) return null;
  const base = options?.authBaseUrl || deriveAuthBaseUrl(session) || DEFAULT_AUTH_BASE_URL;
  if (!base) return null;
  const fetchFn = options?.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== "function") return null;
  const key = options?.apiKey || PUBLIC_CLIENT_KEY;

  let res;
  try {
    res = await fetchFn(`${base}/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch {
    // Ambiguous network/CORS failure. Do not retry with the same token here:
    // the caller falls back to the session it already has.
    return null;
  }
  if (!res || !res.ok) return null;

  let json;
  try { json = await res.json(); } catch { return null; }
  const accessToken = json?.access_token;
  if (typeof accessToken !== "string" || !accessToken) return null;

  const rotated = typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : refreshToken;
  const expiresIn = Number(json.expires_in);
  const nowSeconds = Number.isFinite(options?.now) ? options.now : Math.round(Date.now() / 1000);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? nowSeconds + expiresIn
    : (Number(decodeJwtPayload(accessToken)?.exp) || null);

  const updated = { accessToken, refreshToken: rotated, expiresAt };
  // Persist the rotation immediately: the old refresh token is now invalid, so
  // this write must happen before anything else can observe or use the result.
  persistSession(updated, options);
  return updated;
}

async function doRefresh(session, options) {
  return withCrossTabLock(async () => {
    const adopted = adoptFreshStoredSession(session, options);
    if (adopted) return adopted;
    return performRefresh(session, options);
  }, options);
}

// Refreshes the session, returning the updated {accessToken, refreshToken,
// expiresAt} or null on any failure. Never throws. Concurrent calls that share
// a refresh token are coalesced into a single network request.
export function refreshSession(session, options = {}) {
  const rt = session?.refreshToken;
  if (typeof rt !== "string" || !rt) return Promise.resolve(null);
  const existing = inflightByToken.get(rt);
  if (existing) return existing;
  let tracked;
  const p = doRefresh(session, options);
  tracked = p.finally(() => {
    if (inflightByToken.get(rt) === tracked) inflightByToken.delete(rt);
  });
  inflightByToken.set(rt, tracked);
  return tracked;
}

// Refreshes only when stale, and always returns a usable session: the refreshed
// one when it works, otherwise the caller's original session untouched. Never
// throws, so it is safe to call from the import path.
export async function ensureFreshSession(session, options = {}) {
  if (!session) return session;
  if (!needsRefresh(session, options.skewSeconds, options.now)) return session;
  const refreshed = await refreshSession(session, options);
  return refreshed || session;
}

// Proactive refresh for long-lived tabs

// Refreshes the stored session now if stale and on an interval thereafter.
// Returns { stop, tick }: `tick()` runs one pass and resolves when it settles
// (tests drive time through this instead of sleeping); `stop()` clears the
// interval. Never throws.
export function installProactiveRefresh(options = {}) {
  const storage = getStorage(options);
  if (!storage) return { stop: () => {}, tick: async () => {} };
  const setI = options.setInterval || globalThis.setInterval;
  const clearI = options.clearInterval || globalThis.clearInterval;
  const tick = async () => {
    let stored = null;
    try { stored = JSON.parse(storage.getItem(storageKey(options)) || "null"); } catch { stored = null; }
    if (!stored?.accessToken) return;
    await ensureFreshSession(stored, options);
  };
  let timer = null;
  if (typeof setI === "function") {
    timer = setI(() => { tick().catch(() => {}); }, Number.isFinite(options.intervalMs) ? options.intervalMs : AUTO_REFRESH_INTERVAL_MS);
  }
  const stop = () => {
    if (timer != null && typeof clearI === "function") clearI(timer);
  };
  return { stop, tick };
}

// Starts proactive refresh when running in a real browser with a store. Guarded
// so importing this module in a non-browser runtime (tests, tooling) is inert,
// and idempotent so importing it from more than one place installs one timer.
let autoStartInstalled = false;
export function maybeAutoStartProactiveRefresh() {
  try {
    if (typeof document === "undefined") return false;
    if (!globalThis.localStorage) return false;
    if (autoStartInstalled) return false;
    autoStartInstalled = true;
    installProactiveRefresh();
    return true;
  } catch {
    return false;
  }
}
