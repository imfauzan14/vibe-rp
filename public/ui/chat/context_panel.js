// Context panel — what the next request carries, said in plain language.
//
// Contract
//   - `renderContextPanel({ request, usage, windowLearned })` returns the inner
//     HTML for the Context sheet. It is a pure function of its arguments, so the
//     panel can be tested and rendered without a live session and cannot drift
//     from the numbers `planRequest` measured.
//   - `request` is a `BrowserChatEngine.describeRequest` result: the exact
//     payload that will be sent, measured. `usage` is `session.lastUsageReport`,
//     or null when the provider has reported nothing. `windowLearned` says
//     whether the window came from the provider or from the reader's own
//     setting.
//   - **A row is omitted when it is empty.** The shipped defaults leave several
//     of these at zero for every session — the continuity recap only exists once
//     the window fills, which at 65,536 tokens is never — and "Continuity recap:
//     0 tokens" reads to a reader as a broken feature rather than an absent one.
//   - **Nothing here names a provider, a model, or a language.** Every figure is
//     either measured from the request or reported by the endpoint, and any
//     endpoint that reports nothing simply yields a shorter panel.
//   - **Labels avoid engine vocabulary.** The reader may know nothing about
//     tokens, context windows or gateways, so the headline answers the question
//     they actually have ("how much room is left, and what happens when it
//     runs out") and every term that is not self-evident carries one plain
//     sentence.
//
// Exports
//   renderContextPanel(args) -> string
//   contextSummary(request)  -> { window, used, free, pct, status, note }
//   formatTokens(n)          -> string

const THOUSAND = 1000;
const MILLION = 1000 * THOUSAND;

/** A count with no unit, for places where the unit is already on the line. */
function formatCount(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n < THOUSAND) return String(n);
  // Above a million, thousands stop being readable: "1049k" is a number a reader
  // has to convert. Windows that large reach the app through an imported
  // session, so the panel has to survive one.
  if (n >= MILLION) return `${(n / MILLION).toFixed(1)}M`;
  const k = n / THOUSAND;
  // One decimal below 100k, so a 1.2k reply does not read as "1k"; whole
  // thousands above it, where the decimal is noise.
  return `${k < 100 ? k.toFixed(1) : Math.round(k)}k`;
}

/** A token count the reader can read at a glance, never a bare integer. */
export function formatTokens(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n < THOUSAND) return n === 1 ? "1 token" : `${n} tokens`;
  return `${formatCount(n)} tokens`;
}

/**
 * The answer the panel leads with: how full the window is, and what that means.
 *
 * `status` is a coarse band rather than a number so the meter can be coloured
 * and the sentence chosen without the caller re-deriving thresholds.
 */
export function contextSummary(request) {
  const window = Math.max(0, Number(request?.contextWindow) || 0);
  const breakdown = request?.breakdown || {};
  const used = Math.max(0, Number(request?.totalTokens) || 0);
  const free = Math.max(0, Number(breakdown.remaining) || 0);
  const pct = window > 0 ? Math.min(100, Math.round((used / window) * 100)) : 0;
  const over = Boolean(request?.impossible);
  const status = over ? "over" : pct >= 90 ? "full" : pct >= 70 ? "filling" : "room";
  const note = over
    ? "Larger than the window. The engine will summarize or trim it before sending — raising the context window in Settings gives it more room."
    : `${formatTokens(free)} still free. When the window fills, older turns are summarized into a recap so the story can keep going.`;
  return { window, used, free, pct, status, note };
}

// Section ids are internal names. A reader should never be shown a camelCase
// identifier, so an id this table does not know is split into words rather than
// printed raw — a section added later degrades to something readable instead of
// to "voiceDifferentiation".
const SECTION_NAMES = {
  examples: "dialogue examples",
  constantLore: "constant world lore",
  epistemicBoundary: "knowledge limits",
  castRoster: "the cast list",
  voiceDifferentiation: "voice notes",
};

function plainSectionName(id) {
  return SECTION_NAMES[id] || String(id || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

function row(label, value, hint) {
  return (
    `<div class="rp-ledger__row">` +
    `<span class="rp-ledger__key">${label}` +
    (hint ? `<span class="rp-ledger__hint">${hint}</span>` : "") +
    `</span>` +
    `<span class="rp-ledger__value">${value}</span>` +
    `</div>`
  );
}

// A full-width sentence, for information that is not a measurement. A status
// squeezed into the value column makes the label column wrap around it.
function note(text) {
  return `<p class="rp-ledger__note">${text}</p>`;
}

// A group with no rows renders as nothing at all, so a panel for a bare setup is
// shorter rather than emptier.
function group(title, rows) {
  const body = rows.filter(Boolean).join("");
  if (!body) return "";
  return (
    `<section class="rp-ledger__group">` +
    `<h3 class="rp-ledger__group-title">${title}</h3>` +
    `<div class="rp-ledger__rows">${body}</div>` +
    `</section>`
  );
}

export function renderContextPanel({ request, usage = null, windowLearned = false } = {}) {
  if (!request) return "";
  const b = request.breakdown || {};
  const summary = contextSummary(request);
  const percent = (n) => `${Math.round((Number(n) || 0) * 100)}%`;

  const story = [
    row("Story so far", formatTokens(b.history), "the conversation up to now"),
    b.ledger > 0
      ? row(
          "Continuity recap",
          formatTokens(b.ledger) + (request.ledgerCondensed ? " (shortened)" : ""),
          "older turns summarized, so the story keeps its memory"
        )
      : "",
    row("Your message", formatTokens(b.currentInput)),
  ];

  const leftOut = Array.isArray(request.excludedSections) ? request.excludedSections.map(plainSectionName) : [];
  const setup = [
    row("Character and story rules", formatTokens(b.requiredStatic), "the character card and the writing instructions"),
    b.optionalStatic > 0
      ? row("Optional guidance", formatTokens(b.optionalStatic), "extra material added when there is room")
      : "",
    b.persona > 0 ? row("Your persona", formatTokens(b.persona), "who you are in the scene") : "",
    b.lore > 0 ? row("World lore", formatTokens(b.lore), "background facts pulled in for this scene") : "",
    leftOut.length ? note(`Left out to make room: ${leftOut.join(", ")}.`) : "",
  ];

  const reserved = [
    row("Reply allowance", formatTokens(b.output), "the longest reply the model may write"),
    row("Safety margin", formatTokens(b.safetyMargin), "a little slack so a close estimate cannot overflow"),
  ];

  // Only what the provider actually reported. A row here is a measurement, not a
  // prediction, and a provider that reports nothing yields no rows rather than
  // zeros the reader would have to interpret. Values stay short enough to scan;
  // the sentence explaining what each one means lives in the hint.
  const provider = [];
  const addedByProvider = (tokens) =>
    row("Added by your provider", `+${formatTokens(tokens)}`, "a fixed extra added to every request, which the app never sends and cannot see");
  if (usage && usage.reported) {
    if (typeof usage.billedInput === "number") {
      provider.push(row("Input billed", formatTokens(usage.billedInput), "what your provider charged for the last message"));
    }
    if (usage.overhead > 0) provider.push(addedByProvider(usage.overhead));
    if (usage.cachedTokens > 0) {
      provider.push(row("Served from cache", percent(usage.cacheHitRate), "cached input is billed at a lower rate"));
    }
    if (usage.reasoningTokens) {
      provider.push(row("Thinking tokens", percent(usage.reasoningShare), "internal reasoning, billed as output"));
    }
    if (usage.ceilingIgnored) {
      provider.push(row("Reply limit", "ignored", "your Max response tokens setting had no effect on the last turn"));
    }
  } else if (request.overheadTokens > 0) {
    provider.push(addedByProvider(request.overheadTokens));
  }

  // Where the window number came from. It is a setting the reader chose, not a
  // fact the app knows, and stating it as a fact is wrong for anyone whose model
  // is smaller than the default — the failure this panel exists to explain.
  const windowNote = windowLearned
    ? "Reported by your provider."
    : "From your settings — lower it if your model allows less.";

  // Over-window is the one case where the headline's own arithmetic would read
  // as nonsense ("2.5k of 2.0k used"), so it is named instead of shown.
  const headline =
    summary.status === "over"
      ? `<span class="rp-ledger__summary-used">${formatCount(summary.used)}</span>` +
        `<span class="rp-ledger__summary-of">tokens — over the ${formatCount(summary.window)} window</span>`
      : `<span class="rp-ledger__summary-used">${formatCount(summary.used)}</span>` +
        `<span class="rp-ledger__summary-of">tokens of ${formatCount(summary.window)} used</span>`;

  return (
    `<div class="rp-ledger__summary" data-status="${summary.status}">` +
    `<div class="rp-ledger__summary-head">${headline}</div>` +
    `<div class="rp-ledger__meter-row">` +
    `<div class="rp-ledger__meter" role="img" aria-label="${summary.pct} percent of the context window used">` +
    `<span style="width:${summary.pct}%"></span></div>` +
    `<span class="rp-ledger__meter-pct">${summary.pct}%</span>` +
    `</div>` +
    `<p class="rp-ledger__summary-note">${summary.note}</p>` +
    `<p class="rp-ledger__summary-note rp-ledger__summary-note--quiet">${windowNote}</p>` +
    `</div>` +
    group("The story", story) +
    group("Character and setup", setup) +
    group("Reserved for the reply", reserved) +
    group("From your provider", provider)
  );
}
