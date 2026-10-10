# ADR-0004: The chat turn machine is a factory with injected collaborators

- **Status**: Accepted
- **Date**: 2026-09-26
- **Deciders**: architecture review (`improve-codebase-architecture`), maintainer

## Context

`chat_boot.js` is the chat page's composition root, but it also owned the turn
lifecycle inline: `streamTurn`, `submitTurn`, `rerollLastTurn`,
`retryUnansweredTurn`, `stopTurn`, failure classification, chunk piping,
scroll pinning and the Choice Mode side effects. The lifecycle was the most
consequential logic on the page and the least testable, because it was tangled
with DOM objects at module scope.

## Decision

The lifecycle lives in **`public/ui/chat/turn_machine.js`** as
`createTurnMachine({ controller, composer, feed, notifier, showToast,
isNearBottom, scrollFeed, requestAnimationFrame, matchFinePointer,
clearComposerInput, onSettled, onChoiceTurnFailed, onChoiceTurnSettled,
isChoiceMode, onFinally })`, returning
`{ streamTurn, submitTurn, rerollLastTurn, retryUnansweredTurn, stopTurn,
describeFailure, busy }`.

The split is deliberate: **the machine decides when, the page decides what to
paint.** The two shapes that are genuinely page-shaped — repainting the feed
after a settle, and the Choice Mode repaint/refresh — are injected callbacks,
not imports. The machine has no `document` or `window` at module scope. The
boot keeps the stable call sites (`streamTurn`, `submitTurn`, …) as delegating
consts so the existing wiring and its source guards keep working.

## Consequences

- The turn lifecycle is testable without a browser:
  `test/turn_machine.test.ts` drives settle, chunk piping, stop silence, the
  failure toast and all four entries against collaborator fakes.
- `chat_boot.js` moves toward composition only.
- New page-specific paint behaviour is added as a callback at the composition
  root, not by growing the machine.
- The source guards in `test/choice_ui.test.ts` were retargeted to read
  `turn_machine.js` for the bodies that moved there; guards follow the code.
