# Vibe RP

Vibe RP is a browser-first roleplay client for importing character cards, managing personas and directives, and continuing local chat sessions through any OpenAI-compatible streaming API. All logic runs in the browser; the server only serves static files. No backend, no proxy, no server-side database. All persisted data lives in the browser: IndexedDB for cards and sessions, localStorage for personas, directives, and settings. The app makes no requests to any third-party service; its only outbound calls are the inference endpoint you configure and, when you import a card from a URL, the source character site.

## Features

- Character Card v1/v2/v3 import as JSON/JSONC files, plus PNG/WebP files with embedded card metadata
- User personas and craft-directive system prompts, editable in the library modal
- Local chat sessions persisted in IndexedDB; personas, directives, and settings in localStorage
- Direct browser streaming to OpenAI-compatible endpoints with prompt-cache-first context assembly
- Continuity ledger compaction: history is summarized, never silently dropped
- Stop/abort generation mid-stream, plus one-click retry when a provider returns 401, 429, or a 5xx
- Fork a conversation from any turn into a new session, leaving the original untouched
- Edit a message as a new draft: the prior text is retained on the message, never overwritten
- In-chat search (Ctrl/Cmd+F), library sort (recent or name), and tag filtering
- Context inspector sheet with a live prompt-budget meter, reply reservation, and token allocations
- Conversation export to JSON or plain text, and restore that appends to the current chat
- Undoable destructive actions in place of blocking `confirm()` dialogs
- Pure formatting pipeline for model output (markdown subset, code-block protection, em-dash suppression)

## Themes

Two themes ship, both driven by the `data-theme` attribute on `<html>` and defined entirely by the tokens in `public/design/tokens.css`:

- **Marginalia** (dark) is the default. It is expressed by the *absence* of the attribute.
- **Paper** (light) sets `data-theme="paper"`.

The choice persists in localStorage (`vibe_rp_theme`) and falls back to the operating system preference. A small pre-paint script in `index.html` applies the stored theme before first paint so there is no flash of the wrong ground.

## Quickstart

Prerequisites: [Bun](https://bun.sh/) 1.x. Node.js is not supported.

```bash
bun install
bun start        # serve.js, http://localhost:3000
```

Run the tests:

```bash
bun test test/   # 341 tests across 22 files
```

`bun run build` is a no-op; the client ships as static files.

## Configuration

Open Settings in the app and enter an OpenAI-compatible API base URL and model. Use **Fetch Models** when the provider exposes `GET /models`. The client sends streaming `POST /chat/completions` requests directly from the browser.

Default generation parameters (in `DEFAULT_SETTINGS`, `public/local_db.js`):

- `temperature: 0.95` — creative-prose sweet spot for instruct-tuned chat models
- `maxTokens: 1200` — leaves room for `<thought>` blocks plus a typical RP reply
- `maxContextTokens: 65536` — long sessions get headroom before ledger folding
- `topP`, `minP`, frequency/presence penalties are omitted from requests at their neutral defaults, so each provider applies its own defaults. Rationale comments live next to the settings in the source.

## Self-hosted endpoints

The browser calls the API endpoint directly; CORS is decided entirely by that endpoint's server, and this client adds nothing beyond the browser's own checks. Requests are plain `fetch` POSTs with `Content-Type: application/json` and (optionally) `Authorization: Bearer ...`, which triggers a CORS preflight — so the endpoint must either send permissive CORS headers (`Access-Control-Allow-Origin`, allowed methods/headers) or be reachable same-origin. `serve.js` sets no CORS headers and needs none, since the browser never calls it for generation.

- **Local backends** (Ollama, LM Studio, llama.cpp server, and similar): when the app is opened at `http://localhost:3000` or `http://127.0.0.1:3000`, many such backends commonly ship permissive CORS for local development and work out of the box.
- **Plain-IP endpoints** (`http://192.168.x.x:port`): work when the app itself is served over plain HTTP. If the app is hosted on HTTPS, the browser blocks mixed content — serve the app over HTTP too, or use an HTTPS tunnel.
- **Cloudflare Tunnels / Tailscale serve**: the tunnel presents an HTTPS endpoint, so no mixed-content issue; the tunnel host must forward or terminate with CORS headers if the backend does not send them.

If a request fails, check the browser console: CORS failures surface there, not as API errors.

## Context and cache management

The engine (`public/browser_engine.js`) assembles every request under four rules, in precedence order:

1. **Byte-stable prefix** — the system prompt is assembled once per session and reused verbatim, so the provider's prompt cache survives every turn.
2. **Append-only history** — turns are only ever appended; compaction never rewrites a message the provider has already seen.
3. **Summarize, never drop** — when the budget is exceeded, history between the pinned opening and the live tail is folded into a rolling continuity ledger carried forward across compactions. The summarizer's output budget is adaptive (bounded by the window's own headroom) so reasoning-heavy models have room to finish the extraction; a fold that is truncated or empty earns one larger retry. If the summarizer is unreachable, a deterministic extractive digest keeps a degraded, lossy condensation rather than dropping the stored transcript, which is never modified. The derived ledger is itself hard-bounded: a model that ignores the word target (or a long run of degraded folds) triggers a bounded compression pass and, failing that, a line-boundary clip that names what it omitted — the transcript remains the canonical record.
4. **Cache-aware timing** — a destructive reduction is only allowed when the suffix it would invalidate is already cheap to re-send.

Folds target ~60% of the tail budget, leaving headroom so many turns pass between compactions. `<thought>` blocks are shaken from older history with tight bounds so the re-bill stays cheap. Cache routing: `prompt_cache_key` is sent on generation requests only (when the user sets a cache key), never on one-off fold requests, which must not pay the cache-write premium.

## Routes

- `/` — character library and settings modal
- `/chat` — roleplay conversation view
- `/settings` — redirects to the library settings modal
- `/directives` — redirects to the system prompts tab
- `/personas` — redirects to the personas tab

## Project layout

```text
public/
  browser_engine.js     BrowserChatEngine: prompt assembly, context rules, compaction, SSE streaming
  session_controller.js SessionController: modal state machine, message transitions, send/stream flow (zero DOM)
  local_db.js           LocalDb: IndexedDB (cards, sessions) + localStorage (personas, directives, settings)
  safe_html.js          Canonical escapeHtml/escapeAttr: escapes & < > " ' (the single XSS fix point)
  message_format.js     Pure formatting: formatProse and formatMessages view models (zero DOM)
  card_parse.js         Character-card parsing helpers: JSONC strip, normalize, PNG/WebP chara extraction
  remote_import.js      URL import: character-page API mapping + direct card-file fetch (zero DOM)
  session_refresh.js    Keeps an imported session alive: refresh-token exchange, single-flight, proactive refresh (zero DOM)
  sw.js                 Service worker: offline shell cache (never caches cross-origin or non-GET)
  index.html            Character library shell (92 lines, markup only)
  chat.html             Conversation shell (375 lines, markup only; bootstrap is ui/chat/chat_boot.js)
  ui/                   UI modules: shared (toast, modal, tabs, confirm, dom, theme, image),
                        library (library_page/_controller/_view, character_card, detail_modal, import_flow),
                        settings/**, editors/**, and chat/** for the conversation view
  design/               Design system: DESIGN.md, tokens.css (all colour values), components.css (rp- classes)
  design/fonts/         Self-hosted design-system webfonts
  fonts/                Self-hosted prose webfonts (Newsreader, JetBrains Mono)
  icons/                PWA icons (192/512/maskable/apple-touch PNG)
  404.html              Branded not-found page, served with status 404
  manifest.webmanifest  PWA manifest
serve.js                Bun static server: SPA routing plus the security-header layer
vercel.json             Deployment config mirroring serve.js routing, rewrites, and headers
test/                   Bun test suite (18 files)
package.json            Scripts and metadata
```

## Character cards

The library accepts Character Card v1, v2, and v3 JSON/JSONC files, plus PNG and WebP files containing embedded card metadata. Card-to-preset resolution (card root, then `card.data`, then default) lives in one place: `LocalDb#presets().resolveForCard`. Imported cards, conversations, and profile images remain local to the browser.

Card URLs are accepted directly too: open **Import Card** and paste a JSON/JSONC/PNG/WebP card link or a character page URL into the URL field. The dialog handles one method at a time — choosing a file disables the URL field, and entering a URL makes the drop zone inert, each with a clear way back.

## Testing

Bun's native test runner, 341 tests across 22 files under `test/`: engine interface contract, compaction seam edges (fold headroom, boundary alignment, shake bounds, adaptive summary budget and its bounded retry), long-run compaction stress (100-fold drift, ledger hard bound, canonical-transcript preservation), large-static-preset request accounting (the full-context invariant through the real `streamTurn` seam), core hardening (null-chunk suppression, degraded-fold notices, provider errors inside a 200 SSE body), session controller behavior against injected fakes (no DOM, cancellation, rollback, message forking), local-database hardening (the v1 to v2 in-place upgrade, single-transaction card deletion, typed quota and blocked errors), preset stores, preset resolution and defaults, message formatting, universal macro substitution, adaptive context limits, the HTML-to-markup converter for imported character cards (entity decoding, attribute stripping, idempotence), remote/direct-URL card import (URL validation, API mapping, content sniffing, stripped-definition fallbacks, session token exchange and proactive refresh), module seams, and unified singleton contracts.

```bash
bun test test/
```

## Security posture

Honest summary of what this app does and does not protect against:

- **API keys live in localStorage in plaintext.** This is a deliberate trade-off for a local-first tool: there is no backend, so there is nowhere else to keep them. Anyone with script execution in the page origin, or with access to the browser profile, can read the key. Do not use this app on a shared profile with a key you cannot rotate.
- **Rendered card and model text is escaped** through `public/safe_html.js` (`escapeHtml`/`escapeAttr`), which escapes `& < > " '`. This replaced three page-local copies, one of which was quote-unsafe and caused a stored XSS. Card-supplied HTML is converted to a tag-free markup subset before rendering, so card content cannot become executable markup.
- **A Content-Security-Policy is set by the server** (`serve.js` for local dev, `vercel.json` for deployment), not by the client. See the "Security headers" section below.
- **CORS is decided by the endpoint you configure**, not by this app. The client adds no proxy and no header that would relax it.

### Security headers

`serve.js` applies these headers to every response, and `vercel.json` mirrors them for deployment:

- `Content-Security-Policy`:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https:; connect-src *; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'`
  - `script-src` is `'self'` only: there are no inline `<script>` blocks to hash. `index.html`'s pre-paint theme boot is `theme-boot.js` and `chat.html`'s bootstrap is `ui/chat/chat_boot.js`, both loaded with `<script src>`. The old SHA-256 pin on `chat.html`'s inline module drifted from the served bytes and silently killed the chat app, so the block was extracted and the hash dropped. `'unsafe-inline'` stays out of `script-src`, so an injected inline script still cannot run.
  - `style-src` needs `'unsafe-inline'` because `chat.html` uses inline `style` attributes and `404.html` has an inline `<style>` block. A runtime-computed style attribute cannot be covered by a hash.
  - `connect-src *` is required: the client talks directly to whatever endpoint the user configures, whose origin is unknown at build time.
  - `img-src` allows `data:` (locally compressed avatars) and `https:` (remote card art); plain `http:` images are excluded.
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Permissions-Policy`: denies accelerometer, camera, geolocation, gyroscope, magnetometer, microphone, payment, and USB
- `X-Frame-Options: DENY`

`serve.js` deliberately does **not** send HSTS: it is a plain-HTTP dev server and an HSTS header on localhost would poison the browser. `vercel.json` sets `Strict-Transport-Security` because deployment is HTTPS-only.


## License

MIT — Free for personal and commercial use.

See AGENTS.md for repository guidelines and architecture details.
