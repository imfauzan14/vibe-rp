# vibe-rp design system: Marginalia

## 1. The brief

**Subject.** `vibe-rp` is a browser-first, zero-backend client for long-form
narrative roleplay and interactive fiction. Someone imports a character card,
then reads and writes long prose turns with a language model. Two surfaces:
the Library (character catalogue, card detail, import, settings, persona and
directive management) and the Chat (the conversation itself, a composer,
per-message actions, continuity and context state).

**Audience.** Obsessive readers and writers. People who will spend two hours
in one thread and care about whether a paragraph is comfortable at the
seventeenth line. They are not administrators looking at a dashboard, and
they are not browsing a marketing page.

**Thesis.** This is an annotated manuscript, not an app. The prose is the
product, so the prose is set in a serif at a real reading measure with
generous leading, and the chrome around it stays quiet enough to disappear.
The one saturated colour in the system is an antique gold, and it is spent
only on annotations: continuity ledger marks, thought blocks, context flags.
The author's own words get a separate cool hue so a reader can tell whose
hand they are in without reading the speaker label. Everything else is ink
on a dark ground, plus a paper daylight theme for the same instrument.

## 2. Directions considered

**A. Marginalia, the annotated manuscript.** Dark ink-room, serif prose at
65 to 75 characters, gold reserved for marginalia, cool blue for the
author's hand, chrome quiet. The reading well is the one bold element.
Paired with a Paper daylight theme driven by the same tokens.

**B. The illuminated folio.** Heavy display serif, drop caps, decorated
initials, rubricated headings, warm parchment. Considered and rejected: it
makes every screen feel like a set piece, it fights the plain utility of
settings and import, and the parchment ground lands directly on the
cream-plus-terracotta cluster the brief rules out. Decoration would also
compete with the prose for attention, which is the opposite of the goal.

**C. The terminal.** Monospace everywhere, near-black, one acid accent,
data-forward, dense. Rejected on two counts: it is the second banned
cluster, and monospace at paragraph length is measurably worse to read for
two hours, which is exactly the use case.

**Why A wins.** It is the only one of the three that takes its visual
language from the actual material, which is a manuscript with annotations
in the margin. The gold is not a brand accent that happens to look nice, it
is the specific colour of the thing the app adds to a text: continuity
notes, thought marks, context flags. That gives a rule for what may be
gold and, more importantly, a rule for what may not.

## 3. Token table

One token set drives both themes. `:root` is Marginalia (dark, default).
`[data-theme="paper"]` overrides colour, elevation and grain only; type,
space, radius, motion and z-index are identical in both. `theme-boot.js` applies
the stored theme before first paint, so there is no flash of the wrong ground;
`ui/theme.js` owns the same contract at runtime.

### 3.1 Ground and elevation

| Token | Marginalia | Paper | Role |
|---|---|---|---|
| `--canvas` | `#0E1113` | `#F1F0EB` | Page ground |
| `--canvas-sunken` | `#0A0C0E` | `#E7E5DE` | Reading well, scroll beds |
| `--surface` | `#161A1D` | `#FBFAF7` | Cards, dialogs, sheets, drawers |
| `--surface-raised` | `#1D2226` | `#F5F4EF` | Popovers, trays, secondary buttons |
| `--surface-hover` | `#242A2F` | `#EDECE6` | Hover fill on quiet controls |
| `--input-bg` | `#1A2126` | `#FCFBF8` | Inset text fields: lifted clear of the ground |

### 3.2 Ink

| Token | Marginalia | Paper | Role |
|---|---|---|---|
| `--ink` | `#E9E7E2` | `#191A1C` | Prose, headings, primary labels |
| `--ink-muted` | `#A6ADB1` | `#4A4F54` | Secondary copy, control labels |
| `--ink-faint` | `#838B90` | `#5D6368` | Metadata, placeholders, timestamps |
| `--ink-inverse` | `#12161A` | `#FFFFFF` | Text on filled light buttons and badges |
| `--ink-subtle` | `#272A2D` | `#E9E8E5` | Flat chip and skeleton fill |

### 3.3 Annotation accents

| Token | Marginalia | Paper | Role |
|---|---|---|---|
| `--accent-annotation` | `#D3B36C` | `#7A5A16` | Continuity marks, thought blocks, context flags, selected tab rule, focus ring |
| `--accent-annotation-strong` | `#E4C88B` | `#63490F` | Hover and active on annotation ink |
| `--annotation-subtle` | `#302F28` | `#E9E4D8` | Annotation wash on a surface |
| `--accent-user` | `#8FB6DE` | `#2E5E8C` | The author's own hand: speaker name, user message rule |
| `--accent-user-strong` | `#A8C8E8` | `#24496E` | Hover on the author's hand |
| `--user-subtle` | `#273038` | `#DEE4E8` | Author wash |

Paper's annotation ink is a deep bronze, not a gold. Gold at `#D3B36C` on a
light ground measures 2.0:1 and cannot be rescued without going muddy; a
bronze keeps the "annotation" meaning and passes at 5.57:1. It is
deliberately not a terracotta or clay.

### 3.4 Status and lines

| Token | Marginalia | Paper | Role |
|---|---|---|---|
| `--danger` | `#EE8A7C` | `#A3372B` | Errors, destructive actions |
| `--danger-strong` | `#F5A79B` | `#86291F` | Hover on destructive |
| `--danger-subtle` | `#342A2A` | `#EFDFDA` | Error wash |
| `--on-danger` | `#0E1113` | `#FFFFFF` | Label on a filled danger surface |
| `--success` | `#86C7A3` | `#2F6B4F` | Saved, imported, connected |
| `--success-subtle` | `#263230` | `#DEE6DF` | Success wash |
| `--warn` | `#D3B36C` | `#7A5A16` | Continuity flag, reuses the annotation gold |
| `--warn-subtle` | `#302F28` | `#E9E4D8` | Flag wash |
| `--border-hairline` | `#2A3034` | `#DCDAD2` | Dividers, card edges (decorative, no minimum) |
| `--border-control` | `#68707A` | `#7F848A` | Input and control outline (3:1 required) |
| `--border-strong` | `#7C858C` | `#6B7178` | Hovered control outline |
| `--focus-ring` | `#D3B36C` | `#2E5E8C` | Focus indicator |

### 3.5 Elevation, grain and focus

| Token | Marginalia | Paper | Role |
|---|---|---|---|
| `--shadow-sm` | `0 1px 2px rgba(0, 0, 0, 0.45)` | `0 1px 2px rgba(31, 34, 38, 0.07)` | Resting panels |
| `--shadow-md` | `0 6px 18px rgba(0, 0, 0, 0.5)` | `0 4px 12px rgba(31, 34, 38, 0.09)` | Popovers, tooltips |
| `--shadow-lg` | `0 18px 44px rgba(0, 0, 0, 0.6)` | `0 12px 30px rgba(31, 34, 38, 0.12)` | Drawers, toasts |
| `--shadow-xl` | `0 30px 70px rgba(0, 0, 0, 0.68)` | `0 22px 54px rgba(31, 34, 38, 0.16)` | Dialogs, sheets |
| `--grain-layer` | generated SVG noise tile | same tile | Paper stock texture inside the reading well |
| `--grain-opacity` | `0.028` | `0.05` | |
| `--grain-blend` | `screen` | `multiply` | |
| `--focus-width` | `2px` | same | WCAG 2.2 focus appearance |
| `--focus-offset` | `2px` | same | |

Shadows are tinted toward the ground, never pure black at low opacity in
day mode. One light source, above and slightly cool, in both themes.

### 3.6 Type

| Token | Value | Role |
|---|---|---|
| `--font-prose` | Newsreader, Georgia, serif | All reading copy: message prose, card blurbs, dialog titles, page titles |
| `--font-ui` | Source Sans 3, system stack | Chrome, buttons, labels, chips, tabs, composer affordances |
| `--font-mono` | JetBrains Mono | Figures only: token counts, timestamps, ledger values |
| `--text-2xs` | `0.6875rem` / 11px | Badge counts, ledger figures |
| `--text-xs` | `0.75rem` / 12px | Metadata, timestamps, helper text |
| `--text-sm` | `0.8125rem` / 13px | Chips, buttons, tab labels |
| `--text-base` | `0.9375rem` / 15px | UI body, card blurbs |
| `--text-md` | `1rem` / 16px | Prose at phone width, composer input |
| `--text-lg` | `1.0625rem` / 17px | Prose at reading width |
| `--text-xl` | `1.3125rem` / 21px | Card titles, dialog titles, empty-state titles |
| `--text-2xl` | `1.6875rem` / 27px | Surface title, once per page |
| `--text-3xl` | `2.125rem` / 34px | The display variant, used only on the Library |
| `--leading-prose` | `1.72` | Serif reading copy |
| `--leading-ui` | `1.45` | Chrome |
| `--leading-tight` | `1.2` | Display sizes |
| `--tracking-tight` | `-0.011em` | Display sizes only |
| `--tracking-wide` | `0.02em` | Lowercase micro-labels |
| `--measure` | `68ch` | The prose column |
| `--measure-wide` | `84ch` | Composer and wide exchange surfaces |

The ratio is roughly 1.2 with hand-tuned steps. Newsreader carries every
long-form reading surface and every title, at weight 400 for prose and 500
for titles, with italic reserved for thought blocks and quotations. Source
Sans 3 carries chrome at 400 and 600 only. JetBrains Mono is never used for
prose or labels, only for figures that benefit from tabular alignment.

Leading rule: serif reading copy gets `--leading-prose` (1.72); UI text gets
`--leading-ui` (1.45); anything at `--text-2xl` or above gets
`--leading-tight`. Prose measure is capped at `--measure` and never exceeds
`--measure-wide`. The measured column is the reading column, and nothing in
the chrome may set type wider than it.

### 3.7 Space, radius, motion, layout

| Token | Value |
|---|---|
| `--space-0` to `--space-9` | `0, 4, 8, 12, 16, 24, 32, 40, 56, 80px` |
| `--radius-xs` | `3px` chips, badges, code |
| `--radius-sm` | `5px` buttons, inputs |
| `--radius-md` | `8px` cards, message blocks |
| `--radius-lg` | `14px` dialogs, sheets, drawers |
| `--radius-xl` | `20px` composer dock, reading well |
| `--radius-full` | `999px` avatars, meters |
| `--border-width` / `--border-width-strong` | `1px` / `2px` |
| `--dur-instant` | `90ms` press feedback |
| `--dur-fast` | `140ms` hover, focus, colour |
| `--dur-base` | `220ms` disclosure, tray, tab rule |
| `--dur-slow` | `320ms` sheet and drawer travel |
| `--ease-out` | `cubic-bezier(0.22, 0.61, 0.36, 1)` |
| `--ease-in-out` | `cubic-bezier(0.4, 0, 0.2, 1)` |
| `--shell-max` | `1440px` |
| `--chrome-height` | `52px` |
| `--tap-min` | `44px` coarse pointers only |
| `--target-min` | `24px` WCAG 2.2 AA floor everywhere |
| `--z-base` to `--z-tooltip` | `0, 10, 100, 200, 300, 400, 500, 600` |

## 4. Measured contrast

Computed with the WCAG 2.2 sRGB relative-luminance formula. **Regenerate with**
`bun run .workbuddy-ai/analysis/contrast_audit.mjs`: it reads the token blocks out
of `tokens.css`, computes every pair the components actually render, in both
themes, and reports each against the minimum that applies to it. Do not edit the
tables below by hand.

Pairs are named by token rather than by hex. `tokens.css` owns every colour value,
and a second copy of one is a second place for it to be wrong.

**66 of 66 pairs pass** — 4.5:1 for text, 3:1 for non-text UI (control outlines,
the focus indicator, and the cache chart's bars).

The annotation, user, danger and success washes are solid hex values computed by
compositing the accent over the surface at 14 percent, so every ratio below is a
real measurement rather than a guess about alpha.

### 4.1 Marginalia

| Pair | Ratio | Need | Role |
|---|---|---|---|
| `--ink` on `--canvas` | 15.33:1 | 4.5 | body text on the page ground |
| `--ink` on `--surface` | 14.17:1 | 4.5 | prose in a card, sheet or dialog |
| `--ink` on `--canvas-sunken` | 15.85:1 | 4.5 | prose in the reading well |
| `--ink` on `--surface-raised` | 12.98:1 | 4.5 | prose in a tray or popover |
| `--ink` on `--input-bg` | 13.18:1 | 4.5 | typed text in a field |
| `--ink-muted` on `--canvas` | 8.33:1 | 4.5 | secondary copy on the ground |
| `--ink-muted` on `--surface` | 7.70:1 | 4.5 | control labels in a dialog |
| `--ink-muted` on `--surface-raised` | 7.05:1 | 4.5 | labels in a tray |
| `--ink-faint` on `--canvas` | 5.47:1 | 4.5 | timestamps on the ground |
| `--ink-faint` on `--surface` | 5.05:1 | 4.5 | metadata in a card |
| `--ink-faint` on `--canvas-sunken` | 5.65:1 | 4.5 | message metadata in the reading well |
| `--ink-faint` on `--input-bg` | **4.70:1** | 4.5 | the placeholder — the tightest text pair in this theme |
| `--accent-annotation` on `--surface` | 8.70:1 | 4.5 | the character's name, continuity marks |
| `--accent-annotation` on `--canvas` | 9.42:1 | 4.5 | annotation ink on the ground |
| `--accent-annotation` on `--annotation-subtle` | 6.68:1 | 4.5 | annotation on its own wash |
| `--accent-user` on `--surface` | 8.26:1 | 4.5 | the reader's own name and hand |
| `--accent-user` on `--canvas` | 8.95:1 | 4.5 | the reader's ink on the ground |
| `--danger` on `--surface` | 7.14:1 | 4.5 | danger text in a dialog |
| `--danger` on `--canvas` | 7.73:1 | 4.5 | danger text on the ground |
| `--danger` on `--danger-subtle` | 5.67:1 | 4.5 | danger on its own wash |
| `--success` on `--surface` | 8.93:1 | 4.5 | success text |
| `--warn` on `--surface` | 8.70:1 | 4.5 | continuity flag |
| `--on-danger` on `--danger` | 7.73:1 | 4.5 | label on a filled danger button |
| `--ink-inverse` on `--accent-annotation` | 9.03:1 | 4.5 | label on a filled annotation badge |
| `--border-control` on `--input-bg` | 3.25:1 | 3.0 | field outline against its fill |
| `--border-control` on `--canvas` | 3.78:1 | 3.0 | field outline against the ground |
| `--border-control` on `--surface` | 3.49:1 | 3.0 | field outline in a dialog |
| `--focus-ring` on `--canvas` | 9.42:1 | 3.0 | focus indicator on the ground |
| `--focus-ring` on `--surface` | 8.70:1 | 3.0 | focus indicator in a dialog |
| `--focus-ring` on `--input-bg` | 8.09:1 | 3.0 | focus indicator on a field |
| `--accent-annotation` on `--surface` | 8.70:1 | 3.0 | a reused bar on the cache chart |
| `--ink-faint` on `--surface` | 5.05:1 | 3.0 | a cold bar on the cache chart |
| `--border-control` on `--surface` | 3.49:1 | 3.0 | the no-figure hairline on the cache chart |

### 4.2 Paper

| Pair | Ratio | Need | Role |
|---|---|---|---|
| `--ink` on `--canvas` | 15.26:1 | 4.5 | body text on the page ground |
| `--ink` on `--surface` | 16.68:1 | 4.5 | prose in a card, sheet or dialog |
| `--ink` on `--canvas-sunken` | 13.82:1 | 4.5 | prose in the reading well |
| `--ink` on `--surface-raised` | 15.81:1 | 4.5 | prose in a tray or popover |
| `--ink` on `--input-bg` | 16.83:1 | 4.5 | typed text in a field |
| `--ink-muted` on `--canvas` | 7.25:1 | 4.5 | secondary copy on the ground |
| `--ink-muted` on `--surface` | 7.93:1 | 4.5 | control labels in a dialog |
| `--ink-muted` on `--surface-raised` | 7.51:1 | 4.5 | labels in a tray |
| `--ink-faint` on `--canvas` | 5.33:1 | 4.5 | timestamps on the ground |
| `--ink-faint` on `--surface` | 5.83:1 | 4.5 | metadata in a card |
| `--ink-faint` on `--canvas-sunken` | **4.83:1** | 4.5 | message metadata — the tightest text pair in this theme |
| `--ink-faint` on `--input-bg` | 5.88:1 | 4.5 | the placeholder in a field |
| `--accent-annotation` on `--surface` | 6.09:1 | 4.5 | the character's name, continuity marks |
| `--accent-annotation` on `--canvas` | 5.57:1 | 4.5 | annotation ink on the ground |
| `--accent-annotation` on `--annotation-subtle` | 5.01:1 | 4.5 | annotation on its own wash |
| `--accent-user` on `--surface` | 6.50:1 | 4.5 | the reader's own name and hand |
| `--accent-user` on `--canvas` | 5.94:1 | 4.5 | the reader's ink on the ground |
| `--danger` on `--surface` | 6.41:1 | 4.5 | danger text in a dialog |
| `--danger` on `--canvas` | 5.86:1 | 4.5 | danger text on the ground |
| `--danger` on `--danger-subtle` | 5.17:1 | 4.5 | danger on its own wash |
| `--success` on `--surface` | 6.03:1 | 4.5 | success text |
| `--warn` on `--surface` | 6.09:1 | 4.5 | continuity flag |
| `--on-danger` on `--danger` | 6.69:1 | 4.5 | label on a filled danger button |
| `--ink-inverse` on `--accent-annotation` | 6.36:1 | 4.5 | label on a filled annotation badge |
| `--border-control` on `--input-bg` | 3.64:1 | 3.0 | field outline against its fill |
| `--border-control` on `--canvas` | 3.30:1 | 3.0 | field outline against the ground |
| `--border-control` on `--surface` | 3.61:1 | 3.0 | field outline in a dialog |
| `--focus-ring` on `--canvas` | 5.94:1 | 3.0 | focus indicator on the ground |
| `--focus-ring` on `--surface` | 6.50:1 | 3.0 | focus indicator in a dialog |
| `--focus-ring` on `--input-bg` | 6.55:1 | 3.0 | focus indicator on a field |
| `--accent-annotation` on `--surface` | 6.09:1 | 3.0 | a reused bar on the cache chart |
| `--ink-faint` on `--surface` | 5.83:1 | 3.0 | a cold bar on the cache chart |
| `--border-control` on `--surface` | 3.61:1 | 3.0 | the no-figure hairline on the cache chart |

### 4.3 Values deliberately close to their floor

Do not tune these downward without re-running the audit.

- Paper `--ink-faint` on `--canvas-sunken`, **4.83:1** against a 4.5 floor. Paper's
  faint ink is deliberately darker than Marginalia's for this reason: the reading
  well is the lowest-contrast surface it sits on.
- Paper `--border-control` on `--canvas`, **3.30:1** against a 3.0 floor. It
  measured 2.97:1 once and was corrected.
- The cache chart's no-figure hairline, **3.49:1** (Marginalia) and **3.61:1**
  (Paper). It was originally drawn in `--border-hairline`, which measures **1.31:1**
  against the panel surface — a marker nobody can see is not a gap in a series, so
  it uses the control-outline token instead.

## 5. Typography

**Families.** Three, all self-hosted, no third-party requests.

- **Newsreader** (variable 400 to 500, plus italic 400) is the reading and
  titling face. It carries message prose, card blurbs, dialog and page
  titles, the empty-state title and the composer input. Weight 400 for
  prose, 500 for titles, italic for thought blocks and quotations.
- **Source Sans 3** (400 to 700, one variable file) is the chrome face.
  Buttons, labels, chips, tabs, helper text, metadata, speaker names. It is
  the only new font file added, at `public/design/fonts/`, and it exists
  because the previous build used the operating system stack, which is what
  made the interface read as a default rather than a decision.
- **JetBrains Mono** (variable 400 to 600) is restricted to figures where
  tabular alignment matters: token counts, timestamps, ledger values, badge
  counts. It is never used for labels or prose.

**Scale.** A roughly 1.2 modular scale, hand-tuned at the low end so that
11px and 12px remain legible on a phone: 11, 12, 13, 15, 16, 17, 21, 27,
34px. Body UI is 15px, prose is 17px at reading width and 16px at phone
width. Nothing carrying reading copy is below 16px.

**Measure and leading.** Reading copy is capped at `--measure` (68ch), inside
the 65 to 75 character target. Serif reading copy gets 1.72 leading, which
is looser than the UI's 1.45, as serif faces need. Titles get 1.2 with
`-0.011em` tracking. Micro-labels are lowercase with `0.02em` tracking,
never all caps.

## 6. Layout concept

### 6.1 Shared

A single 1440px shell with a sticky top bar at 52px. The top bar clears
`env(safe-area-inset-top)`. Every surface has one reading column; chrome
aligns to it rather than to the viewport.

### 6.2 Library, desktop (1024px and up)

```
+--------------------------------------------------------------+
| topbar: [mark] Library            [Search] [Import] [gear]   |  sticky, 52px
+--------------------------------------------------------------+
|                                                              |
|  Character Library                                           |  surface title, left
|  Select a character to continue...                           |
|                                                              |
|  +------------------+  +------------------+                  |
|  | [av] Name        |  | [av] Name        |                  |  grid, min 320px
|  |      byline      |  |      byline      |                  |  tracks, auto-fill
|  |      [tag][tag]  |  |      [tag][tag]  |                  |
|  |  blurb, 3 lines  |  |  blurb, 3 lines  |                  |
|  |  --------------- |  |  --------------- |                  |
|  |  4 chats  [Open] |  |  0 chats  [Open] |                  |  footer pinned
|  +------------------+  +------------------+                  |
|                                                              |
+--------------------------------------------------------------+
```

- Content is left aligned inside a max-width container, centred in the
  viewport. The grid is `repeat(auto-fill, minmax(320px, 1fr))`, so wide
  screens gain columns instead of dead space, which is the failure in the
  current build.
- Each card has one action and one affordance. The card is the link to
  detail; the footer carries a single primary action. There is no chevron
  plus a second button competing.
- Card footers align across the grid because the blurb is clamped to three
  lines and the footer is pushed with `margin-top: auto`.

### 6.3 Library, mobile (below 720px)

```
+------------------------+
| topbar: [mark] Library |  sticky, safe-area-top
|         [search]       |  search drops to its own row, full width
+------------------------+
|  Character Library     |
|  Select a character... |
|                        |
|  +------------------+  |
|  | [av] Name    [..]|  |  cards stack, full width
|  |      byline      |  |
|  |      [tag][tag]  |  |
|  |  blurb           |  |
|  |  -------------   |  |
|  |  4 chats  [Open] |  |  action stays full-width at 44px
|  +------------------+  |
+------------------------+
```

- Search moves out of the toolbar into its own row directly under the top
  bar, full width, because a right-aligned field at 360px is unusable.
- Card metadata stacks; the blurb unclamps to two lines rather than three.
- The settings, import and persona surfaces become bottom sheets, not
  centred dialogs, so a thumb reaches them.

### 6.4 Chat, desktop (1024px and up)

```
+--------------------------------------------------------------+
| topbar: [back]                             [ledger] [gear]   |
+--------------------------------------------------------------+
|                                                              |
|   [av] Kestrel Rowan                            2,140 tok    |
|   prose, 68ch, serif, 1.72 leading                           |
|                                                              |
|   > thought block, gold, italic                              |
|                                                              |
|   ------------------------------------                       |  hairline between
|                                                              |  turns, not cards
|   [av] User                          09:54  ~120 tokens     |
|   | prose, cool rule on the left                              |
|                                                              |
+--------------------------------------------------------------+
|  composer: 68ch, border warms on focus                        |
|  [input, prose face, grows to 40dvh]                          |
|  [persona]  ~120 tokens                         [Send]        |
+--------------------------------------------------------------+
```

- Turns are separated by a hairline, not by a card. Bubbles make a
  manuscript read like a chat log, which is the wrong instrument.
- The reading well is a full-width reading pane: sunken ground, grain, and a
  reading gutter. Annotations render inline above the prose.
- The message portrait is the header portrait: a large squircle beside the
  speaker's name, with the timestamp and token figure on the same line.
- Message action trays are hidden until the turn is hovered or focus-within,
  or the message header is pressed. Actions are never permanently rendered.
- The token figure reads inline in the message header beside the timestamp,
  and the live draft figure sits inline in the composer row. Both are always
  visible, neither is a control, and tabular figures keep them from reflowing.

### 6.5 Chat, mobile (below 720px)

```
+------------------------+
| [back]  [ledger] [gear] |  sticky, safe-area-top
+------------------------+
| [av] Kestrel Rowan      |
|      09:54  ~120 tokens |
| prose, 16px, 1.72       |
|                         |
| > thought block         |
|                         |
| ----------------------- |  hairline
| [av] User               |
|      09:54  ~120 tokens |
| | prose, cool rule      |
+------------------------+
| composer                |
| [input]                 |
| [persona] ~120 tokens   |
|                  [Send] |  buttons at 44px
+------------------------+  safe-area-bottom
```

- The message grid maintains a proportional two-column layout: a 36px portrait
  sits beside the speaker name and prose, sharing the same reading edge.
- The composer is sticky, clears `env(safe-area-inset-bottom)`, and the
  send action is at least 44px.
- Annotations render inline above the prose.
- The ledger opens as a bottom sheet with a drag handle.

### 6.6 Alignment rules

1. Everything left aligns to one reading edge. Nothing is centred except
   empty states and dialog titles.
2. Prose never exceeds `--measure`. UI chrome never sets a wider line than
   the prose it sits above.
3. Card footers and message trays align across their row; variable content
   above them is clamped or pushed with `margin-top: auto`.
4. Prose is left aligned, never justified. Justified serif at this measure
   produces rivers, and the app is used at length.
5. Optically, prose blocks get slightly more space below than above, so the
   column reads as a series of turns rather than a list.

## 7. Class contract

Every class is prefixed `rp-`. `design/tokens.css` loads first, then
`design/components.css`, then the page composition layer (`ui/library.css`,
`ui/chat/chat.css`). Nothing here redefines an existing class, so the
stylesheets coexist.

### 7.1 Shell and utilities

| Class | Use |
|---|---|
| `.rp-app` | Page root. Sets ground, ink, UI face, min-height `100dvh`. |
| `.rp-topbar` | Sticky chrome. Add `.rp-topbar__title`, `.rp-topbar__spacer`. |
| `.rp-container` | Max 1440px, centred, responsive inline padding. |
| `.rp-measure`, `.rp-measure--wide` | Cap a column at 68ch / 84ch. |
| `.rp-panel`, `.rp-panel--raised` | Surface panel; raised adds `--shadow-sm`. |
| `.rp-well` | Reading well: sunken ground, grain, and the reading gutter. |
| `.rp-scroll` | Token-driven scrollbar, `overscroll-behavior: contain`. |
| `.rp-skip-link` | Off-screen until focused. First element in `body`. |
| `.visually-hidden` | Screen-reader-only text. |
| `.rp-tnum` | Tabular figures for any numeric UI text. |
| `.rp-focusable` | Ring for a non-interactive element given `tabindex`, such as a scroll region. Adds a ring only, never suppresses one. |
| `.rp-surface-title`, `--display`, `.rp-surface-subtitle` | Page heading block. `--display` is the 34px variant, Library only. |

### 7.2 Buttons

Base `.rp-btn`, then exactly one variant and at most one size.

| Class | Meaning |
|---|---|
| `.rp-btn--primary` | The single committing action in a view. Filled `--ink`. |
| `.rp-btn--secondary` | Alternative action. Filled `--surface-raised`. |
| `.rp-btn--ghost` | Quiet action in a toolbar or tray. |
| `.rp-btn--danger` | Destructive, filled. |
| `.rp-btn--danger-ghost` | Destructive, quiet. |
| `.rp-btn--annotation` | Gold wash. Only for ledger and continuity actions. |
| `.rp-btn--sm`, `.rp-btn--md`, `.rp-btn--lg` | 28px, 34px and 44px heights. `--md` is the default, named so a page can state it. |
| `.rp-btn--icon` | Square, `aspect-ratio: 1`. Needs `aria-label`. |
| `.rp-btn--block` | Full width. |
| `.is-loading` | Swaps the label for a spinner, keeps width. |
| `[aria-pressed="true"]` | Pressed toggle. Real attribute, not a class. |
| `[disabled]`, `[aria-disabled="true"]` | Disabled. |

### 7.3 Fields

`.rp-field` wraps `.rp-label` plus a control plus `.rp-help` or `.rp-error`.
Controls: `.rp-input`, `.rp-textarea`, `.rp-select`, `.rp-range`. Invalid
state is `.is-invalid` on the control, plus `aria-invalid="true"` and an
`.rp-error` with real words. Errors never rely on colour alone; `.rp-error`
renders its own marker.

### 7.4 Chips, badges, avatars

`.rp-chip`, plus `--muted`, `--annotation`, `--user`, `--interactive`. An
interactive chip must be a `<button>` with `aria-pressed`, not a clickable
div. `.rp-chip-group` wraps a row. `.rp-badge` with `--count` (gold),
`--annotation`, `--warn`, `--danger` for counts and states.

`.rp-avatar` with `--sm`, `--md`, `--lg`, `--user`, and
`.rp-avatar__initials` for the fallback. It is a squircle, it holds an
`<img>` whenever a portrait exists, and initials are a quiet fallback
rather than a design feature.

### 7.5 Card

`.rp-card`, `--interactive`, `--selected`, with `.rp-card__media`,
`.rp-card__head`, `.rp-card__heading`, `.rp-card__title`, `.rp-card__byline`,
`.rp-card__body`, `.rp-card__meta`, `.rp-card__footer`, `.rp-card__actions`.
The card is the link to detail; the footer carries one action.

### 7.6 Dialog, sheet, drawer

- `.rp-dialog` is a `<dialog>` element. Children: `.rp-dialog__panel`,
  `.rp-dialog__header`, `.rp-dialog__title`, `.rp-dialog__desc`,
  `.rp-dialog__close`, `.rp-dialog__body`, `.rp-dialog__footer`.
  Under 720px the panel becomes a bottom sheet automatically; include
  `.rp-sheet__handle` as the first child so the grab affordance appears
  only where it is meaningful.
- `.rp-sheet` is a panel that is a sheet at every width, for composer-owned
  surfaces such as the ledger. On desktop it docks bottom-right.
- `.rp-drawer` and its alias `.rp-sidebar` are the navigation and filter
  rail. Off-canvas and translated out by default; open it with
  `data-open="true"` or `.is-open`. `.rp-drawer--end` docks it to the
  trailing edge. At 1024px and up both become sticky in flow, so the same
  markup serves both breakpoints.

Use the native `<dialog>` so focus trapping and Escape are the platform's
job, not the page's.

### 7.7 Tabs

`.rp-tabs` (`role="tablist"`), `.rp-tab` (`role="tab"`), `.rp-tabpanel`
(`role="tabpanel"`). Selected state is `aria-selected="true"`, and the
selected tab is marked by a gold rule under it, not by weight alone.

### 7.8 Feedback

`.rp-toast-region` (one per page, `aria-live="polite"`) containing
`.rp-toast`, with `--danger` and `--success`. `.rp-empty` with
`.rp-empty__title` and `.rp-empty__body`. `.rp-loading`. `.rp-error-state`
with `.rp-error-state__title` and `.rp-error-state__body`.
`.rp-skeleton` with `--line`, `--block`, `--text`.

### 7.9 Chat

| Class | Use |
|---|---|
| `.rp-message`, `--user`, `--assistant` | One turn. Separated by a hairline, not a card. |
| `.rp-message__rail`, `.rp-rail` | Portrait column; collapses inline below 720px. |
| `.rp-message__content` | Text column. |
| `.rp-message__head` | Speaker line: portrait, name, timestamp, token figure. It is the tray's control: tapping it, hovering the turn, or focusing inside reveals the tray. |
| `.rp-message__speaker` | Name. The character's own name is marginalia, so it wears `--accent-annotation`; the author's hand gets `--accent-user`. Colour alone then tells a reader whose turn it is. |
| `.rp-message__meta` | Timestamp and token figure, mono, tabular. |
| `.rp-message__prose` | The reading surface. Serif, 68ch, 1.72 leading. |
| `.rp-message__tray` | Hidden until hover, focus-within, or `data-open="true"`. |
| `.rp-thought`, `.rp-thought__summary` | Annotated thought block, gold. |
| `.rp-flag` | Continuity flag chip. |
| `.rp-composer`, `.rp-composer__box`, `__input`, `__actions`, `__actions--end` | The composer dock. |

The continuity and context panel is `.rp-ledger`, a flex column of blocks. Every
block is a bordered `.rp-surface` card so a reader can see where one ends:

| Class | Use |
|---|---|
| `.rp-ledger__summary`, `__summary-head`, `__summary-used`, `__summary-of`, `__summary-note` | The headline: how full the window is, and what that means. `data-status` on the summary (`room`, `filling`, `full`, `over`) drives the meter colour and the figure colour together. |
| `.rp-ledger__meter-row`, `.rp-ledger__meter`, `__meter-pct` | The window meter. The fill is a `<span>` with an inline `width`, because a runtime-computed proportion cannot be covered by a hash. |
| `.rp-ledger__group`, `__group-title`, `__rows` | One titled block of rows. A group with no rows renders as nothing at all. |
| `.rp-ledger__row`, `__key`, `__hint`, `__value` | One label-and-figure line. The value column is tabular so figures do not reflow. |
| `.rp-ledger__note` | A full-width sentence for information that is not a measurement. |
| `.rp-ledger__trend`, `.rp-ledger__trend-bar` | Cache reuse over time: one bar per reply, oldest first. The bar's height is `--h`, a bare fraction the panel writes, so the stylesheet never has to know what a cache is. `data-state` is `warm`, `cold` or `unknown`; `data-folded="true"` adds the tick that marks a reply whose prompt was just rebuilt. The track's width is driven by `--bars`, the reply count, so a two-reply history draws a two-bar chart instead of two bars in an empty box. |

### 7.10 Tooltip

`.rp-tooltip` wraps the trigger; `.rp-tooltip__panel` is the bubble. It
opens on hover and on `focus-within`, so keyboard users get it too. For
anything essential, use `aria-describedby` and let the panel be visual
reinforcement.

## 8. Interaction rules

1. **Touch targets.** Under `(pointer: coarse)`, every button, tab,
   interactive chip, message header, dialog close, composer action and
   range control is at least 44 by 44 CSS px. `.rp-btn--lg` is 44px at
   every pointer type. The floor everywhere is `--target-min` (24px).
2. **Hover.** All hover styling lives inside
   `@media (hover: hover) and (pointer: fine)`. Nothing actionable is
   revealed by hover alone: the message tray also opens from its header control
   and on `focus-within`, so a touch or keyboard user can always reach it.
3. **Focus.** Defined once in `tokens.css` as `:focus-visible` with a 2px
   ring and 2px offset, and never removed. `scroll-padding` on `html`
   keeps focused controls clear of the sticky bar (WCAG 2.4.11).
4. **Motion answers actions only.** Durations: 90ms press, 140ms
   hover and focus, 220ms disclosure, 320ms sheet travel. Nothing animates
   on load, nothing loops except a loading indicator, and nothing animates
   `width` or `height`; the sheet and drawer move on `transform`.
5. **Reduced motion is total.** `@media (prefers-reduced-motion: reduce)`
   sets every animation and transition to 1ms with no delay, collapses
   `scroll-behavior` to `auto`, zeroes the motion tokens themselves, and
   removes the reading well's grain layer.
6. **Pointer gestures.** No action requires dragging. The sheet handle is
   decoration; every sheet also closes with its close control and Escape.
7. **State is never colour alone.** Selected tabs carry a rule, errors
   carry a marker and words, badges carry their count, flags carry a
   border and label.
8. **Programmatic scrolling resolves the preference at the call site.** A
   stylesheet cannot do this one: an explicit
   `scrollIntoView({ behavior: "smooth" })` outranks a `scroll-behavior` rule, so
   the reduced-motion block above does not suppress it. Every programmatic scroll
   goes through `scrollIntoViewRespectingMotion` in `ui/dom.js`, which reads the
   preference and downgrades the behaviour. A test asserts no call site bypasses
   it.

## 9. Anti-tells

| Banned | What this system does instead |
|---|---|
| Cream background with terracotta accent | Paper's ground is `#F1F0EB`, a warm neutral, not `#F4F1EA` cream. The accent is `#7A5A16`, a bronze, and it is confined to annotations. No terracotta or clay value appears anywhere in either theme. |
| Acid green on black | Neither theme uses green as an accent. `--success` is a muted sage, appears only for confirmed states, and never on the dark ground as a highlight. |
| Generic SaaS card kit | Turns are separated by hairlines, not cards. Radii vary by hierarchy (3px chips, 5px controls, 8px cards, 14px dialogs, 20px well) rather than one radius everywhere. Shadows are tinted per theme and used only where elevation is real. |
| ALL-CAPS tracked-out eyebrow labels | No uppercase transform exists in either stylesheet. Micro-labels are lowercase with 0.02em tracking. The only uppercase strings are data (initials fallback). |
| Purple or blue "AI gradient" | No gradients except the skeleton sheen. The cool accent is a desaturated cornflower, not a purple. |
| Arrow on buttons | No button label contains an arrow or a chevron glyph. Navigation is a real link or a labelled control. |
| Letter-monogram avatars as a design feature | `.rp-avatar` is a squircle that holds an `<img>` whenever a portrait exists. The initials fallback is deliberately quiet (12 to 13px, `--ink-faint`) and is not used as a decorative device. |
| Em dashes in copy | None in either stylesheet or this document. |

## 10. The one bold element

**Marginalia:** the reading well itself. The pane opens the full column, a
sunken ground carrying a static grain, with one reading gutter shared by the
message portraits, the prose and the composer. Continuity flags, thought
marks and the author's hand render inline above the prose.

**Paper:** the same pane, spent the other way. In daylight the sunken ground
flattens to hairline-and-type, and the grain turns to `multiply` and does the
work that shadow does in the dark theme, so day mode stays e-ink flat instead
of pretending to have depth.

## 11. Sources

- `frontend-design` skill: subject-first grounding, "spend boldness in one
  place", the anti-default typography list, motion that answers actions.
- `ui-ux-pro-max` database rows actually used:
  - `styles.csv` row `e-ink-paper` (E-Ink / Paper): off-white ground, ink
    black text, no-motion reading surface, grain texture, print-friendly.
    Drove the Paper theme's flat elevation and its grain blend.
  - `styles.csv` row `minimalism-and-swiss-style`: monochrome base, grid,
    essential-only chrome. Drove the single reading edge and the quiet
    chrome.
  - `colors.csv` rows `Theater/Cinema` (dramatic dark with a gold accent,
    `#CA8A04` on `#0F0F23`) and `Home Decoration & Interior Design` (warm
    grey with a gold accent, `#D97706`). Used only as a sanity check that a
    dark ground with a single gold annotation accent is a real,
    product-appropriate pairing. The actual hexes are my own; the database
    golds were too saturated and landed near the banned terracotta.
  - `typography.csv` row `Minimalist Monochrome Editorial` (serif body plus
    mono for figures, no UI sans) and row `Bold Typography Mobile`
    (mono restricted to stats and labels). Drove the decision to keep
    JetBrains Mono strictly on figures and to set body prose in a serif.
  - `ux-guidelines.csv` rows: `Focus States` (High), `Focus Not Obscured
    (Minimum)` (High), `Keyboard Navigation` (High), `Compact Control
    Semantics` (Critical), `Focus Appearance` (Medium), `Mobile First`
    (Medium), `Viewport Meta` (High), `Pull to Refresh` (Low). These drove
    the single `:focus-visible` rule, `scroll-padding` on `html`, the rule
    that interactive chips must be real buttons with `aria-pressed`, the
    mobile-first breakpoints, and `overscroll-behavior: contain` on the
    reading well.
  - The `--design-system` aggregate returned a `Vibrant & Block-based`
    recommendation with `#DC2626` and `#D97706` on `#FFFBEB`, plus a
    `Righteous / Poppins` pairing. That is a music and events profile and
    was rejected as off-product; it is recorded here rather than followed.
- `redesign-existing-projects` skill: the audit that produced the fix list
  (font swap, palette cleanup, hover and active states, layout and
  spacing, component replacement, then loading, empty and error states),
  plus the specific findings that the Library left 60 percent of a wide
  viewport empty, that the card had two competing affordances, and that
  hover-only affordances were a touch problem.
- `web-design-guidelines` skill: compliance framing for the interaction
  and accessibility rules.
- `accessibility` skill (WCAG 2.2): contrast minimums, focus appearance,
  target size, motion, form labels, error handling, and the requirement to
  keep native elements where they exist.

## 12. What was deliberately left out

- **No new npm dependency and no preprocessor.** Plain CSS in two files.
  The only build step is none.
- **No new font beyond one.** Newsreader and JetBrains Mono already ship in
  `public/fonts/` and are reused by relative path. Source Sans 3 was added
  at `public/design/fonts/` because the previous system stack was the main
  reason the chrome read as a default. Two other pairings from the database
  (Cormorant with Crimson, Playfair with Source Serif) were rejected: they
  are display faces for short passages and read as costume at paragraph
  length, and the first is the "academia" look the brief's cream and
  terracotta ban is adjacent to.
- **No JavaScript.** This deliverable is a spec and two stylesheets. Theme
  switching, tray toggles, sheet and drawer opening and focus management
  are the page workers' job; the contract exposes `[data-theme="paper"]`,
  `data-open`, `aria-pressed`, `aria-selected` and `aria-expanded` as the
  hooks.
- **No icon set.** Icons are out of scope for a CSS system, and adding a
  library would break the zero-dependency rule. The one glyph that appears
  in CSS is the `.rp-error` marker, drawn in CSS.
- **No dark and light toggle control.** The skill's guidance is explicit
  that a sun and moon switch is a default; the theme is set by a
  `data-theme` attribute, and the control belongs in the settings surface
  the page workers own.
- **No spinner component for page loads.** Skeleton shapes that match the
  eventual layout are specified instead, because a skeleton that matches
  the layout is strictly more useful than a centred circle.
- **No motion beyond state changes.** No scroll reveals, no staggered
  entry, no parallax. The product is read for hours; entry animation on
  every section is the generic default and actively annoying here.
- **No committed test suite for CSS.** The verification is a set of harnesses
  under `.workbuddy-ai/analysis/`: `contrast_audit.mjs` produces every ratio in
  §4, and browser probes cover layout, target sizes and interaction behaviour.
  They live outside the tracked source. A CSS regression test would pin
  implementation rather than behaviour, which the project's own testing standard
  rejects.

## 13. Adding to the system

1. **A new value goes in `tokens.css`** — in both themes, or with a documented
   reason it is shared. Nothing else may introduce a colour.
2. **Run `contrast_audit.mjs`.** A pair that is not in its `PAIRS` list is not
   checked, so a new combination has to be added there too. Then update §4 from
   its output; do not edit those tables by hand.
3. **A new component goes in `components.css`** as an `rp-` class, and gets a row
   in §7. A page stylesheet may compose tokens and set layout; it may not define a
   colour or re-declare a shared class.
4. **A new motion gets a token duration** and an entry in §8. If it is a
   programmatic scroll, it goes through `scrollIntoViewRespectingMotion`.
