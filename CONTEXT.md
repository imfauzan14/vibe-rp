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
cast for multi-character play).

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

A user-authored behavioural instruction. Two built-ins ship and are seeded into
`vibe_rp_directives` on first read: `DEFAULT_AGENTS_CONTRACT` and its Indonesian
sibling `DEFAULT_AGENTS_CONTRACT_ID` — an in-character author's craft contract
(voice, pacing, anti-cliché). Directives are narrative-writing prompts, never an
instruction channel for changing the repository.

The pair is **alternative, never additive**: exactly one contract is in any
payload, selected by the resolved directive for the card. `builtins()` on the
preset descriptor returns both; `defaultFactory()` still returns the single
default, because "the default preset" must stay a single object everywhere else.
A seeded prompt carries `builtin: true` so the UI can show a Built-in badge and
withhold Delete, which the store would simply re-seed.

The contract is also the single home for the authority rule — which layer
governs language, register and medium, and which supplies identity. It is
stated there and nowhere else; the `operationalPrecedence` section carries only
the consequence the contract cannot state, because it depends on what language
a particular card was written in. The contract does not name the reader: their
identity belongs to the persona slot, so the two can never disagree.

The Indonesian contract states its rules **in Indonesian**, and that is the
mechanism, not a translation convenience: output language tracks the language of
the instruction text far more than any single sentence inside it, so writing the
rules in the target language makes the medium self-evident instead of argued
for. It may use prohibitions where the English contract uses positive framing,
because in Indonesian the prohibition is the natural normative form. Its
register rules come from measured corpus frequency rather than taste.

### Session

One conversation against one card: `{ id, cardId, messages[], ledger,
lastUsage, ... }`. Messages are append-only; an edit forks a new revision with
the same id and keeps the superseded text in `msg.forks[]`.

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
| Token budget, allocation, framing cost | `context_plan.js` | pure functions |
| Session writes (fold, usage, notices) | `session_state.js` | accessor functions |
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
