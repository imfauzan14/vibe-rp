# Witness Mode — design for scenes where the player loses agency

Status: **proposal, not implemented.** Nothing in `public/` has changed for this
document.

## 1. The problem, and the principle that resolves it

Today, when the player character is knocked out or dead, Choice Mode offers
`continuation` choices. Measured against a live model, a dead player produced:

```
[continuation] Elena packs and prepares to leave
[continuation] A quiet pause at the threshold
[continuation] The archive settles into silence
[continuation] Dawn breaks through the clerestory
```

Four options about *the scene*, none about *the person the reader is bound to*.
The reader is no longer roleplaying; they are choosing camera angles. That is the
"controlling the story" feeling the brief describes, and it is real.

The design principle that resolves it comes from Nick Montfort, in *Second
Person*, endorsed by Emily Short:

> the player character in interactive fiction is **not played at all**, but is a
> **constraint and possibility defined by the author**, within which the
> interactor is bound to a particular perspective and a particular set of
> capabilities.

If the reader is *bound to a perspective and a capability set*, then an empty
capability set is not a special case to be papered over — it is a **rebinding**.
The perspective moves to whoever is still in the scene. And Short's corollary
gives the licence to do it without branching the plot:

> not all forms of interactive narrative require that the player's agency pertain
> to the *plot* as such.

So the target is not "give the player something to do while they wait". It is:
**keep the reader inside a perspective, and move the perspective.**

A second principle, from tabletop practice (The Angry GM, on character death),
sets the failure mode to avoid: a dead or downed character leaves *"a player out
of play… with no character, he has no way to play."* Witness mode is the answer
to that — the reader still directs something — and it must not be padded into an
endless epilogue either.

## 2. State model

The brief lists "unconscious, bound, dead, comatose" as one category. They are
not one category, and collapsing them is the first flaw worth correcting (see
§9.1). Capability has two axes, and only their combination selects the mode:

| Perceives? | Can act? | Mode | Whose perspective |
| --- | --- | --- | --- |
| yes | yes | **action** | the player's own |
| yes | no (bound, gagged, paralysed, pinned) | **constrained** | the player's own — they are still the camera |
| no | no (unconscious, comatose, dead) | **witness** | another present character |
| no | no, and nobody present | **void** | nobody — see §6.1 |

`constrained` is not witness mode. A bound player watching their captor work is
*the player's scene*; handing it to the captor's POV throws away the most
interesting thing available and starts the "I'm not playing my character" feeling
early. The transition ladder is therefore:

```
action  ->  constrained  ->  witness  ->  (recovery)  ->  constrained  ->  action
                                     \-> (permanent)   ->  witness until the reader closes the scene
```

Every arrow is reversible except the permanent one.

## 3. Classification

Who decides the mode? Two sources, one authority each:

- **The model classifies**, because only it can read the prose. The choice
  response gains one control field — not the six-field assessment removed in the
  previous pass. A single enum the UI must act on is a control signal, not
  reasoning, and is worth the tokens.
- **The app enforces**, because the model must not be able to shorten or skip the
  recovery ladder (§5), and because a model that ignores the mode must not break
  the UI.

```jsonc
{ "mode": "action" | "constrained" | "witness",
  "choices": [ { "pov": "Elena Voss", "label": "...", "text": "...", "type": "witness" } ] }
```

`mode` is validated against the enum and defaults to `action` when absent or
unrecognised, so an older or weaker model degrades to today's behaviour rather
than to a broken panel.

**The episode record** is derived state on the session, never part of the
transcript — the same shape as `choiceSet`:

```jsonc
session.agencyEpisode = {
  mode: "witness",
  cause: "struck_from_behind" | "bound" | "comatose" | "dead" | "voluntary" | "unknown",
  severity: "minor" | "moderate" | "major" | "permanent",
  startedAtMessageId: "…",     // the assistant turn that established it
  witnessTurns: 2,             // incremented per settled witness beat
  voluntary: false
}
```

It **must be persisted**, not held in memory. If `witnessTurns` lived only in the
controller, a page reload would reset the ladder and let the reader escape
incapacitation by refreshing — a real exploit, not a theoretical one.

## 4. The choice contract in witness mode

### 4.1 Count rules

The menu is driven by **how many perspectives exist**, not by dramatic archetypes:

| Present POVs | Choices | Rule |
| --- | --- | --- |
| 0 | 0 | void — see §6.1; never render an empty panel |
| 1 | **exactly 1** | the reader's example: "I died but there's only one person who watched" |
| 2–3 | **one per character** | each option is a different person's POV |
| 4+ | **3, ranked by impact** | the ceiling; the model omits the least consequential |

Hard validations, applied to untrusted model output the way `parseChoices`
already validates types:

1. **At most one choice per `pov`.** Two beats for the same character is the
   archetype menu leaking back in.
2. **`pov` must name a character in the scene**, matched case-insensitively
   against the card roster and the ensemble cast. An invented name is dropped.
3. **`pov` must not be the player.** The player is the perspective, not a subject
   of it.
4. **No `action`-typed choices in witness mode.** If every choice is dropped by
   1–4, treat it as a generation failure: one retry, then fall back to a single
   `continuation` beat so the reader is never stranded.

### 4.2 "Most impactful" needs a definition

Left undefined, the model will rank arbitrarily and the ceiling will cut good
options. Define it as: **impact = consequence for what the reader cares about ×
irreversibility.** A beat that changes what the player will wake into, or that
cannot be undone, outranks a beat that is merely vivid. State that in the prompt
rather than the word "impactful".

### 4.3 Options must differ in *what happens*, not only in *whose eyes*

"Follow Elena" / "Follow Marek" is not a choice; it is a camera switch, and it
reproduces the exact failure being fixed one level down. Each option must name a
**beat**: a character *and* a turn of events.

> Elena — she sees the blood and decides to hide it from Marek.
> Marek — he starts searching the room, and finds the letter.

The `pov` field drives presentation (whose section it sits under); the `label`
and `text` carry the beat.

## 5. The recovery ladder

The brief's constraint — "at an appropriate point (not too early)" — cannot be
left to the model, or a sympathetic model will wake the player on the next turn.
The engine owns the floor; the model owns the ceiling.

| Cause | Severity | Minimum witness beats | Recovery route |
| --- | --- | --- | --- |
| stunned, winded, briefly blinded | minor | 0 | the player simply acts again |
| knocked out, drugged, bound | moderate | 2 | comes round, or is freed |
| severe injury, coma, paralysis | major | 3 | wakes, or is revived by another character |
| **dead** | **permanent** | — | none; the scene closes instead |

Rules:

- **Below the floor**, the choice prompt carries an explicit instruction: the
  player is still out, do not offer or narrate recovery. This is a deterministic
  gate, so it holds regardless of how sympathetic the model feels.
- **At or above the floor**, recovery becomes *available*, not automatic. The
  model may return one `recover` beat in the menu — but only then, and only when
  the scene has earned it (someone is there to help, the drug is wearing off).
- **The reader never gets a "wake up" button below the floor.** Offering it
  collapses the tension of the scene into a menu item.
- **Death never recovers.** Re-narrating a fake recovery is already forbidden in
  the choice prompt; this makes it structural.

The mechanism, not the timer, should justify the recovery. "Two beats have
passed" is not a reason for someone to wake up; *Elena noticed the wound* is. The
floor only stops it happening too early.

## 6. Two cases the brief does not cover

### 6.1 Void — the player is out and nobody is present

Knocked out alone in an empty room. There is no perspective to rebind to and no
character to enumerate. In order of preference:

1. **The player's own liminal POV** — sensory fragments, a dream, a memory,
   half-heard sound. Still the player's perspective; no agency, but no loss of
   identity either.
2. **A single `continuation` beat** — time passes, the scene has moved when they
   come round. Exactly one option, and it should render as an advance, not a menu.
3. **Never an empty panel.** If the model returns zero choices, the app supplies
   the advance affordance itself.

### 6.2 Voluntary incapacitation

The player chose this: feigning sleep, a trance, playing dead. Functionally
identical to being knocked out, and the ladder would trap them in their own
choice — they cannot end a deception on their own say-so. The episode record
therefore carries `voluntary: true`, which **exempts it from the minimum floor**.
The reader may end it at any point.

## 7. The transcript problem

This is the hardest engineering constraint, and it is not mentioned in the brief.

A witness choice like *"Elena hides the wound from Marek"* cannot be appended as
an ordinary user turn. The transcript is single, and `selectChoice` appends
`{role: "user", content: choice.text}`. A plain user turn saying what Elena does
means:

- the player's persona is narrating another character, contradicting the craft
  contract the app enforces on the model in the same request;
- export, search, fork and the context allocator all treat it as in-character
  player speech, permanently.

**Solution: an explicit directive marker**, following the precedent already set
by the ledger's `<ledger>` block.

```
[witness: Elena Voss]
The reader wants this beat: Elena notices the blood on the floor and decides to
hide it from Marek before he sees it.
```

The marker does three things: it keeps the transcript honest (this turn is
authorial, not in-character), it tells the model unambiguously whose POV to
write, and it survives export and fork as visible text rather than silently
corrupting the record.

Two supporting changes:

- **A witness guidance line in the tail, not the prefix.** Like the existing
  adaptive guidance, it rides the trailing user turn, so the cached prefix is not
  invalidated when the mode changes. It states: this turn is the reader directing
  a beat for another character; write that character's POV; keep that character's
  own agency intact (they may decline the beat if it is out of character).
- **The escape hatch keeps working, but reframed.** "Other…" free text in witness
  mode is wrapped in the same `[witness: …]` form. Emily Short's constraint
  applies — the player "doesn't get to propose new events" — so the prompt asks
  the model to *render the requested beat*, and to let the character resist it if
  the beat contradicts who they are. The reader keeps a voice without gaining
  authorial override.

## 8. Edge-case register

Each row is a way this can go wrong, and what the design does about it.

| # | Case | Failure without a rule | Mitigation |
| --- | --- | --- | --- |
| 1 | Player alone and out | Empty menu, or a scene-level menu | §6.1 liminal POV, else one advance beat |
| 2 | Bound but sighted | Witness mode discards the player's own POV | `constrained`, not `witness` (§2) |
| 3 | Player dead | Fake recoveries loop forever | `permanent`; no recovery branch exists |
| 4 | Death, many turns on | Endless epilogue; the reader is stuck | Soft cap on witness turns, then offer to close the scene |
| 5 | Unconscious but dreaming | Witness mode discards an available player POV | Liminal POV counts as a POV; witness is for *absent*, not *inert* |
| 6 | Roster member not in the scene | Choices about people who are not there | `pov` must be validated against presence, and the prompt requires it |
| 7 | Party split across locations | Following one POV silently abandons the other | Only the current location's POVs are offered |
| 8 | Player feigned it | Trapped in their own deception | `voluntary` exempts the floor (§6.2) |
| 9 | Incapacitated by their own failed roll | The lock reads as punishment | Witness beats must *yield something* — information, a small influence — never pure waiting |
| 10 | The captor is the only POV | Dramatically strong, but risks glamorising | Allowed; no special handling. Content policy is the reader's business, not the app's |
| 11 | Recovery lands mid-beat | Stale menu survives the mode change | The existing `choiceSourceSignature` staleness machinery invalidates the set |
| 12 | Non-human POV (animal, AI) | Model invents a narrator | Allowed if the POV is a cast member; validated like any other |
| 13 | Model returns `action` choices while the player is out | Menu offers impossible actions | Validation rule 4; fall back to a `continuation` beat |
| 14 | Model returns 4 beats for 2 characters | The archetype menu leaks back | At most one choice per `pov` (validation rule 1) |
| 15 | Model invents a character name | A stranger appears in the menu | Roster validation drops it (rule 2) |
| 16 | Player name used as a POV | "Follow yourself" | Player excluded from POV enumeration (rule 3) |
| 17 | Character name injected into the marker | Prompt injection through the marker | `renderInlineField` flatten-and-clamp, as everywhere else |
| 18 | **Reload during incapacitation** | `witnessTurns` resets; refreshing escapes the scene | The episode is **persisted** on the session (§3) |
| 19 | History folds during incapacitation | The model forgets the player is out | The directive is re-derived from the persisted episode every turn, so it survives a fold |
| 20 | Two cast members share a name | Duplicate POV entries | Dedupe on the normalised name |
| 21 | Card has no roster at all | Zero POVs enumerated | Falls to §6.1 |
| 22 | One POV, one beat | Looks like a broken menu | Render as an advance affordance, not a one-item choice list |
| 23 | Latency | Measured 7.8–14.6 s per non-streaming choice request; a witness sequence pays it every beat | Fewer options per menu; document the cost; consider streaming the choice call later |
| 24 | Cost | A permanent death is an unbounded sequence | Soft cap (§4.1) plus the close-scene offer |
| 25 | Weak model ignores `mode` | Panel breaks | Enum validation with an `action` default; the app never trusts the field blindly |

## 9. Flaws in the brief, and recommended corrections

These are places where the stated requirement would produce a worse system than
the intent behind it.

**9.1 "Unconscious, bound, dead, comatose" is one list but two states.**
Bound-and-gagged players can still perceive. Putting them in witness mode throws
away the player's own perspective and triggers the "not playing my character"
feeling earlier than necessary. Recommendation: split into `constrained` (keeps
the player's POV, limited actions plus directed attention) and `witness` (player
absent). This is the single most consequential correction.

**9.2 "One choice per character" is under-specified.**
Without a rule that each option must be a *beat* (§4.3), the menu becomes a
camera switcher — the original defect one level down. Recommendation: the POV
selects the section, the beat is the choice.

**9.3 "Only the most impactful" needs a criterion.**
Recommendation: consequence × irreversibility, stated in the prompt (§4.2).

**9.4 The brief does not say who owns the recovery timing.**
"Not too early" is a floor, not a schedule. Recommendation: the engine owns the
floor deterministically, the model owns the judgement above it, and the reader
never gets a recovery button below the floor (§5).

**9.5 A single-choice menu is a button wearing a menu's clothes.**
Recommendation: present it as an advance affordance. Keep the "Other…" escape
hatch so the reader is never literally without input.

**9.6 Nothing in the brief addresses the transcript.**
The directive marker (§7) is a prerequisite, not a detail. Without it, witness
mode silently corrupts the record it is stored in.

## 10. What would change, by file

| File | Change |
| --- | --- |
| `public/choice_format.js` | Witness contract text; `mode` and `pov` in the output shape; `parseChoices` validates `mode` and `pov` |
| `public/browser_engine.js` | `planChoiceRequest` takes the episode and emits the mode-appropriate contract; witness guidance rides the tail; `[witness: …]` marker on the chosen turn |
| `public/session_controller.js` | `agencyEpisode` on the session (persisted); `witnessTurns` increment; mode-aware `selectChoice`; staleness on mode change |
| `public/ui/chat/choice_panel.js` | Group options by POV; advance affordance for a one-option set |
| `public/prompt_adaptive.js` | Optional deterministic incapacity cues as a cross-check on the model's classification |
| `test/` | Mode classification, the count rules, POV validation and its four drop rules, the floor, the voluntary exemption, the reload exploit, fold survival |

## 11. Open questions for you

1. **`constrained` as a separate mode** (§9.1) — agree, or do you want bound
   players in witness mode as originally specified?
2. **Witness-turn cap** before offering to close the scene — a number you have in
   mind, or should I make it a setting?
3. **After death**: keep the session as a directable epilogue, or surface a
   close/fork affordance immediately?
4. **Recovery ownership** (§9.4) — engine floor plus model judgement, or should
   recovery appear as a selectable option once the floor is met?
5. **Should I implement it?** The change spans the engine, the controller, the
   panel and the tests, and the design has four decisions still open.
