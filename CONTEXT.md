# CONTEXT

The domain model for Vibe RP: the concepts that name good seams, and the
modules that own them. Architecture vocabulary (module, interface, depth, seam,
adapter, leverage, locality) is used deliberately; see `docs/adr/` for the
decisions this model encodes.

## The product

A browser-first roleplay client. The reader picks a character card, writes a
turn, and the app streams a reply from an OpenAI-compatible endpoint. All state
is local: IndexedDB for cards and sessions, localStorage for settings and
presets. There is no backend.

## Core concepts

### Card

The stored character record: `{ id, avatar?, data?: {...} }` with CCv1/v2/v3
fields either under `data` or at the root. `character_card.js` normalises that
once through `fields(card)`, so no other module repeats the fallbacks. A card
carries `name`, `description`, `personality`, `scenario`, `system_prompt`,
`mes_example`, an optional lorebook, and an optional **roster** (the ensemble
cast for multi-character play). Lorebook entries are query-gated per turn
(ranked by distinct-key hits, then priority, capped at six) and framed as
reference facts, never instructions.

### Persona

The reader's own character: `{ name, description, avatar?, template? }`. Held in
localStorage, not on the card. The persona and the **directives** (see below)
are the *operational authority* for language, register and narrative medium; the
card defines character identity. That precedence is stated in the craft contract
— one home — rather than in a separate precedence section.

The persona slot owns exactly one thing no other slot can: the reader's role and
the perspective their turn is written from. It does **not** restate agency,
perception, or the observability boundary; those are the contract's, stated once
for every character. The built-in persona is therefore unnamed and short — an
empty `name` renders as the bare `[User Persona]` label rather than inventing a
name, and the persona editor requires a name before saving so the shipped
default is the only nameless one.

### Directive

A user-authored behavioural instruction. One authoritative built-in ships and is seeded into
`vibe_rp_directives` on first read: `DEFAULT_AGENTS_CONTRACT` — an in-character author's craft contract
(voice, pacing, anti-cliché, and universal linguistic adaptation). Directives are narrative-writing prompts, never an
instruction channel for changing the repository.

The architecture is **strictly universal**: zero per-language templates and zero region-specific
special casing. The system adapts directly at the model behavior and processing level so it inherently
handles any language, dialect, or regional input without explicit per-language branches.
A seeded prompt carries `builtin: true` so the UI can show a Built-in badge and
withhold Delete, which the store would simply re-seed.

The contract is also the single home for the authority rule — which layer
governs language, register and medium, and which supplies identity. It is
stated there and nowhere else. The engine does not restate
it and does not inspect the contract's language; the `cardReading` section
carries only the one card fact the contract cannot state (a preset's dialogue
examples demonstrate personality, not the language of the scene or its canon).
The contract does not name the reader: their identity belongs to the persona
slot, so the two can never disagree.

### Session

One conversation against one card: `{ id, cardId, messages[], ledger,
lastUsage, lastUsageReport, usageHistory[], ... }`. Messages are append-only; an
edit forks a new revision with the same id and keeps the superseded text in
`msg.forks[]`.

### Usage history

What the provider actually reported, one sample per completed turn, appended to
the session and pruned per scope. A sample is only comparable with another
measured against the same **scope** — `endpoint|model|cardId|personaId|
directiveId` — because each of those independently resets a provider's cache.
The persona and the directive live on the *card*, not the session, so changing a
preset changes the prefix for every chat of that card; the history is grouped by
scope so a trend never averages across the change.

Two facts that must stay apart: an endpoint that reported no cache figure yields
`cached: null`, counted as a *gap*, while a measured miss is `cached: 0`. The
scope key is internal and never reaches a reader — the Context sheet is handed a
label the caller resolved from names.

`usage_history.js` owns the sample shape, the caps and the trend derivation;
`session_controller.js` writes the samples at the one seam every turn path takes;
`ui/chat/context_panel.js` renders them.

### Ledger

The rolling summary of history that has been folded away. It is *carried
forward* across compactions rather than recomputed, bounded by
`LEDGER_HARD_MAX_TOKENS`. Presenting it in a request costs a fixed framing
overhead — see `ledgerFramingTokens()` in `context_plan.js`.

### Choice Mode

An alternative to free-text input: after a settled turn, the app asks the model
for a small menu of next moves. A selected choice is an ordinary user message,
so Choice Mode never changes how a conversation is stored. The choice request is
non-streaming and never mutates the session.

### Turn

One user→assistant exchange. A turn has a lifecycle: start, stream chunks,
settle, and either succeed or fail. The **turn machine** (`turn_machine.js`)
owns that lifecycle; the chat page supplies the DOM objects and the paint
callbacks.

### Fold

The act of folding older history into the ledger. The engine decides *when* a
fold happens; the fold produces a value; `session_state.js` owns *how* it is
written back to the session. See ADR-0001.

## Modules and their seams

| Concept | Owning module | Interface shape |
| --- | --- | --- |
| Card normalisation | `character_card.js` | pure functions, no DOM/storage |
| Prompt assembly, context rules | `browser_engine.js` | `BrowserChatEngine`, statics |
| Token budget, allocation, framing cost | `context_plan.js` | pure functions, incl. `allocateContext` |
| Session writes (fold, usage, notices) | `session_state.js` | accessor functions |
| Usage history, cache trend | `usage_history.js` | pure functions, leaf |
| Turn lifecycle | `ui/chat/turn_machine.js` | `createTurnMachine({ collaborators })` |
| Persistence | `local_db.js` | `LocalDb` facade over `IdbStore` + `LocalStore` |
| Shared text rules | `text.js` | leaf module, no imports |
| Choice prompt + parser | `choice_format.js` | pure functions |
| Escaping | `safe_html.js` | `escapeHtml`, `escapeAttr` |

The dependency direction is one-way: UI → controller → engine/storage. The
engine, the controller and `local_db.js` are DOM-free at module scope.

## Seams that exist for a reason

- **`session_state.js`** is a seam because session writes have one owner, and
  because the engine's public statics are pinned by a test (ADR-0001).
- **`turn_machine.js`** is a seam because the turn lifecycle is page-shaped at
  its edges but pure in its middle; injecting the collaborators makes it
  testable without a browser (ADR-0004).
- **`IdbStore` / `LocalStore`** are two adapters behind the `LocalDb` facade
  because IndexedDB and localStorage are genuinely different backends, and
  because tests need to inject either without touching browser globals
  (ADR-0002).
- **`text.js`** is a leaf module so every pure module may depend on it and no
  import cycle can form through it (ADR-0003).
