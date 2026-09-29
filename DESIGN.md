# Design system

`public/design/tokens.css` cites this file for its contrast verification. It did
not exist, so the claim was unverifiable from the repository — this is that
artifact, with the numbers re-derived from the tokens themselves.

**Regenerate the numbers with**
`bun run .workbuddy-ai/analysis/contrast_audit.mjs`
It reads the token blocks out of `tokens.css`, computes the WCAG 2.2 ratio for
every pair the components actually render, and reports a pass or fail against the
right minimum for each. Do not edit the tables below by hand.

---

## The shape of it

**One token set, two themes.** Every value a component may use lives in
`tokens.css`. `components.css` contains no literal colour. A theme swaps by an
attribute on `<html>` and nothing else changes:

| Theme | Selector | Character |
| --- | --- | --- |
| Marginalia | `:root` (the default) | a dark ink-room; the attribute is *absent* |
| Paper | `[data-theme="paper"]` | e-ink daylight |

`theme-boot.js` applies the stored theme before first paint, so there is no flash
of the wrong ground. `ui/theme.js` owns the same contract at runtime.

**Three layers, in load order:**

```
design/tokens.css        values only
design/components.css    every shared component
page composition layer   chat.css, library.css — layout for one surface
```

A page rule may compose tokens; it may not introduce a colour.

**Two faces, one interface face.** Newsreader for prose, Source Sans 3 for
interface copy, JetBrains Mono for figures. All self-hosted — no third-party
requests, which is why the app works offline.

---

## Measured contrast (WCAG 2.2, sRGB relative luminance)

Minimums: **4.5:1** body text, **3:1** large text and non-text UI (control
outlines, the focus indicator).

### Marginalia

| Pair | Ratio | Need | Used for |
| --- | --- | --- | --- |
| `--ink` on `--canvas` | 15.33 | 4.5 | body text on the page ground |
| `--ink` on `--surface` | 14.17 | 4.5 | prose in a card, sheet or dialog |
| `--ink` on `--canvas-sunken` | 15.85 | 4.5 | prose in the reading well |
| `--ink` on `--input-bg` | 13.18 | 4.5 | typed text in a field |
| `--ink-muted` on `--canvas` | 8.33 | 4.5 | secondary copy |
| `--ink-muted` on `--surface` | 7.70 | 4.5 | control labels in a dialog |
| `--ink-faint` on `--canvas` | 5.47 | 4.5 | timestamps |
| `--ink-faint` on `--surface` | 5.05 | 4.5 | metadata in a card |
| `--ink-faint` on `--input-bg` | **4.70** | 4.5 | the placeholder — the tightest pair in this theme |
| `--accent-annotation` on `--surface` | 8.70 | 4.5 | the character's name, continuity marks |
| `--accent-user` on `--surface` | 8.26 | 4.5 | the reader's own name and hand |
| `--danger` on `--surface` | 7.14 | 4.5 | danger text |
| `--danger` on `--danger-subtle` | 5.67 | 4.5 | danger on its own wash |
| `--success` on `--surface` | 8.93 | 4.5 | success text |
| `--on-danger` on `--danger` | 7.73 | 4.5 | label on a filled danger button |
| `--ink-inverse` on `--accent-annotation` | 9.03 | 4.5 | label on a filled badge |
| `--border-control` on `--input-bg` | 3.25 | 3.0 | field outline against its fill |
| `--border-control` on `--canvas` | 3.78 | 3.0 | field outline against the ground |
| `--focus-ring` on `--canvas` | 9.42 | 3.0 | focus indicator |

### Paper

| Pair | Ratio | Need | Used for |
| --- | --- | --- | --- |
| `--ink` on `--canvas` | 15.26 | 4.5 | body text on the page ground |
| `--ink` on `--surface` | 16.68 | 4.5 | prose in a card, sheet or dialog |
| `--ink` on `--canvas-sunken` | 13.82 | 4.5 | prose in the reading well |
| `--ink-muted` on `--canvas` | 7.25 | 4.5 | secondary copy |
| `--ink-faint` on `--canvas` | 5.33 | 4.5 | timestamps |
| `--ink-faint` on `--canvas-sunken` | **4.83** | 4.5 | message metadata — the tightest pair in this theme |
| `--accent-annotation` on `--surface` | 6.09 | 4.5 | the character's name |
| `--accent-user` on `--surface` | 6.50 | 4.5 | the reader's own name |
| `--danger` on `--surface` | 6.41 | 4.5 | danger text |
| `--success` on `--surface` | 6.03 | 4.5 | success text |
| `--on-danger` on `--danger` | 6.69 | 4.5 | label on a filled danger button |
| `--border-control` on `--canvas` | 3.30 | 3.0 | field outline against the ground |
| `--focus-ring` on `--canvas` | 5.94 | 3.0 | focus indicator |

**All 60 pairs pass.** The two tightest are noted above so a future change to
`--ink-faint` or `--border-control` knows exactly what it is trading against.
Paper's `--ink-faint` is deliberately darker than the dark theme's faint value:
it has to clear 4.5:1 on the reading well, which is the lowest-contrast surface it
sits on.

---

## Motion

Nothing in the system moves for decoration. Every duration answers an action, and
they are tokens rather than literals so the preference can collapse them all:

```
--dur-instant  90ms   press feedback
--dur-fast    140ms   hover, focus, colour
--dur-base    220ms   disclosure, tray, tab underline
--dur-slow    320ms   sheet and drawer travel
```

Under `prefers-reduced-motion: reduce` every duration collapses to 1ms, the
scroll behaviour returns to `auto`, and the paper grain — the one ambient effect —
is dropped rather than left as a painted layer.

**One thing the stylesheet cannot do by itself.** An explicit
`scrollIntoView({ behavior: "smooth" })` outranks a `scroll-behavior` rule, so
programmatic scrolling goes through `scrollIntoViewRespectingMotion` in
`ui/dom.js`, which resolves the preference at the call site. Every programmatic
scroll in the UI uses it; a test asserts none bypasses it.

---

## Target sizes and focus

- `--target-min` (24px) is the WCAG 2.2 AA floor and applies everywhere.
- `--tap-min` (44px) applies under `@media (pointer: coarse)`.
- Focus is defined once, in `tokens.css`: `:focus { outline: none }` with
  `:focus-visible` drawing the ring. It is never removed, only relocated.
- `scroll-padding-top` on `html` keeps a focused control clear of the sticky
  chrome.

---

## Adding to it

1. A new value goes in `tokens.css` — both themes, or a documented reason it is
   shared.
2. Run `contrast_audit.mjs`. A new pair that is not in its `PAIRS` list is not
   checked, so add it there too.
3. No literal colour in `components.css`, and none in a page stylesheet.
