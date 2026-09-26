# Repository Guidelines

## Project Overview

Vibe RP is a browser-first roleplay client for interactive fiction and character-based conversations. It is a client-side SPA that streams directly to LLM APIs without a backend proxy, using IndexedDB and localStorage for all persistence.

**Core Pattern**: Zero-backend architecture. All logic runs in the browser, all data stays local. The server (`serve.js`) is static file hosting with SPA routing plus a security-header layer.

**Craft Directive System**: Characters can define their own personas and behavioral directives. The default directive (`DEFAULT_AGENTS_CONTRACT` in `public/local_db.js`) is an in-character author's craft contract (voice, pacing, anti-cliche rules). It is a narrative-writing prompt, not an instruction channel for changing this repository. Do not conflate the two.

**Security posture**: API keys are stored in localStorage in plaintext by design, because a local-first tool has nowhere else to put them. All rendered card and model text passes through `public/safe_html.js`. A Content-Security-Policy is set by the server, never by the client.

## Architecture & Data Flow

```
HTML shells (public/index.html, public/chat.html)
    ↓  import
UI modules (public/ui/**) — DOM, rendering, user events
    ↓  call
SessionController (public/session_controller.js) — state + orchestration, zero DOM
    ↓  call
BrowserChatEngine (public/browser_engine.js)   LocalDb (public/local_db.js)
    ↓                                              ↓
Direct API streaming (any OpenAI-compatible endpoint)   IndexedDB + localStorage
```

The dependency direction is one-way: UI modules depend on controllers, controllers depend on the engine and database, and the engine and database depend on nothing above them. Nothing in `browser_engine.js`, `session_controller.js`, or `local_db.js` may reference `document` or `window` at module scope.

### Key Modules

Top-level logic (all zero DOM unless noted):

- **`public/browser_engine.js`** (~2150 lines): `BrowserChatEngine`. Prompt assembly, the four context rules, ledger folding, SSE streaming, the universal allocator, and auxiliary choice generation. Re-exports the pure planning helpers from `context_plan.js` and the session-write accessors from `session_state.js` so callers keep one import surface.
- **`public/context_plan.js`** (~205 lines): pure planning. Token estimation, `cleanPromptText`, the summary budgets, and `allocateContext`. Owns the ledger-framing cost (`LEDGER_OPEN`/`LEDGER_CLOSE`, `ledgerFramingTokens()`) so every charge site reads one value.
- **`public/session_state.js`** (~60 lines): the session-write seam (`applyFold`, `noteUsage`, `markLedgerTruncated`, `setOverflowReported`, `setCondensedReported`). The engine decides *when*; this module owns *how* the controller's session is mutated, so the fold returns a value and one place applies it.
- **`public/session_controller.js`** (~745 lines): `SessionController`. Session lifecycle, modal state machine, message transitions, send/stream flow, retry of an unanswered turn, and the Choice Mode state machine. Accepts `options.signal` and exposes `cancel()`.
- **`public/local_db.js`** (~760 lines): `LocalDb` plus its two backends. `IdbStore` owns IndexedDB (cards, sessions); `LocalStore` owns localStorage (personas, directives, settings). `LocalDb` is a facade: an instance drives its own stores and accepts injected ones, while the statics delegate to a default instance. `DB_VERSION` is 2.
- **`public/text.js`** (~60 lines): the cycle-free leaf every other pure module may import. `utf8Decoder`, `substitutePlaceholders`, `stripThoughtBlocks`, `renderInlineField`.
- **`public/safe_html.js`** (~40 lines): `escapeHtml` and `escapeAttr`. The single escaping point for the whole app.
- **`public/message_format.js`** (~160 lines): pure `formatProse` and `formatMessages` view models.
- **`public/choice_format.js`** (~265 lines): the Choice Mode prompt and the resilient parser for untrusted model output (zero DOM).
- **`public/card_parse.js`** (284 lines): character-card parsing (JSONC strip, normalize, PNG/WebP `chara` extraction).
- **`public/remote_import.js`** (266 lines): URL import, character-page API mapping, direct card-file fetch.
- **`public/session_refresh.js`** (336 lines): refresh-token exchange, single-flight, proactive refresh.
- **`public/sw.js`** (436 lines): offline shell cache. Never caches cross-origin or non-GET requests.

Page shells (markup plus a thin bootstrap only):

- **`public/index.html`** (92 lines): character library shell. Imports `ui/library_page.js`.
- **`public/chat.html`** (184 lines): conversation shell. Loads `ui/chat/chat_boot.js` with `<script src>`.

Shared UI modules (**`public/ui/`**, 30 modules, ~7000 lines). Reuse these instead of re-implementing:

- Shared: `dom.js`, `toast.js`, `modal.js`, `tabs.js`, `confirm.js`, `theme.js`, `image.js`, `data_transfer.js`
- Library: `library_page.js`, `library_controller.js`, `library_view.js`, `character_card.js`, `detail_modal.js`, `import_flow.js`
- Library subfolders: `settings/**` (modal, persona/directive lists, params, engine, and data panels), `editors/**` (persona and directive editors)
- Chat: `ui/chat/**` — `message_feed.js`, `composer.js`, `choice_panel.js`, `search.js`, `turn_machine.js`, and the `chat_boot.js` composition root. The turn lifecycle (start, chunk piping, settle, stop, failure classification, retry) lives in `turn_machine.js` as `createTurnMachine({ controller, composer, feed, ... })`; the boot supplies the DOM objects and the callbacks that paint. It has no `document`/`window` at module scope.
- Both pages mount the SAME settings surface: `ui/settings/settings_modal.js` (plus `ui/editors/**` and `ui/settings/data_panel.js`). There is no chat-only settings panel; the library-only session-import block is rendered only when the caller passes `saveSession`.
- Chat: `ui/chat/**` (feed, composer, search, confirm)
- Both pages mount the SAME settings surface: `ui/settings/settings_modal.js` (plus `ui/editors/**` and `ui/settings/data_panel.js`). There is no chat-only settings panel; the library-only session-import block is rendered only when the caller passes `saveSession`.

Design system (**`public/design/`**): `DESIGN.md` (the contract), `tokens.css` (every colour value), `components.css` (the `rp-` classes), `fonts/`.

### Four-Rule Context Management

The engine enforces cache-friendly context assembly:

1. **Byte-stable prefix**: system prompt assembled once per session, reused verbatim for prompt-cache hits
2. **Append-only history**: no message rewrites. An edit forks a new revision with the same id; the superseded text is retained in `msg.forks[]`
3. **Summarize, never drop**: rolling ledger via LLM summary, or a deterministic extractive digest when the summarizer is unreachable
4. **Cache-aware timing**: compaction only when the suffix it invalidates is already cheap to re-send

### Universal Context Allocation

One allocator (`allocateContext` in `browser_engine.js`) owns the whole request
budget. `planRequest` builds every candidate, classifies it, measures it, runs
the allocation, plans history against the granted capacity, assembles the
payload, and measures the *final* request. `streamTurn` calls `planRequest` to
send; `describeRequest` calls it to power the context inspector, so the two can
never disagree.

Content is classified by semantics, not by an arbitrary number:

- **Required**: craft contract, character name/core directives/description/personality/scenario, user persona, cognitive-layer block, the current user turn, writing guidance. Never dropped.
- **Degradable**: example dialogue and constant world lore. Removed only when the request would otherwise not fit; examples yield before world lore.
- **Dynamic**: history, which takes whatever capacity remains after required content, the reply and the degradable sections.
- **Output**: `maxTokens` is a ceiling granted in full whenever room allows, reduced to a viable floor only under pressure.

A derived ledger larger than the window is condensed *for the send* (stored
ledger and transcript untouched). A request is reported as impossible only when
the measured request actually exceeds the window. The `promptBudget` field of
`resolveBudgets` is an internal planning figure; it is never the validity test.

Every request the engine sends obeys `input + max_tokens <= the window it was
planned against`, folds and ledger compression included. The prior ledger a fold
carries is clipped to fit (`fitFoldLedgerTokens`), because the *stored* ledger is
bounded by `LEDGER_HARD_MAX_TOKENS` rather than by the window; a compression
request that could never fit is skipped rather than sent and rejected.

## Failure Recovery

A failed generation rolls back only the assistant placeholder. The user's turn
is canonical, already durable, and already sent, so it is kept: `send()` leaves
it in place and `retryLastTurn()` re-streams that same turn through the ordinary
pipeline. The chat page exposes this durably as a "Retry reply" action on a
trailing unanswered user turn, so recovery survives an expired toast and a
reload. A new turn supersedes any turn still in flight, so two generations never
run concurrently.

- **`public/`**: All frontend code, served statically
- **`public/ui/`**: UI modules. The only place DOM work belongs
- **`public/design/`**: Design system. `tokens.css` owns every colour value
- **`test/`**: Bun test suite (`*.test.ts`)
- **`CONTEXT.md`**: the domain model — core concepts and the modules/seams that own them. Read this before an architecture change.
- **`docs/adr/`**: Architecture Decision Records. Read before proposing a refactor that touches a recorded seam.
- **`serve.js`**: Dev server, SPA routing, security headers
- **`vercel.json`**: Deployment routing, rewrites, and headers

## Development Commands

```bash
bun install      # install dependencies
bun start        # dev server on port 3000
bun test test/   # run the suite
bun run build    # no-op, static deployment
```

**Requirements**: Bun 1.x (developed on 1.4.0). Node.js is not supported.

## Architectural Rules (MUST follow)

These rules exist because breaking them has already caused defects. Treat them as hard constraints, not preferences.

### Escaping

- **Import `escapeHtml` and `escapeAttr` from `public/safe_html.js`. NEVER define a page-local or module-local HTML escaper.**
- `safe_html.js` escapes all five of `& < > " '`. A copy that escapes only `& < >` is quote-unsafe and enables a stored XSS when a card field containing a quote lands in an attribute. That defect is why this rule exists.
- Prefer building DOM through `public/ui/dom.js` (`el(tag, { text })`) so untrusted text becomes a text node and can never become markup. Only pass `html` for markup you constructed yourself.

### Shared modules over page-local logic

- **Use the `public/ui/` shared modules instead of duplicating logic in a page.**
- Page shells (`index.html`, `chat.html`) hold markup and a thin bootstrap. Any real behavior belongs in a `public/ui/**` module.
- If you need behavior that exists only in a page, extract it to `public/ui/` and import it. Do not add a second copy.
- Unified single implementations: `ui/theme.js` and `ui/toast.js` are shared across both library and chat surfaces.

### Controllers stay DOM-free and injectable

- `BrowserChatEngine`, `SessionController`, and `LocalDb` must not touch `document` or `window`.
- Constructors take their dependencies (`db`, `engine`) as options so tests can inject fakes. Keep it that way.
- Anything that renders, focuses, or reads layout belongs in a `public/ui/**` module, never in a controller.

### One home per rule

These rules exist because each one has already drifted and produced a defect:

- **A cost that is charged in more than one place is derived in one place.** The ledger-framing charge (`LEDGER_FRAMING_TOKENS` from `ledgerFramingTokens()` in `context_plan.js`) was once `+40` at two sites and `+88` at another, a silent 48-token disagreement per fold. Every charge site now reads the one value.
- **A transform applied to untrusted text is defined once.** `stripThoughtBlocks` (reasoning tags) and `renderInlineField` (newline flattening for one-line prompt slots) both live in `text.js`, the cycle-free leaf. Both exist because a second copy let `<think>` reach the clipboard, or let a card name open a fake section heading in the system prompt while the choice path stayed clean.
- **A session write has one owner.** The engine decides *when* a fold or a notice applies; `session_state.js` owns *how* the controller's session is mutated. Do not assign `session.ledger`/`session.usage`-style fields from engine code.
- **A page-shaped callback is injected, not imported.** When a controller-adjacent module needs the DOM, it takes a callback (`onSettled`, `scrollFeed`, `matchFinePointer`) rather than reaching for `document`. `turn_machine.js` is the worked example.

### Styling contract

- **The `rp-` prefixed classes are the only styling contract.** Style through those classes.
- **Use design tokens only. No literal colour values outside `public/design/tokens.css`.** `components.css` and page CSS must reference `var(--...)`.
- Themes swap by the `data-theme` attribute on `<html>`. `marginalia` (dark) is the absence of the attribute; `paper` sets `data-theme="paper"`. Never hard-code a colour that only works in one theme.
- New styling goes in `public/design/components.css` (shared) or the page's own stylesheet (`ui/library.css`, `ui/chat/chat.css`).
- The legacy `public/editorial.css` was deleted; do not re-add a monolithic page stylesheet.

## Code Conventions & Common Patterns

### Naming

- **Files**: `lowercase_with_underscores.js`
- **Classes**: PascalCase (`BrowserChatEngine`, `LocalDb`)
- **Functions**: camelCase
- **Constants**: UPPER_SNAKE_CASE

### Module System

- **Type**: ESM (`import`/`export`)
- **Browser modules**: plain `.js`, no bundler
- **Tests**: TypeScript (`.test.ts`) using Bun types

### Error Handling

Try-catch with graceful fallbacks:

```javascript
try {
  summary = await llmSummarize(messages);
} catch (err) {
  console.warn("LLM summary failed, falling back to extractive", err);
  summary = extractiveDigest(messages);
}
```

Typed storage errors from `local_db.js` are meant to be caught and reported: `LocalDbQuotaError` (`code: "QUOTA_EXCEEDED"`) and `LocalDbBlockedError` (`code: "BLOCKED"`).

### Common Patterns

- **IndexedDB access**: always via `LocalDb`, never direct
- **Streaming**: fetch SSE endpoints, parse chunks incrementally. A provider error inside a 200 response body throws rather than being silently rendered
- **Notices**: stream notices (for example a degraded fold) travel on `onNotice(text)`, never as a null chunk
- **Settings**: stored in localStorage, loaded on page init
- **Character data**: stored in IndexedDB, includes persona, directives, and examples

## Important Files

### Entry Points

- **`public/index.html`**: character library (landing page)
- **`public/chat.html`**: chat interface
- **`public/ui/library_page.js`**: library bootstrap
- **`public/ui/chat/chat_boot.js`**: chat bootstrap (imports `ui/chat/**` and the shared core modules)

### Core Modules

- **`public/browser_engine.js`**: prompt assembly, context management, streaming
- **`public/session_controller.js`**: session state, turn flow, cancellation, forking
- **`public/local_db.js`**: persistence (IndexedDB + localStorage)
- **`public/safe_html.js`**: the one escaper

### Configuration

- **`package.json`**: dependencies, scripts, ESM flag
- **`serve.js`**: dev server, SPA routing, `SECURITY_HEADERS`
- **`vercel.json`**: deployment routing, rewrites, and the mirrored headers

## Runtime/Tooling Preferences

- **Runtime**: Bun 1.x required (not Node.js)
- **Package manager**: Bun (no lock files committed)
- **Linting/Formatting**: none configured, manual style consistency
- **TypeScript**: types installed for editor support, no `tsconfig`, no compilation

**Philosophy**: minimal tooling, fast iteration, manual quality control.

## Testing & QA

### Framework

Bun Test (native, import from `bun:test`).

### Location

`test/*.test.ts`

### Running Tests

```bash
bun test test/
```

### Test Patterns

- **Structure**: `describe()` blocks with numbered `test()` cases
- **Assertions**: `expect().toBe()`, `.toContain()`, `.not.toContain()`, `.toBeDefined()`, `.toBeGreaterThanOrEqual()`
- **Coverage**: not configured

### Stats

568 tests, 10775 expect() calls, 29 files (measured with `bun test test/`).

### Existing Test Files

- `test/card_parse.test.ts`: HTML-to-markup converter (entity decoding, attribute stripping, idempotence)
- `test/choice_format.test.ts`: the Choice Mode parser (malformed/aliased/line-list output, sanitation, dedupe, clamping) and the auxiliary choice request planner
- `test/choice_mode.test.ts`: the choice state machine (double-click, staleness, scene-awaiting-player guard, failure recovery, persistence without a refetch)
- `test/choice_ui.test.ts`: presentation guards (real buttons, text-not-markup, durable retry affordance, the engine choice seam stays non-streaming and transcript-free)
- `test/compaction.test.ts`: long-run compaction, adaptive summary budget, and fold boundary/stress invariants
- `test/context.test.ts`: context planning, allocation, Inspector alignment, large presets, and seams
- `test/context_longrun.test.ts`: long-run context compaction monotonicity
- `test/context_property.test.ts`: randomized allocator properties and invariants through the engine seam
- `test/core_hardening.test.ts`: null-chunk suppression, degraded-fold notices, provider errors in a 200 body
- `test/data_management.test.ts`: export/import lifecycle, persona/directive data operations
- `test/detail_modal_close.test.ts`: detail modal close behavior and cleanup
- `test/engine_interface.test.ts`: engine interface contract
- `test/library_card_actions.test.ts`: library card interactions and action dispatch
- `test/local_db_hardening.test.ts`: v1 to v2 upgrade, transactional delete, typed errors
- `test/message_format.test.ts`: formatting
- `test/modal_dismissal.test.ts`: backdrop and keyboard dismissal contracts
- `test/no_inline_scripts.test.ts`: CSP script-src verification (no inline scripts)
- `test/presets_resolution.test.ts`: settings resolution
- `test/presets_store.test.ts`: preset stores
- `test/remote_import.test.ts`: URL import against a mocked `globalThis.fetch`
- `test/responsive_layout.test.ts`: phone-width CSS guards (library filter bar stays inline, preset-row badge atomicity, message speaker truncation)
- `test/session_controller.test.ts`: controller behavior against injected fakes (no DOM)
- `test/session_refresh.test.ts`: JWT decode, expiry skew, rotation, single-flight, no token leak
- `test/settings_unification.test.ts`: one settings surface for both pages (shared modal import, cache-key read/write, session-import gating, no chat-only panel or markup)
- `test/stream_robustness.test.ts`: the OpenAI-compatible streaming contract (delta/message content, `data:` framing, non-streaming bodies, max_tokens forwarding)
- `test/unified_modules.test.ts`: single escapeHtml/toast/theme/thought-strip/field-render implementations, sw.js shell hygiene
- `test/turn_machine.test.ts`: the chat turn lifecycle against collaborator fakes (chunk piping, settle, stop silence, failure toast, all four entries)
- `test/local_db_seam.test.ts`: the LocalDb instance seam (injected IDB/local backends, default-instance delegation)
- `test/session_state.test.ts`: the session-write accessors (fold application, usage, notice latches)

### When to Add Tests

- New context management logic (cache stability, summarization)
- Settings resolution changes
- Prompt assembly modifications
- Message handling edge cases (cancellation, rollback, forking)
- Anything touching escaping or storage migrations

Skip tests for:

- UI layout changes
- Static content updates
- One-off scripts
