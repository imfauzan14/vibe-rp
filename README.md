# Vibe RP

**A local-first roleplay client for long-form interactive fiction — running entirely in your browser.**

Import a character card, write a turn, and stream replies directly from any OpenAI-compatible API or local model server. There is no backend proxy, no account, and no telemetry. The server is a static file host, your library lives in your browser's storage (`IndexedDB` and `localStorage`), and the only network requests the app makes go directly to the inference endpoint you configure.

Most chat interfaces are built for short Q&A exchanges and treat a long story as a disposable chat log that eventually truncates. Vibe RP is built around long-form narrative continuity:
- **Editorial reading surface**: Prose is set at a comfortable reading measure in two purpose-built themes (**Marginalia** dark ink-room and **Paper** daylight e-ink), with UI chrome kept quiet until needed.
- **Deliberate context budgeting**: Every request is planned through a single context allocator that protects character identity and active scene guidance, gates world lore by relevance, and folds older turns into a structured continuity ledger instead of dropping them.
- **Automatic multilingual adaptation**: Works out of the box across any language. Whether you play a non-English preset with the default settings or bring your own non-English persona/turns to an English card, the engine adapts narration, dialogue, and Choice Mode to your active language automatically.

---

## Contents

- [At a Glance](#at-a-glance)
- [Quickstart](#quickstart)
- [User Guide](#user-guide)
  - [1. Connecting an Endpoint](#1-connecting-an-endpoint)
  - [2. Importing Character Cards](#2-importing-character-cards)
  - [3. Personas, Directives & Language Adaptation](#3-personas-directives--language-adaptation)
  - [4. Writing, Editing, Forking & Search](#4-writing-editing-forking--search)
  - [5. Choice Mode](#5-choice-mode)
  - [6. The Context Sheet](#6-the-context-sheet)
  - [7. Backups & Data Management](#7-backups--data-management)
- [How the Engine Works](#how-the-engine-works)
  - [Architecture & Data Flow](#architecture--data-flow)
  - [Four-Rule Context Management](#four-rule-context-management)
  - [Universal Context Allocation](#universal-context-allocation)
  - [Rolling Continuity Ledger](#rolling-continuity-ledger)
  - [Adaptive Scene Guidance](#adaptive-scene-guidance)
  - [Cost Efficiency & Prompt Caching](#cost-efficiency--prompt-caching)
- [Configuration Reference](#configuration-reference)
- [Themes](#themes)
- [Self-Hosted & Local Endpoints (CORS)](#self-hosted--local-endpoints-cors)
- [Routes](#routes)
- [Project Layout](#project-layout)
- [Testing & Verification](#testing--verification)
- [Security Posture](#security-posture)
- [License](#license)

---

## At a Glance

| Question | Answer |
| --- | --- |
| **Where does my data live?** | Locally in your browser. Character cards and chat sessions are stored in `IndexedDB`; personas, system directives, and settings live in `localStorage`. |
| **Does it work in any language?** | Yes. The built-in craft directive, default persona, and adaptive turn guidance automatically follow the language of your turns, your custom Persona/Directives, or the character preset's scene — with zero manual prompt editing required. |
| **How does it handle long stories?** | Older turns are summarized into a structured `[Cast]` / `[State]` / `[Threads]` / `[Timeline]` continuity ledger rather than dropped. If the summarizer is unreachable, a deterministic extractive digest preserves continuity until the next fold. |
| **How does it keep API costs low?** | Requests use a byte-stable system prefix, append-only message history, 4-breakpoint `cache_control` markers for providers that support explicit caching, `reasoning_effort: "low"` on auxiliary calls, and compaction timed only when the uncached tail is worth folding. |
| **Can I inspect what is sent to the model?** | Yes. The **Context** sheet breaks down the next request token by token (system prefix, persona, dynamic lore, ledger, history, reply ceiling) and tracks actual provider-billed usage and prompt-cache hit rates. |
| **What happens if a request fails mid-turn?** | Your turn is never lost. Failed generations roll back only the empty assistant placeholder and leave a durable **Retry reply** button on your turn that survives page reloads. |

---

## Quickstart

**Prerequisites**: [Bun](https://bun.sh/) 1.x (Node.js is not supported).

```bash
bun install
bun start        # starts serve.js at http://localhost:3000
```

Open `http://localhost:3000` in your browser, open **Settings**, configure your API endpoint and model, and pick or import a character card.

Because the app is a zero-build static SPA (`bun run build` is a no-op), deploying it to production simply means serving `public/` on any static host (such as Vercel, Cloudflare Pages, or a local web server).

```bash
bun test          # run the full test suite (858 tests across 38 files)
bun run eval      # run the offline deterministic prompt & token budget evaluator
```

---

## User Guide

### 1. Connecting an Endpoint

Open **Settings → Engine** from either the library or an active chat:

1. **API Endpoint**: Enter any OpenAI-compatible base URL (for example `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, `https://api.deepseek.com/v1`, or a local server like `http://localhost:11434/v1` for Ollama or `http://localhost:1234/v1` for LM Studio).
2. **API Key**: Enter your provider key (stored locally in `localStorage`; leave blank for local servers that do not require authentication).
3. **Model**: Type the model ID directly or click **Fetch Models** when your provider exposes `GET /models`.

All parameter changes apply immediately to the next turn with no separate save step.

### 2. Importing Character Cards

From the character library (`/`), click **Import** to add characters from:
- **Images with embedded metadata**: Character Card `.png` and `.webp` files (`chara` chunk).
- **JSON / JSONC files**: Character Card v1, v2, and v3 specifications.
- **Direct URLs**: Paste a link to a raw card file or supported character page.

Cards support full **Lorebooks / Character Books** (both constant world lore and keyword-triggered dynamic lore) as well as **multi-character ensemble casts** (`extensions.group.members` / `characters` / `cast`).

### 3. Personas, Directives & Language Adaptation

Vibe RP cleanly separates three narrative layers so you can mix and match any persona with any character card:

| Layer | What it controls | Where to edit |
| --- | --- | --- |
| **System Directive** (`agentsContract`) | Narrative craft, agency boundaries (`{{user}}` is never spoken or decided for), physical causality, pacing, and continuity rules. | **Settings → Directives** |
| **Character Card** | Who `{{char}}` is (`description`, `personality`, `scenario`, `first_mes`, example dialogue, and lorebook). | **Library → Card Details** |
| **User Persona** | Who `{{user}}` is in the story (name, observable presence, role, and narrative perspective). | **Settings → Personas** |

**Automatic Cross-Lingual & Preset Adaptation**:
- If you import a character preset written in Indonesian, Japanese, Spanish, or any other language and use the built-in default directive and persona, the model automatically writes in the preset's scene language.
- If you play an English character preset using a Persona, System Directive, or user turn written in another language (such as Indonesian), the engine detects the cross-lingual shift and instructs the model at both the system prefix and the generation tail to write `{{char}}`'s entire reply (narration and dialogue) in your active language. Once the assistant switches languages, the extra tail reminder automatically turns off to save tokens.

### 4. Writing, Editing, Forking & Search

- **Live token estimates**: Both the message composer and every turn in the feed display live token estimates (`~bytes/4` with CJK script awareness).
- **Non-destructive editing**: Editing a message creates a new revision in place while preserving previous drafts in `msg.forks[]`, which you can cycle through at any time.
- **Rerolling & Continuing**: Regenerate the latest assistant turn or prompt the character to continue from the last beat.
- **Forking a session**: Branch the story from any turn into an independent session without altering the original timeline.
- **Full-transcript search**: Press <kbd>Ctrl</kbd>+<kbd>F</kbd> (or <kbd>Cmd</kbd>+<kbd>F</kbd>) inside a chat to search across the entire session transcript, including messages outside the currently rendered viewport.

### 5. Choice Mode

Toggle **Choice Mode** in the composer bar when you want the model to propose **3–5 distinct next actions or dialogue beats** after each character reply:

```text
Assistant reply completes
  → Auxiliary request generates 3–5 grounded player choices
  → Pick a choice (or click "Other…" to type your own turn)
  → Selected choice is sent as a normal user message
  → Standard roleplay pipeline streams the next reply
```

- **Optional Steering**: Before generating or refreshing choices, you can type a brief direction into the steer field (e.g., *"ask about the locked drawer"* or *"refuse politely and leave"*) to focus the generated options.
- **Zero transcript pollution**: Generated choice menus are never injected into the roleplay prompt. Selecting a choice submits its prose as an ordinary `user` turn, keeping the main RP prompt 100% cache-compatible.
- **Lightweight auxiliary call**: Choice generation sends only a compact context slice (character/persona summary, clipped ledger hint, and recent turns) with a tight output budget (`768` tokens) and `reasoning_effort: "low"` so it returns quickly and cheaply even on 10K-token cards.
- **Persisted across reloads**: Active choices are saved with the session in `IndexedDB` and restored without re-fetching when you reopen the chat.

### 6. The Context Sheet

Click the **Context** button in the chat header to inspect the exact structure and token cost of your session:

- **Next Request Breakdown**: Shows the exact token allocation for the upcoming turn across **Required Static** (directive + core character fields), **Optional Static** (example dialogue + constant lore), **Persona**, **Dynamic Lore & Guidance**, **Continuity Ledger**, **Conversation History**, **Current Input**, and **Reserved Reply Ceiling**.
- **Provider Telemetry & Cache Trend**: Displays what your API provider actually billed on the last turn (`prompt_tokens`, `completion_tokens`, and cached tokens) alongside a multi-turn **Cache Reuse Trend**.
- **Setup-Scoped History**: Because changing the model, card, persona, or system directive naturally invalidates the prompt prefix on the next turn, cache hit trends are scoped to the specific setup that produced them, and providers that do not report cache metrics are shown as a gap rather than a false `0%`.

### 7. Backups & Data Management

Under **Settings → Data**, you can:
- **Export a full backup**: Downloads a single JSON snapshot of all cards, sessions, personas, directives, and settings. *(Note: Full backups include your API keys and session tokens in plaintext — treat exported backup files as secrets.)*
- **Restore from backup**: Safely imports a snapshot, filtering strictly on the app's storage namespace (`vibe_rp_*`).
- **Granular resets**: Clear only chat sessions, reset personas/directives to defaults, or wipe all local data. Destructive actions in the UI provide an undo toast rather than blocking browser alerts.

---

## How the Engine Works

### Architecture & Data Flow

```text
  public/index.html ─┐                    HTML shells (markup + thin bootstrap)
  public/chat.html  ─┤
                     ▼
             public/ui/**                 DOM rendering, modals, events
                     │
                     ▼
         SessionController                Turn lifecycle, state, Choice Mode (zero DOM)
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
  BrowserChatEngine          LocalDb
   (context_plan.js,          (IdbStore + LocalStore)
    prompt_adaptive.js,         │
    model_capability.js)  ┌─────┴──────────┐
          │               ▼                ▼
          │           IndexedDB       localStorage
          │        cards, sessions  presets, settings
          ▼
  OpenAI-compatible endpoint (SSE stream)
```

All core modules (`BrowserChatEngine`, `SessionController`, `LocalDb`, `context_plan.js`, `prompt_adaptive.js`, `session_state.js`, `usage_history.js`, `choice_format.js`) are completely DOM-free (`document` and `window` are never referenced at module scope), allowing the entire turn, compaction, and allocation pipeline to be tested deterministically in Bun.

### Four-Rule Context Management

Every roleplay request is assembled according to four rules in strict precedence order:

| Rule | How it works |
| --- | --- |
| **1. Byte-stable prefix** | `formatSystemPrompt` builds the system prompt (`messages[0]`) once per session setup and reuses it verbatim on every turn, maximizing provider prompt-cache hits. |
| **2. Append-only history** | Completed turns are never mutated in place. `<think>` / `<thought>` blocks are stripped from older history within a deterministic window so the message prefix stays stable. |
| **3. Summarize, never drop** | When history exceeds the available tail budget, turns between the pinned opening scene and the live recency tail fold into a structured continuity ledger (`<ledger>…</ledger>`). |
| **4. Cache-aware timing** | Compaction triggers only when history overflows the budget, and folds target ~60% of the tail budget so many turns can pass before the next fold is needed. |

### Universal Context Allocation

Rather than using arbitrary per-section token caps, `planRequest` measures every candidate section and runs a single allocator (`allocateContext` in `public/context_plan.js`):

1. **Required content is protected**: The craft directive, core character identity (`name`, `system_prompt`, `description`, `personality`, `scenario`), user persona, cognitive-layer framing, current user turn, and active scene guidance are never dropped.
2. **Degradable static content yields under pressure**: If the configured context window is tight, example dialogue (`mes_example`) yields first, followed by ensemble cast details and constant world lore.
3. **Output ceiling adapts**: `maxTokens` is granted in full whenever room allows and scales down to a viable floor (`256` tokens) only when required content crowds the window.
4. **History and dynamic lore take the remaining budget**: Keyword-matched lorebook entries are ranked by distinct key hits against the current turn, recent tail, and stored ledger (capped at 6 entries per turn), and conversation history fills the remaining capacity.
5. **Post-assembly verification & overflow recovery**: If a provider rejects a request because its actual context limit is smaller than `maxContextTokens`, the engine parses the provider's error, learns the true window in `model_capability.js`, and automatically re-plans and retries the turn once.

### Rolling Continuity Ledger

When compaction runs, `BrowserChatEngine` summarizes evicted turns into four fixed markdown sections:
- `[Cast]` — Who is present, their core disposition, and how recent events have shifted their state or trust.
- `[State]` — Current physical location, time/weather, injuries, inventory, and immediate physical posture.
- `[Threads]` — Unresolved promises, secrets, suspicions, and active objectives.
- `[Timeline]` — Causal sequence of key beats already settled in canon.

If the LLM summarizer returns a truncated/empty response, the engine retries once with a larger output allowance; if the endpoint is unreachable, it falls back to a deterministic extractive digest so turns are never silently lost. Editing or deleting a message already covered by the ledger automatically resets the ledger (with undo support on message deletion) so deleted events are never fed back as canon.

### Adaptive Scene Guidance

On every turn, `public/prompt_adaptive.js` runs zero-cost local heuristics over the recent transcript (`analyzeTurnState` + `buildSceneGuidance`) and injects a compact `[Writing Guidance]` block (`~60–180` tokens) at the end of the prompt:

- **Turn Scope & Epistemic Boundary**: Anchors the reply to `{{char}}` in `{{user}}`'s active language, opening directly on `{{char}}`'s response and bounding perception strictly to what `{{char}}` can see or hear from their current physical position.
- **Persona Core vs. Earned State (`reinject`)**: Periodically reminds the model of `{{char}}`'s core traits while allowing their emotional state and trust to evolve from story events.
- **Narrative Lock (`lock`)**: Detects the established POV (`first`, `second`, or `third` person) and tense (`past` or `present`) after 2+ turns and locks them in.
- **Cross-Lingual Adaptation (`languageShift`)**: Fires automatically whenever a non-English turn, Persona, Directive, or preset scene meets an English greeting or reply, and turns off once the model is replying in the target language.
- **Prose Tic & Echo Suppression**: Detects repetitive paragraph openings, stock phrase clusters, monologue bloat, dialogue-less turns, trailing questions to the player, or player-voice bleed (`puppet`), emitting targeted corrections sorted by recency priority.

### Cost Efficiency & Prompt Caching

- **4-Breakpoint Rolling Cache**: For endpoints supporting explicit cache control (Anthropic, OpenRouter), `applyCacheControl` places up to 4 `cache_control: { type: "ephemeral" }` breakpoints across: (1) the static system prompt, (2) the folded continuity ledger, (3) a quantized 6-message stepping boundary in warm history, and (4) the penultimate turn.
- **Reasoning Budget Caps on Auxiliary Calls**: Background summarization, ledger compression, and Choice Mode requests pass `reasoning_effort: "low"` (stripped automatically if a provider rejects the field, and remembered in `model_capability.js`), preventing reasoning models from burning thousands of hidden thinking tokens on background tasks.

---

## Configuration Reference

| Setting | Default | Description |
| --- | --- | --- |
| `apiEndpoint` | `""` | Base URL for any OpenAI-compatible API (`/chat/completions`). |
| `apiKey` | `""` | Bearer token sent in the `Authorization` header (stored locally). |
| `model` | `""` | Model identifier sent in the request payload. |
| `temperature` | `0.95` | Sampling temperature for main roleplay turns (`0.3` is used for summaries, `0.8` for Choice Mode). |
| `maxTokens` | `1200` | Maximum completion tokens reserved for each roleplay reply. |
| `maxContextTokens` | `65536` | Total context window budget (`input + maxTokens`) planned by the allocator. |
| `topP`, `minP`, penalties | *omitted* | Sent only when moved off their neutral defaults so providers use their native defaults. |

---

## Themes

Both themes are defined entirely via CSS custom properties in `public/design/tokens.css` and verified for WCAG contrast by `test/contrast_audit.test.ts`:

| Theme | Attribute on `<html>` | Visual Character |
| --- | --- | --- |
| **Marginalia** *(default)* | *(absent)* | Warm dark ink-room designed for low-glare evening reading. |
| **Paper** | `data-theme="paper"` | Daylight e-ink surface with crisp hairline borders and subtle paper grain. |

`public/theme-boot.js` applies your saved preference (`vibe_rp_theme`) or OS dark/light preference before first paint to prevent theme flashes.

---

## Self-Hosted & Local Endpoints (CORS)

Because Vibe RP streams directly from your browser to your inference server without a backend proxy, the endpoint must allow browser requests via CORS (`Access-Control-Allow-Origin`):

| Setup | Notes |
| --- | --- |
| **Ollama / LM Studio / llama.cpp** | Work out of the box when running Vibe RP locally (`http://localhost:3000`) with default local CORS settings enabled. |
| **LAN IP (`http://192.168.x.x:port`)** | Works when Vibe RP is also accessed over HTTP. If Vibe RP is hosted on HTTPS, browsers block plain-HTTP LAN calls as mixed content — run Vibe RP locally or expose the endpoint via HTTPS. |
| **Cloudflare Tunnel / Tailscale Serve** | Provides an HTTPS endpoint; ensure CORS headers are forwarded by the tunnel or backend. |

---

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Character library, card import, and settings modal |
| `/chat` | Active roleplay conversation, Choice Mode, and Context sheet |
| `/settings` | Opens the library directly to the Settings modal |
| `/directives` | Opens the library directly to the System Directives tab |
| `/personas` | Opens the library directly to the Personas tab |

---

## Project Layout

All frontend code under `public/` uses standard ES modules with zero bundling required.

```text
public/
  browser_engine.js     Prompt assembly, four context rules, SSE streaming, ledger folding
  context_plan.js       Pure context planning: token estimation, budgets, allocateContext()
  prompt_adaptive.js    Adaptive turn analysis, prose tic detection, buildSceneGuidance()
  model_capability.js   Learned provider capabilities, context limits, and token overhead
  session_controller.js Session lifecycle, turn state machine, Choice Mode (zero DOM)
  session_state.js      Session mutation seam (ledger folds, resets, undo snapshots, usage)
  usage_history.js      Setup-scoped usage telemetry and prompt-cache trend calculation
  local_db.js           Persistence facade: IdbStore (cards, sessions) + LocalStore (settings)
  safe_html.js          Single HTML/attribute escaper (escapeHtml, escapeAttr for & < > " ')
  text.js               Cycle-free text utilities, macro substitution, delimiter neutralization
  message_format.js     Pure prose formatting view models (formatProse, formatMessages)
  choice_format.js      Choice Mode system/task prompts and resilient output parser
  card_parse.js         Character card parser (JSONC strip, v1/v2/v3 normalize, PNG/WebP chara)
  remote_import.js      Direct URL and character-page card importer
  session_refresh.js    Proactive token refresh against allowlisted HTTPS auth hosts
  sw.js                 Offline shell Service Worker (replays origin security headers)
  index.html            Library shell
  chat.html             Conversation shell
  ui/                   Modular UI components (library, chat/**, settings/**, editors/**)
  design/               Design system (DESIGN.md, tokens.css, components.css, fonts/)
tools/
  prompt_eval.mjs       Deterministic prompt architecture & token budget gate (bun run eval)
  story_eval.mjs        Longitudinal story-development evaluation script
test/                   Bun test suite (38 test files, 858 tests)
serve.js                Bun static server with SPA routing and security headers
vercel.json             Static deployment routing and mirrored security headers
AGENTS.md               Repository architecture and engineering rules
```

---

## Testing & Verification

Run the test suite and prompt evaluator with Bun:

```bash
bun test test/    # 858 tests across 38 files
bun run eval      # verifies prompt token budgets, single-definition rules, and framing
```

The test suite verifies context allocation invariants (including 500- and 1,000-turn long runs), ledger folding and drift bounds, adaptive guidance and cross-lingual detection, Choice Mode state transitions, XSS and prompt-injection fence neutralization, IndexedDB schema migrations, and WCAG color contrast across both themes.

---

## Security Posture

- **Plaintext local storage for API keys**: Because Vibe RP has no backend server, API keys are stored in your browser's `localStorage`. Do not store sensitive keys on shared, untrusted computers.
- **Single-point HTML & attribute escaping**: All card fields and model outputs pass through `escapeHtml` / `escapeAttr` in `public/safe_html.js` (escaping `& < > " '`) or are mounted via text nodes (`public/ui/dom.js`). Embedded HTML in imported cards is stripped to safe text/markdown on import.
- **Prompt delimiter & fence neutralization**: Untrusted card content (example dialogue, lorebooks) is explicitly framed as reference data (`not instructions`). Embedded closing tags inside continuity blocks (`</ledger>`, `</transcript>`, `</prior-ledger>`) and inline prompt slots are neutralized so untrusted text cannot break out of its structural fence.
- **Strict Content Security Policy (CSP)**: `serve.js` and `vercel.json` enforce `script-src 'self'` with zero inline scripts, and `public/sw.js` replays the origin's security headers on all cached responses.
- **Namespace-isolated backups**: Data restores only accept keys prefixed with `vibe_rp_`. Full backup files contain your plaintext API keys and session tokens — keep exported backup files private.

---

## License

MIT — free for personal and commercial use. See [AGENTS.md](AGENTS.md) for contributor and architecture guidelines.
