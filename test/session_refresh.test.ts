import { describe, test, expect, afterEach } from "bun:test";
import {
  decodeJwtPayload,
  sessionExpiresAt,
  needsRefresh,
  deriveAuthBaseUrl,
  refreshSession,
  ensureFreshSession,
  installProactiveRefresh,
  resetRefreshState,
  SESSION_STORAGE_KEY,
} from "../public/session_refresh.js";
import { parseCardUrl, fetchRemoteCard } from "../public/remote_import.js";

// ---------------------------------------------------------------------------
// helpers

function b64url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJwt(payload, header = { alg: "HS256", typ: "JWT" }) {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.signature`;
}

function memStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

// Single shared in-process lock for tests: serializes cross-"tab" work.
function testLocks() {
  let tail = Promise.resolve();
  return {
    request(_name, _opts, fn) {
      const run = tail.then(() => fn());
      tail = run.catch(() => {});
      return run;
    },
  };
}

const NOW = 1_800_000_000; // fixed clock (seconds)
const FUTURE_EXP = NOW + 3600;

function session(over = {}) {
  return {
    accessToken: makeJwt({ iss: "https://auth.example.com", exp: FUTURE_EXP }),
    refreshToken: "refresh-token-old",
    expiresAt: FUTURE_EXP,
    ...over,
  };
}

function sessionJson(over = {}) {
  return {
    access_token: "new-access-token",
    refresh_token: "refresh-token-new",
    expires_in: 3600,
    token_type: "bearer",
    ...over,
  };
}

function opts(extra = {}) {
  return { storage: memStorage(), locks: testLocks(), now: NOW, ...extra };
}

function recordingFetch(response, calls) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    if (typeof response === "function") return response(url, init);
    return response;
  };
}

function okJson(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
}

const ORIGINAL_LOG = { ...console };
afterEach(() => {
  Object.assign(console, ORIGINAL_LOG);
  resetRefreshState();
});

// ---------------------------------------------------------------------------
// JWT payload decode

describe("decodeJwtPayload", () => {
  test("decodes a valid payload (including UTF-8)", () => {
    const token = makeJwt({ iss: "https://auth.example.com", exp: 123, name: "café ☕" });
    const p = decodeJwtPayload(token);
    expect(p.iss).toBe("https://auth.example.com");
    expect(p.exp).toBe(123);
    expect(p.name).toBe("café ☕");
  });

  test("handles unpadded base64url payloads", () => {
    const token = `${b64url("{}")}.${b64url('{"exp":42}')}.x`;
    expect(decodeJwtPayload(token).exp).toBe(42);
  });

  test("returns null for a malformed token (wrong segment count)", () => {
    expect(decodeJwtPayload("only-one-part")).toBeNull();
    expect(decodeJwtPayload("a.b")).toBeNull();
    expect(decodeJwtPayload("a.b.c.d")).toBeNull();
  });

  test("returns null for a non-JWT string", () => {
    expect(decodeJwtPayload("not-a-jwt-at-all")).toBeNull();
    expect(decodeJwtPayload("")).toBeNull();
    expect(decodeJwtPayload(null)).toBeNull();
    expect(decodeJwtPayload(undefined)).toBeNull();
  });

  test("returns null when the payload is not valid JSON", () => {
    const token = `${b64url("{}")}.${b64url("not json")}.sig`;
    expect(decodeJwtPayload(token)).toBeNull();
  });

  test("returns null when the payload decodes to a non-object", () => {
    const token = `${b64url("{}")}.${b64url("42")}.sig`;
    expect(decodeJwtPayload(token)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sessionExpiresAt / needsRefresh

describe("sessionExpiresAt", () => {
  test("prefers the stored expiresAt", () => {
    expect(sessionExpiresAt({ accessToken: makeJwt({ exp: 1 }), expiresAt: 999 })).toBe(999);
  });

  test("falls back to the token's exp claim", () => {
    expect(sessionExpiresAt({ accessToken: makeJwt({ exp: 555 }) })).toBe(555);
  });

  test("returns null when nothing is known", () => {
    expect(sessionExpiresAt({ accessToken: "opaque" })).toBeNull();
    expect(sessionExpiresAt({})).toBeNull();
    expect(sessionExpiresAt(null)).toBeNull();
  });
});

describe("needsRefresh skew boundaries", () => {
  test("stale when the expiry is inside the skew window (inclusive)", () => {
    expect(needsRefresh({ accessToken: "t", expiresAt: NOW + 300 }, 300, NOW)).toBe(true);
  });

  test("fresh when the expiry is one second beyond the skew window", () => {
    expect(needsRefresh({ accessToken: "t", expiresAt: NOW + 301 }, 300, NOW)).toBe(false);
  });

  test("stale when the expiry is one second inside the skew window", () => {
    expect(needsRefresh({ accessToken: "t", expiresAt: NOW + 299 }, 300, NOW)).toBe(true);
  });

  test("stale once actually expired", () => {
    expect(needsRefresh({ accessToken: "t", expiresAt: NOW - 1 }, 300, NOW)).toBe(true);
  });

  test("derives staleness from the JWT exp when expiresAt is absent", () => {
    expect(needsRefresh({ accessToken: makeJwt({ exp: NOW + 100 }) }, 300, NOW)).toBe(true);
    expect(needsRefresh({ accessToken: makeJwt({ exp: NOW + 1000 }) }, 300, NOW)).toBe(false);
  });

  test("unknown expiry is not stale; missing token is stale", () => {
    expect(needsRefresh({ accessToken: "opaque" }, 300, NOW)).toBe(false);
    expect(needsRefresh({}, 300, NOW)).toBe(true);
    expect(needsRefresh(null, 300, NOW)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deriveAuthBaseUrl

describe("deriveAuthBaseUrl", () => {
  test("uses the iss origin and appends /auth/v1", () => {
    expect(deriveAuthBaseUrl({ accessToken: makeJwt({ iss: "https://auth.example.com" }) }))
      .toBe("https://auth.example.com/auth/v1");
  });

  test("does not double-append when iss already ends in /auth/v1", () => {
    expect(deriveAuthBaseUrl({ accessToken: makeJwt({ iss: "https://auth.example.com/auth/v1" }) }))
      .toBe("https://auth.example.com/auth/v1");
  });

  test("returns null when iss is not a URL or is absent", () => {
    expect(deriveAuthBaseUrl({ accessToken: makeJwt({ iss: "supabase" }) })).toBeNull();
    expect(deriveAuthBaseUrl({ accessToken: makeJwt({}) })).toBeNull();
    expect(deriveAuthBaseUrl({ accessToken: "opaque" })).toBeNull();
    expect(deriveAuthBaseUrl(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// request shape

describe("refresh request shape", () => {
  test("POSTs to <authBaseUrl>/token?grant_type=refresh_token with the client key and refresh token", async () => {
    const calls = [];
    const o = opts({ fetchFn: recordingFetch(okJson(sessionJson()), calls) });
    const s = session();
    await refreshSession(s, o);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://auth.example.com/auth/v1/token?grant_type=refresh_token");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(typeof headers.apikey).toBe("string");
    expect(headers.apikey.length).toBeGreaterThan(0);
    expect(headers.Authorization).toBe(`Bearer ${headers.apikey}`);
    expect(JSON.parse(calls[0].init.body)).toEqual({ refresh_token: "refresh-token-old" });
  });

  test("honours an explicit authBaseUrl override", async () => {
    const calls = [];
    const o = opts({ authBaseUrl: "https://custom.example/x/auth/v1", fetchFn: recordingFetch(okJson(sessionJson()), calls) });
    await refreshSession(session(), o);
    expect(calls[0].url).toBe("https://custom.example/x/auth/v1/token?grant_type=refresh_token");
  });
});

// ---------------------------------------------------------------------------
// rotation persistence

describe("refresh-token rotation persistence", () => {
  test("persists the rotated refresh token and returns the new session", async () => {
    const o = opts({ fetchFn: recordingFetch(okJson(sessionJson()), []) });
    const updated = await refreshSession(session(), o);
    expect(updated.accessToken).toBe("new-access-token");
    expect(updated.refreshToken).toBe("refresh-token-new");
    expect(updated.expiresAt).toBe(NOW + 3600);

    const stored = JSON.parse(o.storage.getItem(SESSION_STORAGE_KEY));
    expect(stored).toEqual({ accessToken: "new-access-token", refreshToken: "refresh-token-new", expiresAt: NOW + 3600 });
  });

  test("keeps the old refresh token when the response does not rotate it", async () => {
    const body = sessionJson({ refresh_token: undefined });
    const o = opts({ fetchFn: recordingFetch(okJson(body), []) });
    const updated = await refreshSession(session(), o);
    expect(updated.refreshToken).toBe("refresh-token-old");
  });

  test("derives expiresAt from the new token's exp when expires_in is absent", async () => {
    const newToken = makeJwt({ exp: NOW + 7200 });
    const o = opts({ fetchFn: recordingFetch(okJson({ access_token: newToken, refresh_token: "r2" }), []) });
    const updated = await refreshSession(session(), o);
    expect(updated.expiresAt).toBe(NOW + 7200);
  });

  test("persists only the three extracted fields", async () => {
    const body = sessionJson({ user: { id: "secret-user" }, extra: "nope" });
    const o = opts({ fetchFn: recordingFetch(okJson(body), []) });
    await refreshSession(session(), o);
    const stored = JSON.parse(o.storage.getItem(SESSION_STORAGE_KEY));
    expect(Object.keys(stored).sort()).toEqual(["accessToken", "expiresAt", "refreshToken"]);
  });

  test("adopts a session another tab already rotated (no second request)", async () => {
    const o = opts();
    o.storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
      accessToken: "other-tab-access",
      refreshToken: "refresh-token-rotated-by-other-tab",
      expiresAt: NOW + 3600,
    }));
    const calls = [];
    o.fetchFn = recordingFetch(okJson(sessionJson()), calls);
    const result = await refreshSession(session(), o);
    expect(calls).toHaveLength(0);
    expect(result.accessToken).toBe("other-tab-access");
  });
});

// ---------------------------------------------------------------------------
// single-flight

describe("single-flight coalescing", () => {
  test("concurrent refreshes of the same session make exactly one network call", async () => {
    const calls = [];
    const { promise: gate, resolve: release } = Promise.withResolvers();
    const fetchFn = recordingFetch(async () => {
      await gate;
      return okJson(sessionJson());
    }, calls);
    const o = opts({ fetchFn });
    const s = session();

    const p1 = refreshSession(s, o);
    const p2 = refreshSession(s, o);
    const p3 = refreshSession(s, o);
    release();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(calls).toHaveLength(1);
    expect(r1.accessToken).toBe("new-access-token");
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
  });

  test("sequential refreshes both reach the endpoint when storage cannot adopt them", async () => {
    const calls = [];
    // storage: null disables persistence/adoption, so each call is a real request.
    const o = { locks: testLocks(), now: NOW, storage: null, fetchFn: recordingFetch(okJson(sessionJson()), calls) };
    await refreshSession(session(), o);
    await refreshSession(session(), o);
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// failure paths — graceful fallback, never throws

describe("failure paths", () => {
  test("no refresh token resolves to null without a request", async () => {
    const calls = [];
    const o = opts({ fetchFn: recordingFetch(okJson(sessionJson()), calls) });
    expect(await refreshSession({ accessToken: "t" }, o)).toBeNull();
    expect(await refreshSession(null, o)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("a rejected refresh token (400) resolves to null, not a throw", async () => {
    const o = opts({ fetchFn: recordingFetch(new Response('{"msg":"Refresh token is not valid"}', { status: 400 }), []) });
    expect(await refreshSession(session(), o)).toBeNull();
  });

  test("a network/CORS failure resolves to null", async () => {
    const o = opts({ fetchFn: async () => { throw new TypeError("Failed to fetch"); } });
    expect(await refreshSession(session(), o)).toBeNull();
  });

  test("a malformed success body resolves to null", async () => {
    const o = opts({ fetchFn: recordingFetch(okJson({ no: "access token" }), []) });
    expect(await refreshSession(session(), o)).toBeNull();
  });

  test("a non-JSON success body resolves to null", async () => {
    const o = opts({ fetchFn: recordingFetch(new Response("<html>", { status: 200 }), []) });
    expect(await refreshSession(session(), o)).toBeNull();
  });

  test("ensureFreshSession returns the original session when refresh fails", async () => {
    const s = session({ expiresAt: NOW - 1 });
    const o = opts({ fetchFn: recordingFetch(new Response("", { status: 400 }), []) });
    expect(await ensureFreshSession(s, o)).toEqual(s);
  });

  test("ensureFreshSession does not refresh a fresh session", async () => {
    const calls = [];
    const o = opts({ fetchFn: recordingFetch(okJson(sessionJson()), calls) });
    const s = session();
    expect(await ensureFreshSession(s, o)).toEqual(s);
    expect(calls).toHaveLength(0);
  });

  test("ensureFreshSession returns the refreshed session on success", async () => {
    const o = opts({ fetchFn: recordingFetch(okJson(sessionJson()), []) });
    const updated = await ensureFreshSession(session({ expiresAt: NOW - 1 }), o);
    expect(updated.accessToken).toBe("new-access-token");
  });
});

// ---------------------------------------------------------------------------
// proactive refresh

describe("installProactiveRefresh", () => {
  test("tick refreshes a stale stored session and persists the rotation", async () => {
    const calls = [];
    const o = opts({ fetchFn: recordingFetch(okJson(sessionJson()), calls) });
    o.storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: "old", refreshToken: "rt", expiresAt: NOW - 10 }));
    const timer = installProactiveRefresh(o);
    await timer.tick();
    expect(calls.length).toBe(1);
    expect(JSON.parse(o.storage.getItem(SESSION_STORAGE_KEY)).accessToken).toBe("new-access-token");
    await timer.tick();
    // The second tick finds the rotated session already fresh: no new request.
    expect(calls.length).toBe(1);
    timer.stop();
  });

  test("schedules the interval and stop clears it", () => {
    const scheduled = [];
    const cleared = [];
    const o = opts({ setInterval: (fn, ms) => { scheduled.push({ fn, ms }); return 7; }, clearInterval: (id) => cleared.push(id) });
    const timer = installProactiveRefresh(o);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBeGreaterThan(0);
    timer.stop();
    expect(cleared).toEqual([7]);
  });

  test("is inert without storage", async () => {
    const timer = installProactiveRefresh({ storage: null });
    await timer.tick();
    timer.stop();
  });
});

// ---------------------------------------------------------------------------
// import-path integration: parseCardUrl refreshes internally

describe("parseCardUrl refresh integration", () => {
  const UUID = "11a1025a-dbc4-4d65-8fa6-32d5df7555c4";
  const SOURCE_URL = `https://janitorai.com/characters/${UUID}`;

  test("refreshes an expiring session then imports with the new token", async () => {
    const seen = [];
    const o = opts({
      fetchFn: async (url, init) => {
        if (String(url).includes("/token?grant_type=refresh_token")) {
          return okJson(sessionJson({ access_token: "rotated-access" }));
        }
        seen.push(init?.headers?.Authorization || null);
        return okJson({ name: "C", personality: "p", scenario: "s", first_message: "hi" });
      },
    });
    const card = await parseCardUrl(SOURCE_URL, session({ expiresAt: NOW - 1 }), o);
    expect(card.data.name).toBe("C");
    expect(seen).toEqual(["Bearer rotated-access"]);
  });

  test("still throws the expiry error when refresh fails", async () => {
    let apiReached = false;
    const o = opts({ fetchFn: async (url) => {
      if (String(url).includes("grant_type=refresh_token")) return new Response("", { status: 400 });
      // Unchanged prior behaviour: the expiry check fires before the API is
      // reached, so this branch must stay unreachable.
      apiReached = true;
      return okJson({ name: "C", personality: "p" });
    }, now: NOW });
    // Expired under both the real clock and the injected one.
    await expect(parseCardUrl(SOURCE_URL, session({ expiresAt: 1000 }), o))
      .rejects.toThrow("Your stored session has expired");
    expect(apiReached).toBe(false);
  });

  test("refreshes a session with no expiresAt when its JWT is stale", async () => {
    const staleToken = makeJwt({ iss: "https://auth.example.com", exp: NOW - 5 });
    const seen = [];
    const o = opts({
      fetchFn: async (url, init) => {
        if (String(url).includes("grant_type=refresh_token")) return okJson(sessionJson({ access_token: "rotated-access" }));
        seen.push(init?.headers?.Authorization || null);
        return okJson({ name: "C", personality: "p" });
      },
    });
    await parseCardUrl(SOURCE_URL, { accessToken: staleToken, refreshToken: "rt", expiresAt: null }, o);
    expect(seen).toEqual(["Bearer rotated-access"]);
  });

  test("does not refresh a fresh session (no extra network call)", async () => {
    let refreshCalls = 0;
    const o = opts({
      fetchFn: async (url) => {
        if (String(url).includes("grant_type=refresh_token")) { refreshCalls++; return okJson(sessionJson()); }
        return okJson({ name: "C", personality: "p" });
      },
    });
    await parseCardUrl(SOURCE_URL, session(), o);
    expect(refreshCalls).toBe(0);
  });

  test("a stripped response after a successful refresh still throws the noFallback auth error", async () => {
    const o = opts({
      fetchFn: async (url) => {
        if (String(url).includes("grant_type=refresh_token")) return okJson(sessionJson());
        return okJson({ name: "C", personality: null, scenario: null, first_message: null, first_messages: null, example_dialogs: null });
      },
    });
    let err = null;
    try {
      await parseCardUrl(SOURCE_URL, session({ expiresAt: NOW - 1 }), o);
    } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.noFallback).toBe(true);
  });

  test("a session without a refresh token is not refreshed and the API is still called", async () => {
    let refreshCalls = 0;
    const o = opts({
      fetchFn: async (url, init) => {
        if (String(url).includes("grant_type=refresh_token")) { refreshCalls++; return okJson(sessionJson()); }
        expect(init?.headers?.Authorization).toBe("Bearer old-access");
        return okJson({ name: "C", personality: "p" });
      },
    });
    const card = await parseCardUrl(SOURCE_URL, { accessToken: "old-access", expiresAt: NOW - 1 }, o);
    expect(refreshCalls).toBe(0);
    expect(card.data.name).toBe("C");
  });

  test("refresh never throws out of the import path", async () => {
    const o = opts({ fetchFn: async (url, init) => {
      // Refresh endpoint unreachable/expired, but the character API is alive:
      // the import must return the card under the original unexpired session.
      if (String(url).includes("grant_type=refresh_token")) throw new TypeError("Failed to fetch");
      expect(init?.headers?.Authorization).toBe("Bearer old-access");
      return okJson({ name: "C", personality: "p" });
    } });
    const card = await parseCardUrl(SOURCE_URL, { accessToken: "old-access", refreshToken: "rt", expiresAt: NOW + 3600 }, o);
    expect(card.data.name).toBe("C");
  });
});

// ---------------------------------------------------------------------------
// security: no token value ever reaches console/log output

describe("token confidentiality", () => {
  test("no token value is written to console or stdout on success or failure", async () => {
    const SECRET_ACCESS = "SECRET-ACCESS-TOKEN-abc123";
    const SECRET_REFRESH = "SECRET-REFRESH-TOKEN-xyz789";
    const captured = [];
    const record = (...args) => { captured.push(args.map((a) => {
      try { return typeof a === "string" ? a : JSON.stringify(a); } catch { return String(a); }
    }).join(" ")); };
    for (const m of ["log", "info", "warn", "error", "debug", "trace"]) console[m] = record;
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => { captured.push(String(chunk)); return originalWrite(chunk, ...rest); };

    try {
      const s = { accessToken: SECRET_ACCESS, refreshToken: SECRET_REFRESH, expiresAt: NOW - 1 };
      // success
      const o1 = opts({ fetchFn: recordingFetch(okJson({ access_token: "rotated-" + SECRET_ACCESS, refresh_token: "rotated-" + SECRET_REFRESH, expires_in: 3600 }), []) });
      await refreshSession(s, o1);
      await ensureFreshSession(s, o1);
      // failure
      const o2 = opts({ fetchFn: async () => { throw new TypeError("Failed to fetch"); } });
      await refreshSession(s, o2);
      await ensureFreshSession(s, o2);
    } finally {
      process.stdout.write = originalWrite;
    }

    const blob = captured.join("\n");
    expect(blob).not.toContain(SECRET_ACCESS);
    expect(blob).not.toContain(SECRET_REFRESH);
  });

  test("error messages from the import path never embed the token", async () => {
    const SECRET_ACCESS = "SECRET-ACCESS-TOKEN-abc123";
    const o = opts({ fetchFn: async (url) => {
      if (String(url).includes("grant_type=refresh_token")) return new Response("", { status: 400 });
      return new Response("", { status: 500 });
    } });
    let message = "";
    try {
      await parseCardUrl("https://janitorai.com/characters/11a1025a-dbc4-4d65-8fa6-32d5df7555c4", { accessToken: SECRET_ACCESS, refreshToken: "SECRET-REFRESH", expiresAt: NOW + 3600 }, o);
    } catch (e) { message = String(e.message); }
    expect(message).not.toContain(SECRET_ACCESS);
    expect(message).not.toContain("SECRET-REFRESH");
  });
});
