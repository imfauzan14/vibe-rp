# ADRs

Architecture Decision Records for Vibe RP. Each record captures a decision that
a future architecture review should not re-litigate, with the reason it was
needed.

Format: `NNNN-short-slug.md`. Numbered sequentially; never renumbered.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-session-writes-via-sibling-module.md) | Session writes go through `session_state.js`, not engine statics | Accepted |
| [0002](0002-localdb-facade-two-backends.md) | `LocalDb` is a facade over injected `IdbStore` + `LocalStore` | Accepted |
| [0003](0003-text-js-leaf-module.md) | `text.js` is the dependency-free leaf for shared text rules | Accepted |
| [0004](0004-turn-machine-injected-collaborators.md) | The chat turn machine is a factory with injected collaborators | Accepted |
