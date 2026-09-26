# ADR-0001: Session writes go through a sibling accessor module

- **Status**: Accepted
- **Date**: 2026-09-26
- **Deciders**: architecture review (`improve-codebase-architecture`), maintainer

## Context

The engine folded history into the ledger and then mutated the controller's
session in place (`session.ledger = ...`, `session.lastUsage = ...`, notice
latches). The fold was a pure computation that also had a side effect, so the
"what is the new ledger" question and the "write it" question could not be
tested apart.

The obvious fix — add the write as a public static on `BrowserChatEngine` —
was blocked: `test/engine_interface.test.ts` pins the engine's public statics
exactly, and a second guard (`test/choice_ui.test.ts`) scans the
`generateChoices` slice for `session.*=` assignments, to keep choice generation
free of session mutation.

## Decision

Session writes live in **`public/session_state.js`**, a sibling module:
`applyFold`, `noteUsage`, `markLedgerTruncated`, `setOverflowReported`,
`setCondensedReported`. The engine imports them and decides *when* to call
them; the module owns *how* the session is mutated. The engine re-exports them
so callers keep a single import surface, and the pinned statics list is
unchanged.

Notice semantics are preserved deliberately: `markLedgerTruncated` writes a
plain marker without changing a transition, while the reported-latches return
`previous !== next` so a caller can tell a first report from a repeat.

## Consequences

- The fold is now pure-in / value-out; the write is a separate, testable step.
- New session-write shapes land in one module, not scattered through the engine.
- A future engine static can still be added, but session writes should not be
  the reason for one.
- `test/session_state.test.ts` covers the accessors; `test/choice_ui.test.ts`
  keeps its no-write guard on the choice path.
