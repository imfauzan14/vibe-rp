# ADR-0002: `LocalDb` is a facade over two injected backends

- **Status**: Accepted
- **Date**: 2026-09-26
- **Deciders**: architecture review (`improve-codebase-architecture`), maintainer

## Context

`LocalDb` mixed three responsibilities in one 600-line class: IndexedDB access
(cards, sessions), localStorage access (personas, directives, settings), and a
static-only public surface. The statics were the only way to use it, which made
it impossible to construct a database against an injected backend — tests had
to install a fake `globalThis.indexedDB`, and the chat controller could not
receive a database instance.

A storage seam is only worth having if there is a second adapter for it. Here
there are two: the real browser backends, and the in-memory fakes the tests
need.

## Decision

`LocalDb` becomes a **facade** with two backends inside the same file:

- `IdbStore` — IndexedDB: `open`, `getAllCards`, `saveCard`, `saveSession`,
  `getSessionsForCard`, `getAllSessions`, `countSessions`, `deleteSession`,
  `deleteCard`, `clearAllSessions`, `clearAllCards`, `importRows`.
- `LocalStore` — localStorage: preset stores, settings, reset, snapshot /
  clearAll / restore.

`new LocalDb({ idb, local })` accepts injected backends; `new LocalDb()` builds
the real ones. The existing statics delegate to a private default instance, so
every existing call site is unchanged. `LocalDb.db` still proxies the default
`IdbStore` connection handle, which preserves the `LocalDb.db = null` reset
pattern the tests rely on.

## Consequences

- The chat controller can take `{ db }` and receive a fake; no browser global
  is required to exercise a full turn.
- The two backends are independently testable; the IDB transaction/scan counts
  the hardening tests assert stay meaningful.
- Existing static call sites (and their tests) are untouched, so the change is
  structural, not a migration.
- `test/local_db_seam.test.ts` proves the injected-instance path.
