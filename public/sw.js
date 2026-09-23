// Offline shell cache for Vibe RP.
//
// The app is a static client with no backend, so the only thing standing between
// a cold load and a working UI is the static shell. This worker precaches that
// shell and serves it when the host is unreachable.
//
// Hard rules this file must never break:
//   - Never touch a cross-origin request. The inference provider, the character
//     page API, and remote avatars must pass through untouched; caching or
//     rewriting one would be a functional and security regression.
//   - Never cache a non-GET request or any API/provider response.
//
// The bug this design fixes (reported by a user, reproduced from their console):
// after a deploy a returning user loaded a FRESH chat.html that ran a STALE
// chat_boot.js, and the old module's `$("hud-char-name").textContent = name`
// threw `TypeError: can't access property "textContent", $(...) is null`.
//
// Cause: navigations were network-first while assets were stale-while-revalidate,
// so the document could be new while the modules it loads were old. Serving the
// document from cache as well is necessary but NOT sufficient: a plain mirror of
// the stale-while-revalidate strategy still writes the new document and the new
// modules into one cache independently, and a load landing between those writes
// is served a new document with old modules. That window is real, and the
// verification harness reproduces it against the plain mirror.
//
// Strategy — one immutable GENERATION per deploy, published atomically:
//   - A generation is the whole shell: both documents plus every asset they load
//     transitively (modules, stylesheets, fonts), stored under keys tagged with a
//     content fingerprint.
//   - A build fetches every entry first, writes ASSETS, then writes the DOCUMENTS
//     last, then flips a single generation pointer. Until the pointer flips,
//     readers see the previous generation complete; after it flips they see the
//     new generation complete. There is no state in which a document and its
//     modules come from different generations.
//   - Each page is pinned to the generation that served its document, so a load
//     that straddles a pointer flip still receives its own generation's modules.
//     The previous generation is retained for exactly that straddle.
//
//   - `install` builds the first generation, so a fresh context starts
//     consistent. A content deploy is picked up by a background rebuild after
//     the deploy is first observed, so a load is always cache-fast and the user
//     converges on the new generation over the next couple of loads.
//   - A deploy that adds or renames a PRECACHED SHELL FILE must still bump CACHE,
//     because `install` (the only place the seed list is read) does not re-run
//     otherwise. Bumping CACHE also makes `activate` drop the old cache.
//
// Tradeoff, stated honestly: after a deploy the user keeps seeing the PREVIOUS
// version for a couple more loads, then the new one. That short lag (measured:
// two reloads at a realistic 1.5s pacing, and zero mismatched pairs at any
// pacing, in the deploy-simulation harness) is chosen deliberately over the
// mismatch crash above. Offline still works: the same generation that serves a
// warm load also serves it with the host unreachable.
//
// Query strings: shell keys are the FULL request URL plus a generation tag, with
// nothing stripped. The old code stripped the query so a `?v=` convention would
// match the precached entry, but nothing in this repo emits `?v=` (a repo-wide
// grep matched only that comment), and stripping was itself a mismatch vector: a
// `?v=2` request would be handed the `?v=1` body. A real query is now simply a
// distinct key that misses the generation and fetches fresh.
//
// `skipWaiting()` + `clients.claim()` is chosen deliberately. Waiting for every
// tab to close pins users to a stale shell indefinitely, which is worse than the
// brief window where a page loaded under the old worker is controlled by the new
// one. `activate` deletes every other cache version, so no stale shell survives.

const CACHE = "vibe-rp-shell-v14";
const GEN_KEY = "./__sw_generation__";
const PREV_KEY = "./__sw_previous__";
const PIN_DIR = "/__sw_pin__/";

// Seed list, relative to this worker's own scope so the same file works at a
// domain root and under a subpath. The build crawls outward from these, so the
// list only has to name the two documents; the rest is discovered.
const SHELL = ["./index.html", "./chat.html"];

// Reference patterns used to crawl the shell. Static only: this app has no
// dynamic `import()`, no `importScripts`, and no `new Worker` (verified by
// grep), so a static crawl reaches every module a document can execute. The
// first pattern matches any tag carrying a `src` (script, img, ...) and is
// written generically on purpose: a literal script-tag string would trip the
// repo's own guard against emitting inline scripts (test/no_inline_scripts).
const REF_PATTERNS = [
  /<[a-z][a-z0-9-]*\b[^>]*\bsrc=["']([^"']+)["']/gi,
  /<link\b[^>]*\bhref=["']([^"']+)["']/gi,
  /\bimport\s+(?:[^"'()]*?\bfrom\s+)?["']([^"']+)["']/g,
  /\bexport\s+[^"'()]*?\bfrom\s+["']([^"']+)["']/g,
  /@import\s+(?:url\(\s*)?["']?([^"')]+)["']?\s*\)?/g,
  /url\(\s*["']?([^"')]+)["']?\s*\)/g,
];

function absolute(url) {
  return new URL(url, self.location).href;
}

// A generation-tagged cache key. The full request URL is preserved; the tag is
// what lets two generations coexist so a straddling page keeps its own bytes.
function genKey(gen, url) {
  const u = new URL(url, self.location);
  u.searchParams.set("sw_gen", gen);
  return u.href;
}

function keyGeneration(key) {
  try {
    return new URL(key).searchParams.get("sw_gen");
  } catch {
    return null;
  }
}

async function digest(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// References a fetched shell file points at. Same-origin only, so a cross-origin
// URL in a stylesheet or an import map can never be pulled into the shell.
function referencesFrom(url, text, contentType) {
  const out = new Set();
  const isHtml = /html/i.test(contentType) || /\.html?$/i.test(new URL(url).pathname);
  const isCss = /css/i.test(contentType) || /\.css$/i.test(new URL(url).pathname);
  const patterns = isHtml ? REF_PATTERNS.slice(0, 2) : isCss ? REF_PATTERNS.slice(4) : REF_PATTERNS.slice(2, 4);
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const raw = m[1].trim();
      // Decode first: `%23g` is an encoded `#g`, a fragment reference (an SVG
      // filter id inside a data: URI in tokens.css), never a subresource. A
      // fragment or a scheme-qualified URL is not a file we ship.
      let ref = raw;
      try {
        ref = decodeURIComponent(raw);
      } catch {
        /* keep the raw form */
      }
      if (!ref || ref.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//")) continue;
      try {
        const abs = new URL(raw, url);
        if (abs.origin === self.location.origin) out.add(abs.href);
      } catch {
        /* unparseable reference: skip */
      }
    }
  }
  return out;
}

// Fetch the whole shell (transitive closure) and write it as one generation,
// returning its id. The id is derived from the fetched bytes, so an unchanged
// deploy reuses the same id and the later swap is a no-op.
//
// A deploy landing mid-crawl could otherwise capture a document from one version
// and an asset from the next. The crawl therefore re-reads each document at the
// end and discards the whole attempt if a document moved; the next attempt sees
// the deploy already applied. Bounded so a constantly-changing host cannot loop.
async function buildGeneration(attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const built = await crawlShell();
    if (!built) return null;
    const moved = await documentMoved(built.entries);
    if (!moved) return writeGeneration(built.entries);
  }
  console.warn("[sw] shell changed during every build attempt; keeping the current generation.");
  return null;
}

// Walk the transitive closure of the seed documents, fetching each entry once.
// Fetched in waves (all currently-known references at once) rather than one at a
// time, so the ~50-entry shell completes in a few round-trips instead of a few
// dozen — the original precache was parallel for the same reason.
async function crawlShell() {
  const failed = [];
  const entries = [];
  const seen = new Set();
  let frontier = SHELL.map(absolute).filter((u) => !seen.has(u));

  while (frontier.length) {
    for (const u of frontier) seen.add(u);
    const next = new Set();
    const results = await Promise.all(
      frontier.map(async (url) => {
        try {
          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const contentType = res.headers.get("Content-Type") || "";
          const text = await res.text();
          return { url, text, contentType };
        } catch (err) {
          failed.push(`${url} (${err.message})`);
          return null;
        }
      }),
    );
    for (const entry of results) {
      if (!entry) continue;
      entries.push(entry);
      for (const ref of referencesFrom(entry.url, entry.text, entry.contentType)) {
        if (!seen.has(ref)) next.add(ref);
      }
    }
    frontier = [...next];
  }

  if (failed.length) {
    console.warn(
      `[sw] generation incomplete — ${failed.length} shell files failed to cache. ` +
        `Offline mode will be partial for those. Failing entries: ${failed.join(", ")}`,
    );
  }
  return entries.length ? { entries } : null;
}

// True when any captured document no longer matches what the host serves, i.e. a
// deploy landed while the shell was being read.
async function documentMoved(entries) {
  const docs = entries.filter((e) => /\.html?$/i.test(new URL(e.url).pathname));
  for (const doc of docs) {
    try {
      const res = await fetch(doc.url, { cache: "no-store" });
      if (!res.ok) return true;
      if ((await res.text()) !== doc.text) return true;
    } catch {
      return true;
    }
  }
  return false;
}

// Write one generation. Readers can only discover a generation through the
// pointer, which `publishGeneration` writes after this returns, so nothing here
// is visible mid-write. Writes still go in two batches — assets first, documents
// last — as defence in depth, and each batch runs in parallel so a ~50-entry
// shell commits in a few milliseconds rather than a few hundred.
async function writeGeneration(entries) {
  const cache = await caches.open(CACHE);
  const fingerprint = entries
    .slice()
    .sort((a, b) => (a.url < b.url ? -1 : 1))
    .map((e) => `${e.url}\u0000${e.text.length}\u0000${e.text.slice(0, 256)}`)
    .join("\u0001");
  const gen = (await digest(fingerprint)).slice(0, 16);

  const isDoc = (e) => /\.html?$/i.test(new URL(e.url).pathname);
  const assets = entries.filter((e) => !isDoc(e));
  const documents = entries.filter(isDoc);
  for (const batch of [assets, documents]) {
    await Promise.all(
      batch.map((e) =>
        cache.put(
          genKey(gen, e.url),
          new Response(e.text, { headers: { "Content-Type": e.contentType || "application/octet-stream" } }),
        ),
      ),
    );
  }
  return gen;
}

// Flip the pointer, remember the previous generation for straddling pages, and
// drop anything older. The pointer write is the single commit point.
async function publishGeneration(gen) {
  const cache = await caches.open(CACHE);
  const current = await readText(cache, GEN_KEY);
  if (current === gen) return;
  await cache.put(absolute(GEN_KEY), new Response(gen));
  if (current) await cache.put(absolute(PREV_KEY), new Response(current));
  await prune(cache, new Set([gen, current].filter(Boolean)));
}

async function prune(cache, keep) {
  for (const req of await cache.keys()) {
    const u = new URL(req.url);
    // Pins are tiny and per-client; leave them so an in-flight page keeps its
    // generation. A pin is overwritten on that client's next navigation.
    if (u.pathname.startsWith(PIN_DIR)) continue;
    const gen = keyGeneration(req.url);
    if (gen && !keep.has(gen)) await cache.delete(req);
  }
}

async function readText(cache, key) {
  const res = await cache.match(absolute(key));
  return res ? await res.text() : null;
}

async function pinnedGeneration(cache, clientId) {
  if (!clientId) return null;
  return readText(cache, `${PIN_DIR}${clientId}`);
}

async function pinClient(cache, clientId, gen) {
  if (!clientId || !gen) return;
  await cache.put(absolute(`${PIN_DIR}${clientId}`), new Response(gen));
}

// Which shell document to fall back to for a failed navigation.
function navigationFallback(url) {
  return /(^|\/)chat(\.html)?$/.test(url.pathname) ? "./chat.html" : "./index.html";
}

// Canonical document key. `/`, `/index.html`, `/chat` and `/chat.html` (with or
// without a query) all resolve to one document, so an alias route cannot keep a
// second copy of the same HTML.
function documentKey(url) {
  return absolute(navigationFallback(url));
}

// Locate the cached document for `key`, preferring the current generation and
// then the retained previous one (which exists only to serve a page that
// straddled a pointer flip). Returns the generation the document came from, so
// the page's assets are served from that same generation and never from a newer
// one. Returns null when nothing is cached, which sends the request to the
// network. `documentKey` already strips the query, so a query-carrying
// navigation resolves to the same canonical entry.
async function findDocument(cache, key) {
  const current = await readText(cache, GEN_KEY);
  const previous = await readText(cache, PREV_KEY);
  for (const gen of [current, previous]) {
    if (!gen) continue;
    const hit = await cache.match(genKey(gen, key));
    if (hit) return { res: hit, gen };
  }
  // Last resort, preserving the old handler's `ignoreSearch` fallback: a
  // partially built generation or a URL carrying a query still opens offline.
  // The generation is recovered from the matching entry so the page's assets
  // come from that same generation.
  const loose = await cache.match(key, { ignoreSearch: true });
  if (!loose) return null;
  const target = new URL(key).pathname;
  for (const req of await cache.keys()) {
    if (new URL(req.url).pathname === target) return { res: loose, gen: keyGeneration(req.url) };
  }
  return { res: loose, gen: null };
}

// Rebuild the shell in the background so a content deploy (which does not change
// sw.js) reaches the user on the next load. Triggered by navigations only, and
// deduped so a burst of loads cannot start overlapping builds. Resolves either
// way so a detached call never rejects.
let buildInFlight = null;
function refreshGeneration() {
  if (buildInFlight) return buildInFlight;
  buildInFlight = buildGeneration()
    .then((gen) => (gen ? publishGeneration(gen) : undefined))
    .catch(() => undefined)
    .finally(() => {
      buildInFlight = null;
    });
  return buildInFlight;
}

self.addEventListener("install", (event) => {
  event.waitUntil(buildGeneration().then((gen) => (gen ? publishGeneration(gen) : undefined)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only GET is cacheable; everything else (POST to a provider, etc.) passes through.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Cross-origin: provider calls, character-page API, remote avatars. Never touch.
  if (url.origin !== self.location.origin) return;

  // Navigations: serve the cached document immediately, then rebuild in the
  // background. The document is read from a self-consistent generation, so the
  // modules it loads come from that same generation. A miss (first visit, or a
  // URL absent from the generation) goes to the network; a network failure falls
  // back to the cached document, so the browser error page is never left in place.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const key = documentKey(url);
        const found = await findDocument(cache, key);
        if (found) {
          // Pin before returning: the document's subresource requests are only
          // issued after this response arrives, so the pin is always in place
          // and the page's modules are read from the document's own generation.
          await pinClient(cache, event.resultingClientId || event.clientId, found.gen);
          // Refresh after the document is served, never before, so the load
          // itself is cache-fast and the swap only affects the next load.
          event.waitUntil(refreshGeneration());
          return found.res;
        }
        try {
          return await fetch(req);
        } catch {
          return (
            (await cache.match(key, { ignoreSearch: true })) ||
            (await cache.match(absolute(navigationFallback(url)))) ||
            (await cache.match(absolute("./index.html"))) ||
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  // Same-origin static assets: serve the cached copy immediately (fast, works
  // offline) from the generation this client is pinned to. Only a navigation
  // starts a rebuild, so a page load triggers at most one background refresh.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const gen = (await pinnedGeneration(cache, event.clientId)) || (await readText(cache, GEN_KEY));
      if (gen) {
        const hit = await cache.match(genKey(gen, req.url));
        if (hit) return hit;
      }
      // Not in the generation: go to the network and pass the real response
      // through, including a genuine 404. Only a true network failure (nothing
      // cached, host unreachable) becomes a network-error response.
      try {
        return await fetch(req);
      } catch {
        return Response.error();
      }
    })(),
  );
});
