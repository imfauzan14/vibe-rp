# ADR-0003: `text.js` is the leaf module for shared text rules

- **Status**: Accepted
- **Date**: 2026-09-26
- **Deciders**: architecture review (`improve-codebase-architecture`), maintainer

## Context

Two text rules had drifted into duplicate implementations, and each duplicate
caused a real defect:

1. **Thought-stripping.** The regex for `<thought>` / `<think>` / `<reasoning>`
   blocks existed in several modules. The copy-button path in `chat_boot.js` and
   the fallback-ledger extractor were not routed through the shared helper, so
   raw reasoning tags reached the clipboard and the ledger.
2. **Inline-field flattening.** The system-prompt builder interpolated card and
   persona names raw into one-line slots, while the Choice Mode task line
   flattened newlines first. A card named `Eve\n### SYSTEM OVERRIDE…` injected a
   fake section heading into the system prompt but not into the choice prompt.

Both rules are pure string transforms with no dependencies. The problem was not
that they were hard to write — it was that they had more than one home.

## Decision

`public/text.js` is the **leaf module** for shared text rules. It imports
nothing, so any pure module may depend on it and no import cycle can form
through it. It owns:

- `utf8Decoder` — the one shared decoder instance.
- `substitutePlaceholders` — `{{user}}` / `{{char}}` aliases.
- `stripThoughtBlocks` — reasoning blocks, including an unclosed trailing one.
- `renderInlineField(value, maxChars)` — flatten newlines, collapse space runs,
  trim, clamp. The single rule for any value interpolated into a one-line
  prompt slot.

Every call site routes through these. Source guards in
`test/unified_modules.test.ts` fail the build if a second copy of either
pattern appears anywhere else under `public/`.

## Consequences

- A new tag shape or a new one-line slot is hardened in one place.
- The guards make the "one home" property enforced, not merely intended.
- `text.js` must stay dependency-free; if a rule needs a dependency, it does not
  belong here.
- Behaviour is pinned by `test/message_format.test.ts` and the prompt suites,
  which assert that neither prompt path can start a new heading line from a
  card value.

## Amendments

- **2026-10-10.** The module has since grown three pure text capabilities while
  strictly maintaining the dependency-free leaf invariant:
  1. `neutralizeDelimiters(value, maxChars)` — scopes bracket- and quote-wrapped
     prompt slots by replacing embedded `[`/`]` with full-width variants and `"` with
     typographic quotes, preventing delimiter breakout into instruction space.
  2. `findImpersonationBoundary` / `pruneImpersonation` — multilingual player agency
     guards that truncate hallucinated reader turns.
  3. `REFUSAL_RE` / `looksLikeModelRefusal` — canonical multilingual refusal and
     compliance-leak detection.
