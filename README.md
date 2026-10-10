# Vibe RP

**A roleplay client that runs entirely in your browser.**

Import a character card, write a turn, and read the reply stream in from any
OpenAI-compatible endpoint. No backend, no proxy, no account. The server is a
static file host, the database is your browser's, and the only network call the
app makes is the inference endpoint you configure.

Most chat interfaces are built for short exchanges, and they treat a long story
as a long chat log. This one is built the other way round. The prose is set at a
real reading measure with the chrome kept quiet enough to disappear; the context
window is treated as a budget that has to be spent deliberately rather than a
bucket that quietly fills up; and every figure the app puts on screen is one it
measured, not one it estimated and hoped you would not check.

---

## Contents

- [Why this one](#why-this-one)
- [Quickstart](#quickstart)
- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Choice Mode](#choice-mode)
- [The Context sheet](#the-context-sheet)
- [Configuration](#configuration)
- [Themes](#themes)
- [Self-hosted endpoints](#self-hosted-endpoints)
- [Routes](#routes)
- [Project layout](#project-layout)
- [Testing](#testing)
- [Security posture](#security-posture)
- [License](#license)

## Why this one

| The question | The answer |
| --- | --- |
| **Where does my data go?** | Nowhere. Cards and sessions live in IndexedDB, presets and settings in localStorage. The app's only outbound calls are the endpoint you configure and — when you import a card from a URL — that site. |
| **Will it survive a long story?** | History is summarized into a rolling continuity ledger rather than dropped, and the transcript itself is never rewritten. Edit a message and the previous text is kept on it, not overwritten. |
| **Is it costing more than it should?** | Requests are assembled cache-first: a byte-stable prefix, append-only history, and compaction timed for when it is already cheap. |
| **Can I see what it is doing?** | The [Context sheet](#the-context-sheet) breaks the next request down token by token, reports what the provider actually billed for the last reply, and charts cache reuse across recent replies. |
| **What does it look like?** | Two themes over one token set — **Marginalia**, a dark ink-room, and **Paper**, an e-ink daylight reading surface. |

## Quickstart

Prerequisites: [Bun](https://bun.sh/) 1.x. Node.js is not supported.

```bash
bun install
bun start        # serve.js, http://localhost:3000
```

Then open `http://localhost:3000`, pick a character, and add your endpoint in
Settings. `bun run build` is a no-op — the client ships as static files, so
deploying it means copying `public/` somewhere and pointing a static host at it.

```bash
bun test          # 792 tests across 36 files
bun run eval      # the prompt gates (offline, deterministic)
```

## What it does

**Getting stories in.** Character Card v1, v2 and v3 as JSON or JSONC, plus PNG
and WebP files with embedded card metadata. Cards can also be imported straight
from a URL, either a raw card file or a character-page link.

**Writing.** A composer that grows with the draft, a persona for who *you* are in
the scene, and craft directives for how the writing behaves. All three are
editable without leaving the library.

**Keeping the story.** A continuity ledger compacts older turns instead of
dropping them. Fork any turn into a new session and leave the original untouched.
Edit a message as a new draft with the previous text retained. Search the whole
transcript with <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>F</kbd>.

**Knowing what is happening.** Token counts on every message and in the composer,
live. The Context sheet, which is described [below](#the-context-sheet).

**Getting out.** A complete browser backup and restore — cards, sessions,
presets, settings and sign-in cookies — plus granular resets when you only want
to clear one kind of thing. Destructive actions are undoable rather than guarded
by a blocking `confirm()`.

**And Choice Mode**, which is different enough to get its own section: the model
proposes 3–5 next moves after each reply, and picking one is an ordinary turn.

## How it works

```text
  public/index.html ─┐                    markup, plus a thin bootstrap
  public/chat.html  ─┤
                     ▼
             public/ui/**                 DOM, rendering, user events
                     │
                     ▼
         SessionController                state, turns, Choice Mode   (zero DOM)
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
  BrowserChatEngine          LocalDb
          │                     │
          │            ┌────────┴────────┐
          │            ▼                 ▼
          │        IndexedDB        localStorage
          │     cards, sessions   presets, settings
          │
          ▼
  your OpenAI-compatible endpoint
```

The dependency direction is one-way, and the engine, the controller and the
database never touch `document` or `window`. That is not tidiness for its own
sake: it is what lets the whole turn pipeline run in a test with no browser.

Four rules govern how every request is assembled, in precedence order.

| Rule | In practice |
| --- | --- |
| **1. Byte-stable prefix** | The system prompt is assembled once per session and reused verbatim, so the provider's prompt cache survives every turn. |
| **2. Append-only history** | Turns are only ever appended. Compaction never rewrites a message the provider has already seen. |
| **3. Summarize, never drop** | When the budget is exceeded, the turns between the pinned opening and the live tail fold into a rolling continuity ledger, carried forward across compactions. |
| **4. Cache-aware timing** | A destructive reduction only happens when the suffix it would invalidate is already cheap to re-send. |

<details>
<summary><b>The folding mechanics, and what happens when they go wrong</b></summary>

The summarizer's output budget is adaptive — bounded by the window's own
headroom — so reasoning-heavy models have room to finish the extraction, and a
fold that comes back truncated or empty earns one larger retry. If the summarizer
is unreachable at all, a deterministic extractive digest keeps a degraded, lossy
condensation rather than dropping anything; the stored transcript is never
modified.

The derived ledger is hard-bounded too. A model that ignores the word target, or
a long run of degraded folds, triggers a bounded compression pass and — failing
that — a line-boundary clip that names what it omitted.

Editing or deleting a message the ledger covers clears the ledger, because a
summary describing a turn the reader removed would otherwise be sent to the model
as settled canon. The transcript becomes the continuity again and a new ledger is
built from it. Deleting a message and undoing restores the ledger with it.

Folds target about 60% of the tail budget, leaving headroom so many turns pass
between compactions. `<thought>` blocks are shaken out of older history with
tight bounds so the re-bill stays cheap, and fold requests never pay a cache-write
premium.

</details>

<details>
<summary><b>Universal context allocation — why a big preset is not an error</b></summary>

The engine does not think in terms of "how much history fits in an internal
prompt budget". It builds every candidate for one request, measures it, and asks
the single allocator what the largest *valid* request is right now.

- **Required content is protected.** The craft contract, character identity (name,
  core directives, description, personality, scenario), the user persona, the
  cognitive-layer block, the current user turn, and the writing guidance are never
  dropped.
- **Optional content yields first.** Example dialogue and constant world lore are
  degradable; when the request would otherwise not fit, they go before anything
  required is touched. Examples yield before world lore.
- **The reply is a ceiling, not a reservation.** `maxTokens` is granted in full
  whenever the window leaves room for it, and reduced only to a viable floor when
  required content crowds it out.
- **History takes whatever remains**, after required content, the reply and the
  degradable sections have been fitted.
- **The final request is measured after assembly.** A derived ledger larger than
  the window is condensed for the send — the stored ledger and the transcript are
  untouched — rather than being sent over-window. Nothing is appended after
  allocation.
- **Only a genuinely impossible request is impossible.** If the required content
  plus a minimum reply cannot fit, the request is still sent and you are told,
  naming the component crowding the window out.

A large preset consumes real context and reduces history. That is a budgeting
condition, not a failure. A small preset leaves room for more history, and a
larger configured window buys more usable content. There is no hardcoded "64K
mode".

</details>

## Choice Mode

Choice Mode changes *how you pick the next turn*, never how the conversation is
stored or generated. It is a mode, not a second engine.

```text
assistant reply
  → 3–5 generated choices
  → you pick one (or type your own)
  → that text becomes an ordinary user turn
  → the existing pipeline runs unchanged
  → a fresh reply, then fresh choices
```

- **One transcript.** A selected choice is appended as a normal `user` message.
  History, compaction, export, search, fork and the context allocator treat it
  exactly like typed text. Choices are never stored as messages and never enter
  the RP prompt.
- **Auxiliary generation.** Choices come from a separate, non-streaming request
  that uses the smallest sufficient context — the instruction, a clipped ledger
  hint, and the recent tail. It never sends the full preset or the whole history,
  so a large preset cannot make it fragile. A choice failure leaves the reply
  intact and offers Retry.
- **The RP prompt is byte-identical** whether Choice Mode is on or off.
- **A state machine, not booleans.** `idle → generating → ready → submitting`,
  with error and cancellation paths. A set is tied to the assistant message it
  came from and is discarded when that scene changes: a new turn, reroll, edit,
  delete, fork, session switch, or restore. A double click can only ever append
  one turn and start one generation.
- **Persisted, not re-fetched.** Reopening a chat restores valid pending choices
  with no extra API call.
- **The escape hatch.** **Other…** reveals and focuses the normal composer.

## The Context sheet

Every other panel in the app shows you the story. This one shows you the request.

It breaks the next message down token by token — what is required, what is
degradable, what the history is taking, what has been reserved for the reply —
and then reports what your provider actually billed for the last one.

The cache figure is the interesting part, because on its own it is meaningless:
the first reply after anything changes is cold by definition, so a single number
cannot tell a prompt that is never reused from one that was rebuilt a moment ago.
It is therefore drawn as a trend over recent replies — and that trend is **scoped
to the setup that produced it**: endpoint, model, card, persona and system prompt.
Change any of those and the next reply starts cold, so samples from one setup are
counted and set aside rather than averaged into another. A provider that reports
no cache figure at all produces a *gap* in the series, never a zero. "Nothing was
reported" and "nothing was reused" are different facts, and the sheet says which
one it has.

## Configuration

Open Settings and enter an OpenAI-compatible base URL and model. Use **Fetch
Models** when the provider exposes `GET /models`. The client sends streaming
`POST /chat/completions` requests straight from the browser.

| Setting | Default | Why |
| --- | --- | --- |
| `temperature` | `0.95` | The creative-prose sweet spot for instruct-tuned chat models. |
| `maxTokens` | `1200` | Room for a `<thought>` block plus a typical reply. |
| `maxContextTokens` | `65536` | Long sessions get headroom before folding starts. |
| `topP`, `minP`, penalties | *omitted* | Left out of the request at their neutral values so each provider applies its own default. |

Every parameter applies to the next request the moment the control settles —
there is no separate save step. The reply ceiling is a reservation taken out of
the window before history is sized, and the context budget *is* the window, so
both change what the next turn can carry.

## Themes

Two themes ship, both driven by the `data-theme` attribute on `<html>` and defined
entirely by the tokens in `public/design/tokens.css`.

| Theme | Selector | Character |
| --- | --- | --- |
| **Marginalia** | `:root` — the attribute is *absent* | A dark ink-room. The default. |
| **Paper** | `data-theme="paper"` | E-ink daylight. The sunken reading ground flattens to hairline and type, and the grain does the work shadow does in the dark. |

The choice persists in localStorage (`vibe_rp_theme`) and falls back to the
operating system preference. `theme-boot.js` loads ahead of the app modules and
applies the stored theme before first paint, so there is no flash of the wrong
ground.

## Self-hosted endpoints

The browser calls your endpoint directly, so CORS is decided entirely by that
endpoint's server. Requests are plain `fetch` POSTs with
`Content-Type: application/json` and, optionally, `Authorization: Bearer …`,
which triggers a CORS preflight. The endpoint must either send permissive CORS
headers or be reachable same-origin. `serve.js` sets no CORS headers and needs
none, because the browser never calls it for generation.

| Endpoint | What to expect |
| --- | --- |
| **Local backends** — Ollama, LM Studio, llama.cpp server | With the app on `http://localhost:3000`, most ship permissive CORS for local development and work out of the box. |
| **Plain-IP endpoints** — `http://192.168.x.x:port` | Work when the app is served over plain HTTP too. If the app is on HTTPS the browser blocks mixed content: serve it over HTTP, or use a tunnel. |
| **Cloudflare Tunnel, Tailscale serve** | The tunnel presents HTTPS, so no mixed-content problem. The tunnel host must forward or terminate with CORS headers if the backend does not send them. |

If a request fails, look at the browser console. CORS failures surface there, not
as API errors.

## Routes

| Route | What it is |
| --- | --- |
| `/` | The character library, and the settings modal |
| `/chat` | A roleplay conversation |
| `/settings` | Redirects into the library's settings modal |
| `/directives` | Redirects to the system prompts tab |
| `/personas` | Redirects to the personas tab |

## Project layout

Everything under `public/` is a plain ES module with no bundler. The engine, the
controller, the database and the planning modules never touch `document` or
`window`, which is what lets a whole turn run in a test with no browser.

```text
public/
  browser_engine.js     Prompt assembly, the four context rules, SSE streaming
  context_plan.js       Pure planning: token estimation, budgets, the allocator
  session_controller.js State, message transitions, send/stream flow (zero DOM)
  session_state.js      The session-write seam: engine decides when, this owns how
  usage_history.js      Per-chat usage history: the scope key and the cache trend
  local_db.js           IndexedDB (cards, sessions) + localStorage (presets, settings)
  safe_html.js          The one escaper: escapeHtml, escapeAttr (all five of & < > " ')
  text.js               The dependency-free leaf for shared text rules
  message_format.js     Pure formatProse and formatMessages view models (zero DOM)
  choice_format.js      The Choice Mode prompt and the parser for model output
  card_parse.js         Card parsing: JSONC strip, normalize, PNG/WebP chara
  remote_import.js      URL import: character-page mapping, direct card fetch
  session_refresh.js    Keeps an imported session alive: refresh-token exchange
  sw.js                 Service worker: offline shell cache (cross-origin excluded)
  index.html            Character library shell (91 lines, markup only)
  chat.html             Conversation shell (188 lines, boot is ui/chat/chat_boot.js)
  ui/                   UI modules: shared, library, settings/**, editors/**, chat/**
  design/               Design system: DESIGN.md, tokens.css, components.css
  design/fonts/         Self-hosted design-system webfonts
  fonts/                Self-hosted prose webfonts (Newsreader, JetBrains Mono)
  icons/                PWA icons (192/512/maskable/apple-touch PNG)
  404.html              Branded not-found page, served with status 404
  manifest.webmanifest  PWA manifest
tools/                  prompt_eval.mjs (bun run eval) and story_eval.mjs
docs/                   adr/ (decision records) and witness_mode_design.md
serve.js                Bun static server: SPA routing plus security headers
vercel.json             Deployment config mirroring serve.js routing and headers
test/                   Bun test suite (36 files)
package.json            Scripts and metadata
```

## Testing

Bun's native test runner, 792 tests across 36 files under `test/` (11,700 assertions).

```bash
bun test test/
```

<details>
<summary><b>What the suite covers</b></summary>

| Concern | What it pins down |
| --- | --- |
| Context and allocation | No false overflow for a request that fits; the defined order in which static sections degrade; the final request measured after assembly; provider context-overflow adaptation; randomized allocator properties; 500- and 1000-turn long runs. |
| Compaction | Fold headroom and boundary alignment; the idempotent thought-shake; the adaptive summary budget and its bounded retry; 100-fold drift; the ledger's hard bound; the canonical transcript preserved. |
| Provider telemetry | Usage reconciliation; the learned per-request overhead and its median guard; capability persistence across reloads; the learned context window; cache-breakpoint placement. |
| The engine's contract | `describeRequest()` matching what is actually sent; the wire body's keys; the pinned public static surface. |
| The chat surface | The turn lifecycle against collaborator fakes; the single reduced-motion-aware scroll path; search reading the transcript rather than the rendered window; the settle order that lets a reply be announced. |
| The Context sheet | The breakdown matching the payload; the cache row reporting a measurement rather than a guess; empty rows omitted; the trend scoped to one setup while counting the rest. |
| The usage history | One sample per completed turn under the prefix it was sent under; an unreported reply kept as a gap rather than a miss; per-scope pruning that cannot let one preset evict another's history. |
| Persistence | The v1→v2 in-place upgrade; single-transaction card deletion; typed quota and blocked errors; the injected-backend seam. |
| Import | The HTML-to-markup converter; remote and direct-URL card import; JWT decode, expiry skew, rotation, single-flight. |
| Presentation guards | Phone-width layout; one settings surface for both pages; no inline scripts; one `escapeHtml`. |
| Accessibility and hardening | The announcement order; the editor error alert; the gated sample seeding; the 404 belonging to the token set. |

</details>

## Security posture

An honest summary of what this app does and does not protect against.

- **API keys live in localStorage in plaintext.** That is a deliberate trade-off
  for a local-first tool: there is no backend, so there is nowhere else to keep
  them. Anyone with script execution in the page origin, or access to the browser
  profile, can read the key. Do not use this on a shared profile with a key you
  cannot rotate.
- **Rendered card and model text is escaped** through `public/safe_html.js`,
  which escapes `& < > " '`. This replaced three page-local copies, one of which
  was quote-unsafe and caused a stored XSS. Card-supplied HTML is converted to a
  tag-free markup subset before rendering, so card content cannot become
  executable markup.
- **The Content-Security-Policy is set by the server**, not the client.
- **CORS is decided by the endpoint you configure**, not by this app. There is no
  proxy and no header that would relax it.

<details>
<summary><b>The security headers, and why each one is there</b></summary>

`serve.js` applies these to every response, and `vercel.json` mirrors them for
deployment.

```
Content-Security-Policy:
  default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  font-src 'self'; img-src 'self' data: https:; connect-src *;
  object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: denies accelerometer, camera, geolocation, gyroscope,
                    magnetometer, microphone, payment, and USB
X-Frame-Options: DENY
```

- `script-src` is `'self'` only, and there are no inline `<script>` blocks to
  hash. `index.html`'s pre-paint theme boot is `theme-boot.js` and `chat.html`'s
  bootstrap is `ui/chat/chat_boot.js`, both loaded with `<script src>`. The old
  SHA-256 pin on `chat.html`'s inline module drifted from the served bytes and
  silently killed the chat app, so the block was extracted and the hash dropped.
  `'unsafe-inline'` stays out of `script-src`, so an injected inline script still
  cannot run.
- `style-src` needs `'unsafe-inline'` because `chat.html` uses inline `style`
  attributes and `404.html` has an inline `<style>` block. A runtime-computed
  style attribute cannot be covered by a hash.
- `connect-src *` is required: the client talks directly to whatever endpoint you
  configure, whose origin is unknown at build time.
- `img-src` allows `data:` for locally compressed avatars and `https:` for remote
  card art. Plain `http:` images are excluded.
- `serve.js` deliberately does **not** send HSTS — it is a plain-HTTP dev server,
  and an HSTS header on localhost would poison the browser. `vercel.json` sets
  `Strict-Transport-Security`, because deployment is HTTPS-only.

</details>

## What this is not

- **Not a hosted service.** No account, no sync. Two browsers are two separate
  libraries.
- **Not a proxy.** Requests go from your browser to your endpoint. Nothing sits in
  between.
- **Not a model.** Bring your own endpoint and key.
- **Not multi-user.** One browser profile, one library.

## License

MIT — free for personal and commercial use.

See [AGENTS.md](AGENTS.md) for repository guidelines and
[CONTEXT.md](CONTEXT.md) for the domain model.
