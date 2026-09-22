// Remote character-page + direct-URL card importing. Pure: no DOM references;
// all browser/fetch behavior goes through the caller-supplied global fetch.

import { parseJsonLoose, normalizeCard, stripJsonComments, parsePngChara, parseWebpChara, htmlToAppMarkup } from "./card_parse.js";
import { ensureFreshSession, refreshSession, maybeAutoStartProactiveRefresh } from "./session_refresh.js";

// Fetch is injectable so callers (and tests) can supply one; default is global.
function resolveFetch(options) {
  const fn = options?.fetchFn;
  return typeof fn === "function" ? fn : globalThis.fetch;
}

// Session-cookies JSON auth.

// Extracts the Supabase SSR session from a browser cookie-export JSON array
// (or an already-parsed array / single cookie object). Returns
// { accessToken, refreshToken, expiresAt } or null; never throws.
export function extractSessionToken(input) {
  try {
    let parsed = input;
    if (typeof input === "string") {
      parsed = parseJsonLoose(stripJsonComments(input));
    }
    if (parsed && !Array.isArray(parsed) && typeof parsed === "object" && parsed.name != null) {
      parsed = [parsed]; // single cookie object
    }
    if (!Array.isArray(parsed)) return null;
    const authCookies = parsed.filter((c) => {
      const n = String(c?.name || "");
      return n.startsWith("sb-") && n.includes("-auth-token")
        && !n.includes("code-verifier") && !n.includes("flows");
    });
    if (!authCookies.length) return null;

    // Decode one cookie value: percent-decode, then either parse as raw
    // session JSON (localStorage shape), or strip "base64-" and decode.
    // Returns an object for a full session, decoded text for a chunk
    // fragment, or null on failure.
    const prepValue = (v) => {
      let s = String(v ?? "");
      if (/%[0-9a-fA-F]{2}/.test(s)) {
        try { s = decodeURIComponent(s); } catch { /* keep raw */ }
      }
      return s;
    };
    const b64Text = (s) => {
      let b64 = s.startsWith("base64-") ? s.slice(7) : s;
      b64 = b64.replace(/-/g, "+").replace(/_/g, "/");
      b64 += "=".repeat((4 - (b64.length % 4)) % 4);
      const bin = atob(b64);
      return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    };
    const decodeValue = (v) => {
      const s = prepValue(v);
      const direct = parseJsonLoose(s);
      if (direct && typeof direct === "object" && direct.access_token) return direct;
      return b64Text(s); // may throw on invalid base64; callers handle
    };
    let session;
    const chunked = authCookies.filter((c) => /\.\d+$/.test(String(c.name)));
    if (chunked.length) {
      // Supabase splits the base64 string itself at arbitrary positions, so
      // chunks may not be quartet-aligned. First try per-chunk decode + join;
      // on failure fall back to decoding the concatenated raw base64.
      const sorted = chunked.sort((a, b) => {
        const na = Number(String(a.name).slice(String(a.name).lastIndexOf(".") + 1));
        const nb = Number(String(b.name).slice(String(b.name).lastIndexOf(".") + 1));
        return na - nb;
      });
      let text = "";
      for (const c of sorted) {
        try {
          const decoded = decodeValue(c.value);
          if (typeof decoded === "string") text += decoded;
        } catch { /* misaligned or invalid chunk; use concat fallback */ }
      }
      session = parseJsonLoose(text);
      if (!session) {
        const raw = sorted.map((c) => {
          const s = prepValue(c.value);
          return s.startsWith("base64-") ? s.slice(7) : s;
        }).join("");
        try { session = parseJsonLoose(b64Text(raw)); } catch { /* not decodable */ }
      }
    } else {
      const decoded = decodeValue(authCookies[0].value);
      session = typeof decoded === "string" ? parseJsonLoose(decoded) : decoded;
    }
    if (!session || typeof session !== "object" || typeof session.access_token !== "string" || !session.access_token) {
      return null;
    }
    return {
      accessToken: session.access_token,
      refreshToken: typeof session.refresh_token === "string" ? session.refresh_token : null,
      expiresAt: Number.isFinite(session.expires_at) ? session.expires_at : null,
    };
  } catch {
    return null;
  }
}


function sessionAuthError(message) {
  const e = new Error(message);
  e.noFallback = true; // never retry or soften this: the response was stripped, not missing
  return e;
}

export const SOURCE_PAGE_RE = /^https:\/\/janitorai\.com\/characters\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[_\/-][^?#]*)?(?:\?.*)?$/i;

export function isCharacterPageUrl(url) {
  let u = String(url || "").trim();
  if (u && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "https://" + u;
  const m = u.match(SOURCE_PAGE_RE);
  return m ? m[1] : null;
}

export function mapSourceJsonToCard(json, sourceUrl) {
  if (!json || !json.name) throw new Error("Character page API response did not contain a character.");
  const clean = (v) => (typeof v === "string" && v ? htmlToAppMarkup(v) : (v ?? ""));
  const data = {
    name: json.name,
    description: clean(json.description),
    personality: clean(json.personality),
    scenario: clean(json.scenario),
    first_mes: clean(json.first_message),
  };
  if (json.first_messages && json.first_messages.length) data.alternate_greetings = json.first_messages.map(clean);
  if (json.example_dialogs != null && json.example_dialogs !== "") data.example_dialogs = clean(json.example_dialogs);
  if (json.creator_name) data.creator = json.creator_name;
  // The provenance note is appended, not converted: it is app-authored plain
  // text and must never be mangled by the HTML pass.
  data.creator_notes = `Imported from source site: ${sourceUrl}`;
  const tags = (json.tags || [])
    .map(t => (t?.tag?.name || ""))
    .map(n => n.replace(/^\p{Extended_Pictographic}\s*/u, ""))
    .filter(Boolean)
    .concat(json.custom_tags || []);
  if (tags.length) data.tags = tags;
  const ext = {
    source: { avatar_url: `https://ella.janitorai.com/bot-avatars/${json.avatar}?width=400` },
  };
  if (json.is_nsfw !== undefined) ext.source.is_nsfw = json.is_nsfw;
  if (json.allow_proxy !== undefined) ext.source.allow_proxy = json.allow_proxy;
  if (json.created_at) ext.source.created_at = json.created_at;
  if (json.updated_at) ext.source.updated_at = json.updated_at;
  if (json.stats?.chat !== undefined || json.stats?.message !== undefined) {
    ext.source.stats = { chats: json.stats.chat, messages: json.stats.message };
  }
  data.extensions = ext;
  // Character-page API strips the definition fields whenever the request is not
  // authenticated with a valid session — whether because no session was supplied
  // or because the supplied one has expired. The API does not signal this with a
  // non-200 status, so an empty definition is the only reliable tell. Warn
  // whenever it is empty so a gutted card is never presented as a full import.
  const allEmpty = !json.personality && !json.scenario && !json.first_message
    && !(json.first_messages && json.first_messages.length)
    && !(json.example_dialogs && json.example_dialogs.length);
  if (allEmpty) {
    data.description += "\n\n[Imported from a character page: this character's personality, scenario, greeting, and example dialogs were not included: the source site only returns them to an authenticated request, and no valid session was available (none stored, or the stored one has expired). Import a valid session in Settings → Engine → Import session to include them.]";
  }
  return { spec: "chara_card_v2", spec_version: "2.0", data };
}

export async function fetchRemoteCard(uuid, sourceUrl, sessionToken, options) {
  const headers = {};
  const token = sessionToken?.accessToken;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await resolveFetch(options)(`https://janitorai.com/hampter/characters/${uuid}`, { headers });
  if (!res.ok) throw new Error(`The character page API returned ${res.status} for this character.`);
  const json = await res.json();
  const card = mapSourceJsonToCard(json, sourceUrl);
  // The API fails silently as anonymous: 200 with stripped definition fields.
  // When a session was supplied that must not happen, so report it as an auth
  // failure rather than handing back a gutted card as if it were complete.
  if (token && !json.personality && !json.scenario && !json.first_message
    && !(json.first_messages && json.first_messages.length)
    && !(json.example_dialogs && json.example_dialogs.length)) {
    throw sessionAuthError("Your stored session is expired or invalid, so this character's definition was not returned. Re-export your session cookies and paste them in Settings → Engine → Import session, then try again.");
  }
  return card;
}

export async function parseCardUrl(url, sessionToken, options) {
  const trimmed = String(url || "").trim();
  if (!trimmed) throw new Error("Paste a URL to import.");

  const uuid = isCharacterPageUrl(trimmed);
  if (uuid) {
    let session = sessionToken;
    // Refresh an expiring/expired session so the import keeps working without
    // any caller change. Refresh never throws: on failure `session` is the
    // original and the expiry/auth errors below still run unchanged.
    if (session?.refreshToken) {
      try {
        session = await ensureFreshSession(session, options || {});
      } catch { /* keep the original session */ }
    }
    if (session?.expiresAt && Date.now() / 1000 > session.expiresAt) {
      throw new Error("Your stored session has expired. Re-export your session cookies and paste them in Settings → Engine → Import session.");
    }
    return fetchRemoteCard(uuid, trimmed, session, options);
  }
  let res;
  try {
    res = await resolveFetch(options)(trimmed);
  } catch {
    throw new Error("Could not fetch URL (network error): check the link and that the site allows browser access.");
  }
  if (!res.ok) {
    throw new Error(`Could not fetch URL (${res.status}): check the link and that the site allows browser access.`);
  }

  const sniffImage = async (ab) => {
    const view = new DataView(ab);
    if (view.byteLength >= 4 && view.getUint32(0) === 0x89504e47) {
      const raw = await parsePngChara(ab);
      if (!raw) throw new Error("No character data embedded in this PNG.");
      return normalizeCard(raw);
    }
    if (view.byteLength >= 12 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
      const raw = parseWebpChara(ab);
      if (!raw) throw new Error("No character data embedded in this WebP.");
      return normalizeCard(raw);
    }
    return null;
  };

  // A fetch body can be consumed only once: read the full buffer, then work
  // from magic bytes and decoded text off that single copy.
  const ab = await res.arrayBuffer();
  const contentType = (res.headers.get("content-type") || "").toLowerCase();

  if (contentType.includes("image/png") || contentType.includes("image/webp")) {
    return sniffImage(ab);
  }

  const text = new TextDecoder().decode(ab);
  const json = parseJsonLoose(stripJsonComments(text));
  if (json) {
    try {
      return normalizeCard(json);
    } catch (err) {
      throw new Error("URL did not return a valid character card: " + err.message);
    }
  }
  // Content-type lied; try magic bytes.
  const card = await sniffImage(ab);
  if (card) return card;
  throw sniffTextError(text);
}

function sniffTextError(text) {
  const t = String(text || "").trim();
  if (!t || t.startsWith("<")) {
    return new Error("URL returned a web page, not a card file. Paste a direct card file link or the character's page URL.");
  }
  return new Error("URL did not return a character card (JSON, PNG, or WebP).");
}

// Additive re-export so callers gain the refresh path without importing a new
// module directly. Refresh starts proactively in real browsers; importing here
// is otherwise inert (no-op outside a DOM + localStorage runtime).
export { ensureFreshSession, refreshSession };
try { maybeAutoStartProactiveRefresh(); } catch { /* never throw at import time */ }
