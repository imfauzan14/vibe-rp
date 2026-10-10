import { describe, test, expect, afterEach } from "bun:test";
import { SOURCE_PAGE_RE, isCharacterPageUrl, mapSourceJsonToCard, fetchRemoteCard, parseCardUrl, extractSessionToken } from "../public/remote_import.js";
import { normalizeCard } from "../public/card_parse.js";

const UUID = "11a1025a-dbc4-4d65-8fa6-32d5df7555c4";
const SOURCE_URL = `https://janitorai.com/characters/${UUID}_character-medieval-fantasy-world-rp`;
const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function mockFetch(routes) {
  globalThis.fetch = async (url, opts) => {
    for (const [match, handler] of routes) {
      if (typeof match === "string" ? String(url).startsWith(match) : match.test(String(url))) {
        return handler(String(url), opts);
      }
    }
    return new Response("not found", { status: 404 });
  };
}

const sourceJson = (over = {}) => ({
  name: "Sir Roland",
  description: "A knight.",
  personality: "Brave.",
  scenario: "The realm.",
  first_message: "Hail!",
  first_messages: ["Hail!", "Greetings."],
  example_dialogs: "<START> {{user}}: hi",
  creator_name: "maker",
  tags: [{ tag: { name: "😱 Horror" } }, { tag: { name: "Fantasy" } }],
  custom_tags: ["epic"],
  avatar: "av-123.png",
  is_nsfw: false,
  allow_proxy: true,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-06-01T00:00:00Z",
  stats: { chat: 10, message: 200 },
  token_counts: { total_tokens: 1500 },
  ...over,
});

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

// Minimal PNG: 8-byte signature + one tEXt chunk (keyword "chara", plain JSON value).
function pngWithChara(jsonText) {
  const enc = new TextEncoder();
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const data = new Uint8Array([...enc.encode("chara\0"), ...enc.encode(jsonText)]);
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  chunk.set(enc.encode("tEXt"), 4);
  chunk.set(data, 8);
  const out = new Uint8Array(sig.length + chunk.length);
  out.set(sig); out.set(chunk, sig.length);
  return out;
}

function pngWithoutChara() {
  const enc = new TextEncoder();
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const data = enc.encode("other\0x");
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  chunk.set(enc.encode("tEXt"), 4);
  chunk.set(data, 8);
  const out = new Uint8Array(sig.length + chunk.length);
  out.set(sig); out.set(chunk, sig.length);
  return out;
}

function webpWithoutChara() {
  const enc = new TextEncoder();
  const out = new Uint8Array(12 + 8 + 4);
  const dv = new DataView(out.buffer);
  out.set(enc.encode("RIFF"), 0);
  dv.setUint32(4, out.length - 8, true);
  out.set(enc.encode("WEBP"), 8);
  out.set(enc.encode("VP8 "), 12);
  dv.setUint32(16, 4, true);
  return out;
}

const v2Card = { spec: "chara_card_v2", spec_version: "2.0", data: { name: "V2 Char", description: "d" } };
const v1Card = { name: "V1 Char", description: "flat" };

describe("Character page URL import", () => {
  // --- URL validation matrix ---

  test("1. uuid-only URL matches and extracts the uuid", () => {
    expect(isCharacterPageUrl(`https://janitorai.com/characters/${UUID}`)).toBe(UUID);
  });

  test("2. slug suffix matches and extracts the uuid", () => {
    expect(isCharacterPageUrl(SOURCE_URL)).toBe(UUID);
  });

  test("3. query string matches", () => {
    expect(isCharacterPageUrl(`${SOURCE_URL}?utm_source=test`)).toBe(UUID);
  });

  test("4. non-uuid path does not match", () => {
    expect(isCharacterPageUrl("https://janitorai.com/characters/not-a-uuid")).toBe(null);
  });

  test("5. hampter (API) path does not match", () => {
    expect(isCharacterPageUrl(`https://janitorai.com/hampter/characters/${UUID}`)).toBe(null);
  });

  test("6. plain JSON URL does not match source page pattern", () => {
    expect(isCharacterPageUrl("https://example.com/cards/char.json")).toBe(null);
  });

  test("7. empty URL to parseCardUrl throws Paste a URL", async () => {
    await expect(parseCardUrl("   ")).rejects.toThrow("Paste a URL to import.");
  });

  test("8. missing scheme is pre-pended (character page host)", () => {
    expect(isCharacterPageUrl(`janitorai.com/characters/${UUID}`)).toBe(UUID);
  });

  // --- Mapping ---

  test("9. full field mapping produces exact v2 shape", () => {
    const card = mapSourceJsonToCard(sourceJson(), SOURCE_URL);
    expect(card.spec).toBe("chara_card_v2");
    expect(card.spec_version).toBe("2.0");
    expect(card.data).toEqual({
      name: "Sir Roland",
      description: "A knight.",
      personality: "Brave.",
      scenario: "The realm.",
      first_mes: "Hail!",
      alternate_greetings: ["Hail!", "Greetings."],
      example_dialogs: "<START> {{user}}: hi",
      creator: "maker",
      creator_notes: `Imported from source site: ${SOURCE_URL}`,
      tags: ["Horror", "Fantasy", "epic"],
      extensions: {
        source: {
          avatar_url: "https://ella.janitorai.com/bot-avatars/av-123.png?width=400",
          is_nsfw: false,
          allow_proxy: true,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-06-01T00:00:00Z",
          stats: { chats: 10, messages: 200 },
        },
      },
    });
  });

  test("10. emoji tag prefix stripped and both tag shapes land", () => {
    const card = mapSourceJsonToCard(sourceJson(), SOURCE_URL);
    expect(card.data.tags).toContain("Horror");
    expect(card.data.tags).toContain("epic");
  });

  test("11. stats omitted when absent", () => {
    const card = mapSourceJsonToCard(sourceJson({ stats: undefined }), SOURCE_URL);
    expect(card.data.extensions.source.stats).toBeUndefined();
  });

  // --- Stripped-field notice ---

  test("12. notice appended whenever all definition fields are empty", () => {
    const card = mapSourceJsonToCard(sourceJson({
      personality: null, scenario: null, first_message: null, first_messages: null,
      example_dialogs: null,
    }), SOURCE_URL);
    expect(card.data.description).toContain("were not included");
    expect(card.data.description).toContain("Settings → Engine → Import session");
  });

  test("13. no notice when first_message present", () => {
    const card = mapSourceJsonToCard(sourceJson({ personality: null, scenario: null }), SOURCE_URL);
    expect(card.data.description).not.toContain("[Imported from a character page");
  });

  test("14. notice appended even when token_counts is absent (anonymous reports 0)", () => {
    const card = mapSourceJsonToCard(sourceJson({
      personality: null, scenario: null, first_message: null, first_messages: null,
      example_dialogs: null, token_counts: undefined,
    }), SOURCE_URL);
    expect(card.data.description).toContain("were not included");
  });

  test("14b. no notice when every definition field is populated", () => {
    const card = mapSourceJsonToCard(sourceJson(), SOURCE_URL);
    expect(card.data.description).not.toContain("[Imported from a character page");
  });
  test("14c. HTML definition fields are converted, not stored verbatim", () => {
    const card = mapSourceJsonToCard(sourceJson({
      description: '<p style="text-align:center"><em>"Your leadership has failed us."</em></p>',
      personality: '<p><strong>Brave</strong></p>',
      scenario: '<p>Realm</p><hr><p>Hook</p>',
      first_message: '<p>Hail, {{user}}!</p>',
      first_messages: ['<p>G1</p>', '<em>G2</em>'],
      example_dialogs: '<p><START> {{user}}: hi</p>',
    }), SOURCE_URL);
    expect(card.data.description).toBe('*"Your leadership has failed us."*');
    expect(card.data.personality).toBe("**Brave**");
    expect(card.data.scenario).toBe("Realm\n\n---\n\nHook");
    expect(card.data.first_mes).toBe("Hail, {{user}}!");
    expect(card.data.alternate_greetings).toEqual(["G1", "*G2*"]);
    expect(card.data.example_dialogs).toContain("<START>");
    expect(card.data.example_dialogs).toContain("{{user}}: hi");
    // Every field must be tag-free; the app's own <START> card marker is the
    // one intentional exception and is asserted separately above.
    for (const v of [card.data.description, card.data.personality, card.data.scenario,
      card.data.first_mes, card.data.example_dialogs, ...card.data.alternate_greetings]) {
      expect(v.replace(/<START>/g, "")).not.toMatch(/<[a-zA-Z][^<>]*>/);
    }
  });

  test("14d. creator provenance note is appended verbatim, never mangled", () => {
    const card = mapSourceJsonToCard(sourceJson(), SOURCE_URL);
    expect(card.data.creator_notes).toBe(`Imported from source site: ${SOURCE_URL}`);
  });
  // --- Source page fetch ---

  test("15. 200 response maps to a card", async () => {
    mockFetch([[`https://janitorai.com/hampter/characters/${UUID}`, () => jsonRes(sourceJson())]]);
    const card = await fetchRemoteCard(UUID, SOURCE_URL);
    expect(card.data.name).toBe("Sir Roland");
  });

  test("16. 404 throws with status", async () => {
    mockFetch([[`https://janitorai.com/hampter/characters/${UUID}`, () => jsonRes({}, 404)]]);
    await expect(fetchRemoteCard(UUID, SOURCE_URL)).rejects.toThrow("The character page API returned 404 for this character.");
  });

  test("17. fetch rejection surfaces the original network error (no fallback)", async () => {
    const boom = new TypeError("Failed to fetch");
    mockFetch([[`https://janitorai.com/hampter/characters/${UUID}`, () => { throw boom; }]]);
    await expect(fetchRemoteCard(UUID, SOURCE_URL)).rejects.toBe(boom);
  });

  test("18. network error is not masked by any secondary request", async () => {
    const seen = [];
    const boom = new TypeError("Failed to fetch");
    mockFetch([[`https://janitorai.com/hampter/characters/${UUID}`, () => { seen.push("primary"); throw boom; }]]);
    await expect(fetchRemoteCard(UUID, SOURCE_URL)).rejects.toBe(boom);
    expect(seen).toEqual(["primary"]);
  });


  // --- JSON URL dispatch ---

  test("20. direct URL to a v2 card JSON normalizes", async () => {
    mockFetch([["https://example.com/char.json", () => jsonRes(v2Card)]]);
    const card = await parseCardUrl("https://example.com/char.json");
    expect(card.spec).toBe("chara_card_v2");
    expect(card.data.name).toBe("V2 Char");
  });

  test("21. JSONC with comments and trailing commas parses", async () => {
    const text = `{\n  // note\n  /* block */\n  "name": "Jsonc Char",\n  "description": "d",\n}`;
    mockFetch([["https://example.com/char.jsonc", () => new Response(text, { status: 200 })]]);
    const card = await parseCardUrl("https://example.com/char.jsonc");
    expect(card.data.name).toBe("Jsonc Char");
    expect(card.spec).toBe("chara_card_v1");
  });

  test("22. v1 flat card normalizes", async () => {
    mockFetch([["https://example.com/v1.json", () => jsonRes(v1Card)]]);
    const card = await parseCardUrl("https://example.com/v1.json");
    expect(card.spec).toBe("chara_card_v1");
    expect(card.data.name).toBe("V1 Char");
  });

  test("23. 404 status interpolated into error", async () => {
    mockFetch([["https://example.com/missing.json", () => new Response("no", { status: 404 })]]);
    await expect(parseCardUrl("https://example.com/missing.json")).rejects.toThrow("Could not fetch URL (404): check the link and that the site allows browser access.");
  });

  // --- PNG URL dispatch ---

  test("24. PNG URL with chara tEXt chunk yields card", async () => {
    const bytes = pngWithChara(JSON.stringify(v2Card));
    mockFetch([["https://example.com/card.png", () => new Response(bytes, { status: 200, headers: { "Content-Type": "image/png" } })]]);
    const card = await parseCardUrl("https://example.com/card.png");
    expect(card.data.name).toBe("V2 Char");
  });

  test("25. PNG without chara throws", async () => {
    mockFetch([["https://example.com/plain.png", () => new Response(pngWithoutChara(), { status: 200, headers: { "Content-Type": "image/png" } })]]);
    await expect(parseCardUrl("https://example.com/plain.png")).rejects.toThrow("No character data embedded in this PNG.");
  });

  test("26. octet-stream PNG sniffed by magic bytes", async () => {
    const bytes = pngWithChara(JSON.stringify(v2Card));
    mockFetch([["https://example.com/blob", () => new Response(bytes, { status: 200, headers: { "Content-Type": "application/octet-stream" } })]]);
    const card = await parseCardUrl("https://example.com/blob");
    expect(card.data.name).toBe("V2 Char");
  });

  // --- Content sniffing errors ---

  test("27. HTML page response yields web-page error", async () => {
    mockFetch([["https://example.com/page", () => new Response("<html><body>hi</body></html>", { status: 200, headers: { "Content-Type": "text/html" } })]]);
    await expect(parseCardUrl("https://example.com/page")).rejects.toThrow("URL returned a web page, not a card file. Paste a direct card file link or the character's page URL.");
  });

  test("28. json content-type with non-json body yields card error", async () => {
    mockFetch([["https://example.com/bad.json", () => new Response("just some words", { status: 200, headers: { "Content-Type": "application/json" } })]]);
    await expect(parseCardUrl("https://example.com/bad.json")).rejects.toThrow("URL did not return a character card (JSON, PNG, or WebP).");
  });

  test("29. webp without chara throws", async () => {
    mockFetch([["https://example.com/plain.webp", () => new Response(webpWithoutChara(), { status: 200, headers: { "Content-Type": "image/webp" } })]]);
    await expect(parseCardUrl("https://example.com/plain.webp")).rejects.toThrow("No character data embedded in this WebP.");
  });

  // --- Guard ---

  test("30. mapSourceJsonToCard without name throws", () => {
    expect(() => mapSourceJsonToCard({ name: null }, SOURCE_URL)).toThrow("Character page API response did not contain a character.");
    expect(() => mapSourceJsonToCard(null, SOURCE_URL)).toThrow("Character page API response did not contain a character.");
  });
});

// --- Session-cookies JSON auth ---

const SESSION = {
  access_token: "test-access-token",
  refresh_token: "test-refresh-token",
  expires_at: 4102444800, // 2100-01-01
};

// base64("base64-" style) encoding of the session JSON, as stored by Supabase.
function b64(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return "base64-" + btoa(bin);
}

const anonSourceJson = sourceJson({
  personality: null, scenario: null, first_message: null, first_messages: null,
  example_dialogs: null, token_counts: { total_tokens: 1500 },
});

describe("Session-cookies JSON auth", () => {
  test("31. chunked cookie array extracts session", () => {
    const s = JSON.stringify(SESSION);
    const half = Math.ceil(s.length / 2);
    const cookies = [
      { name: "sb-auth-auth-token.1", value: "base64-" + btoa(s.slice(half)) },
      { name: "sb-auth-auth-token.0", value: "base64-" + btoa(s.slice(0, half)) },
      { name: "sb-auth-auth-token.code-verifier", value: "junk" },
      { name: "sb-auth-auth-token.flows", value: "junk" },
    ];
    const token = extractSessionToken(JSON.stringify(cookies));
    expect(token).not.toBeNull();
    expect(token.accessToken).toBe(SESSION.access_token);
    expect(token.refreshToken).toBe(SESSION.refresh_token);
    expect(token.expiresAt).toBe(SESSION.expires_at);
  });

  test("32. percent-encoded chunked values decode", () => {
    const s = JSON.stringify(SESSION);
    const half = Math.ceil(s.length / 2);
    const cookies = [
      { name: "sb-auth-auth-token.0", value: encodeURIComponent("base64-" + btoa(s.slice(0, half))) },
      { name: "sb-auth-auth-token.1", value: encodeURIComponent("base64-" + btoa(s.slice(half))) },
    ];
    const token = extractSessionToken(cookies);
    expect(token?.accessToken).toBe(SESSION.access_token);
  });

  test("41b. chunked base64 split at non-quartet boundary decodes via concat fallback", () => {
    // Mimics real Supabase export: the base64 STRING is chunked at an arbitrary
    // position, so chunks are not individually quartet-aligned. Chunk 0 keeps
    // the "base64-" prefix; chunk 1 is raw continuation (3 leftover chars
    // complete chunk 0's last quartet), making per-chunk decode produce
    // garbage/unpadding errors. Only concat-then-decode succeeds.
    const full = b64(SESSION);
    const payload = full.slice(7); // raw base64
    const split = payload.length - 3; // leaves 3 chars on chunk 1
    const cookies = [
      { name: "sb-auth-auth-token.0", value: full.slice(0, split + 7) },
      { name: "sb-auth-auth-token.1", value: payload.slice(split) },
      { name: "sb-auth-auth-token-flows-code-verifier", value: "junk" },
    ];
    const token = extractSessionToken(JSON.stringify(cookies));
    expect(token?.accessToken).toBe(SESSION.access_token);
    expect(token?.refreshToken).toBe(SESSION.refresh_token);
  });

  test("33. unchunked single cookie extracts session", () => {
    const cookies = [{ name: "sb-auth-auth-token", value: b64(SESSION) }];
    expect(extractSessionToken(JSON.stringify(cookies))?.accessToken).toBe(SESSION.access_token);
  });

  test("34. base64url unpadded value decodes", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(SESSION));
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const b64url = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const cookies = [{ name: "sb-auth-auth-token", value: b64url }];
    expect(extractSessionToken(cookies)?.accessToken).toBe(SESSION.access_token);
  });

  test("35. un-decoded localStorage shape (value is raw session JSON)", () => {
    const cookies = [{ name: "sb-auth-auth-token", value: JSON.stringify(SESSION) }];
    const token = extractSessionToken(cookies);
    expect(token?.accessToken).toBe(SESSION.access_token);
    expect(token?.refreshToken).toBe(SESSION.refresh_token);
  });

  test("36. already-parsed array and single cookie object accepted", () => {
    const single = { name: "sb-auth-auth-token", value: b64(SESSION) };
    expect(extractSessionToken([single])?.accessToken).toBe(SESSION.access_token);
    expect(extractSessionToken(single)?.accessToken).toBe(SESSION.access_token);
  });

  test("37. code-verifier and flows cookies excluded even without auth-token chunks", () => {
    const cookies = [
      { name: "sb-auth-auth-token.code-verifier", value: b64(SESSION) },
      { name: "sb-auth-auth-token.flows", value: b64(SESSION) },
    ];
    expect(extractSessionToken(cookies)).toBeNull();
  });

  test("38. garbage JSON returns null", () => {
    expect(extractSessionToken("not json at all {")).toBeNull();
  });

  test("39. empty input returns null", () => {
    expect(extractSessionToken("")).toBeNull();
    expect(extractSessionToken(null)).toBeNull();
    expect(extractSessionToken([])).toBeNull();
  });

  test("40. missing access_token returns null", () => {
    const cookies = [{ name: "sb-auth-auth-token", value: b64({ refresh_token: "r", expires_at: 1 }) }];
    expect(extractSessionToken(cookies)).toBeNull();
  });

  test("41. JSONC-wrapped cookie array parses via loose parser", () => {
    const single = { name: "sb-auth-auth-token", value: b64(SESSION) };
    const text = `// paste\n${JSON.stringify([single])}`;
    expect(extractSessionToken(text)?.accessToken).toBe(SESSION.access_token);
  });

  test("42. fetchRemoteCard sends Bearer header on primary fetch only", async () => {
    const seen = [];
    mockFetch([
      [`https://janitorai.com/hampter/characters/${UUID}`, (url, opts) => {
        seen.push({ url, auth: (opts?.headers?.Authorization) || null });
        return jsonRes(sourceJson());
      }],
      [/r\.jina\.ai/, () => { seen.push({ url: "jina" }); return jsonRes(sourceJson()); }], // must never be hit
    ]);
    await fetchRemoteCard(UUID, SOURCE_URL, { accessToken: SESSION.access_token, expiresAt: SESSION.expires_at });
    expect(seen).toHaveLength(1);
    expect(seen[0].auth).toBe(`Bearer ${SESSION.access_token}`);
  });

  test("43. stripped response with token throws actionable expired/invalid error", async () => {
    const seen = [];
    mockFetch([
      [`https://janitorai.com/hampter/characters/${UUID}`, () => { seen.push("primary"); return jsonRes(anonSourceJson); }],
    ]);
    await expect(
      fetchRemoteCard(UUID, SOURCE_URL, { accessToken: SESSION.access_token }),
    ).rejects.toThrow("Your stored session is expired or invalid");
    expect(seen).toEqual(["primary"]);
  });

  test("43b. no-token stripped response returns a card that warns instead of failing silently", async () => {
    mockFetch([[`https://janitorai.com/hampter/characters/${UUID}`, () => jsonRes(anonSourceJson)]]);
    const card = await fetchRemoteCard(UUID, SOURCE_URL);
    expect(card.data.name).toBe("Sir Roland");
    expect(card.data.personality).toBe("");
    expect(card.data.description).toContain("were not included");
    expect(card.data.description).toContain("Settings → Engine → Import session");
  });


  test("44. no-token path sends no Authorization header and stays unchanged", async () => {
    const seen = [];
    mockFetch([
      [`https://janitorai.com/hampter/characters/${UUID}`, (url, opts) => {
        seen.push((opts?.headers?.Authorization) || null);
        return jsonRes(sourceJson());
      }],
    ]);
    await fetchRemoteCard(UUID, SOURCE_URL);
    expect(seen).toEqual([null]);
  });

  test("45. parseCardUrl threads session: character page gets header, JSON URL does not", async () => {
    const seen = [];
    mockFetch([
      [`https://janitorai.com/hampter/characters/${UUID}`, (url, opts) => {
        seen.push((opts?.headers?.Authorization) || null);
        return jsonRes(sourceJson());
      }],
      ["https://example.com/char.json", (url, opts) => {
        seen.push((opts?.headers?.Authorization) || null);
        return jsonRes(v2Card);
      }],
    ]);
    const session = { accessToken: SESSION.access_token, expiresAt: SESSION.expires_at };
    const pageCard = await parseCardUrl(`https://janitorai.com/characters/${UUID}`, session);
    expect(pageCard.data.name).toBe("Sir Roland");
    const jsonCard = await parseCardUrl("https://example.com/char.json", session);
    expect(jsonCard.data.name).toBe("V2 Char");
    expect(seen).toEqual([`Bearer ${SESSION.access_token}`, null]);
  });

  test("46. past expires_at throws before fetching", async () => {
    let called = false;
    mockFetch([[`https://janitorai.com/hampter/characters/${UUID}`, () => { called = true; return jsonRes(sourceJson()); }]]);
    await expect(
      parseCardUrl(SOURCE_URL, { accessToken: SESSION.access_token, expiresAt: 1000 }),
    ).rejects.toThrow("Your stored session has expired");
    expect(called).toBe(false);
  });
});
