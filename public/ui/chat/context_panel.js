// Context panel — what the next request carries, said in plain language.
//
// Contract
//   - `renderContextPanel({ request, usage, windowLearned, samples, scope,
//     scopeLabel, pruned })` returns the inner HTML for the Context sheet. It is
//     a pure function of its arguments, so the panel can be tested and rendered
//     without a live session and cannot drift from the numbers `planRequest`
//     measured.
//   - `request` is a `BrowserChatEngine.describeRequest` result: the exact
//     payload that will be sent, measured. `usage` is `session.lastUsageReport`,
//     or null when the provider has reported nothing. `windowLearned` says
//     whether the window came from the provider or from the reader's own
//     setting.
//   - `samples` is `session.usageHistory` and `scope` is the prefix key the
//     current setup would produce. The panel shows the trend for that scope
//     only; history under any other setup is reported as a count and never
//     folded into the figures.
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
//   - **No raw identifier reaches a reader.** `scope` is an internal key built
//     from ids; the panel is handed a `scopeLabel` the caller resolved from
//     names, and prints that instead.
//
// Exports
//   renderContextPanel(args) -> string
//   contextSummary(request)  -> { window, used, free, pct, status, note }
//   formatTokens(n)          -> string

import { usageTrend } from "../../usage_history.js";

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

const pctOf = (rate) => `${Math.round((Number(rate) || 0) * 100)}%`;

/**
 * One bar per reply, oldest on the left, height = the share of the prompt the
 * provider served from its cache.
 *
 * The chart is `role="img"` with the whole series in its label, because a
 * two-pixel bar is not readable and a reader using a screen reader would
 * otherwise get nothing at all. The numbers it carries are restated in the
 * sentence below it, so the chart is the shape and the sentence is the value.
 */
function trendChart(trend) {
  const bars = trend.series
    .map((point, index) => {
      const state = point.rate === null ? "unknown" : point.rate === 0 ? "cold" : "warm";
      const height = point.rate === null ? "0" : point.rate.toFixed(3);
      const what = point.rate === null ? "your provider reported no figure" : `${pctOf(point.rate)} reused`;
      return (
        `<span class="rp-ledger__trend-bar" data-state="${state}"` +
        (point.folded ? ` data-folded="true"` : "") +
        ` style="--h:${height}"` +
        ` title="Reply ${index + 1}: ${what}"></span>`
      );
    })
    .join("");
  const series = trend.series.map((p) => (p.rate === null ? "no figure" : pctOf(p.rate))).join(", ");
  // Singular, because "each of the 1 replies" is the kind of sentence that makes
  // a reader distrust everything else on the sheet.
  const subject = trend.total === 1 ? "the one reply" : `each of the ${trend.total} replies`;
  return (
    // `--bars` lets the stylesheet size the track to the series: two replies get
    // a two-bar chart, thirty fill the column.
    `<div class="rp-ledger__trend" role="img" style="--bars:${trend.total}" ` +
    `aria-label="Cache reuse for ${subject} under this setup, oldest first: ${series}">` +
    bars +
    `</div>`
  );
}

/** What the chart holds, in words: how many replies, and how many were measured. */
function coverageSentence(trend) {
  if (!trend.total) return "No reply has run under this setup yet.";
  if (!trend.measured) {
    const subject = trend.total === 1 ? "the one reply here" : `any of the ${trend.total} replies here`;
    return `Your provider has not reported a cache figure for ${subject}, so there is nothing to compare.`;
  }
  if (trend.total === 1) return "The one reply reported a cache figure.";
  if (!trend.unreported) return `All ${trend.total} replies reported a cache figure.`;
  return `${trend.measured} of ${trend.total} replies reported a cache figure.`;
}

/** The reading: the average, which way it is going, and what stands out in it. */
function readingSentence(trend) {
  if (trend.measured === 1) {
    return (
      `One reply reused ${pctOf(trend.median)} of its prompt. A single reply cannot show a trend — ` +
      `the next one will, and the first reply after any change in the setup is always cold.`
    );
  }
  const shape =
    trend.direction === "warming"
      ? ", and it is rising"
      : trend.direction === "cooling"
        ? ", and it is falling"
        : trend.direction === "steady"
          ? ", and it is steady"
          : "";
  let text = `Reused ${pctOf(trend.median)} of the prompt on average across ${trend.measured} replies${shape}.`;
  if (trend.cold) {
    text += ` ${trend.cold} of them reused nothing.`;
    text += " A reply right after anything changes is cold by definition, so a run of zeros means the prompt is not being reused at all.";
  }
  if (trend.series.some((p) => p.folded)) {
    text += " A tick marks a reply whose prompt had just been rebuilt from the recap, so a dip there is expected rather than a change in how reuse is going.";
  }
  return text;
}

/** History this chat holds under another setup — counted, never merged in. */
function otherSetupSentence(trend) {
  const replies = trend.otherSamples === 1 ? "reply" : "replies";
  const verb = trend.otherSamples === 1 ? "is" : "are";
  if (trend.otherScopes === 1) {
    return `${trend.otherSamples} earlier ${replies} in this chat ran under a different setup and ${verb} not counted here.`;
  }
  return `${trend.otherSamples} earlier ${replies} in this chat ran under ${trend.otherScopes} other setups and ${verb} not counted here.`;
}

/**
 * Cache reuse over time — the one part of the sheet that is a history rather
 * than a snapshot.
 *
 * It earns its place because a single hit rate cannot be acted on: the first
 * reply after anything changes is cold by definition, so one number cannot
 * distinguish a prompt that is never reused from one that was rebuilt a moment
 * ago. The trend can, and it is scoped to the setup that produced it — a reply
 * measured against a different prefix says nothing about this one, so it is
 * counted and set aside rather than averaged in.
 */
function trendSection(trend, { scopeLabel = null, dropped = 0 } = {}) {
  // Nothing measured here and nothing measured anywhere else in this chat: the
  // sheet stays quiet about caching rather than printing a zero the reader
  // would have to read as a failure.
  if (!trend.total && !trend.otherSamples) return "";

  const where = scopeLabel ? `For this chat, under ${scopeLabel}.` : "For this chat.";
  const body = [note(`${where} ${coverageSentence(trend)}`)];
  if (trend.measured) {
    body.push(trendChart(trend));
    body.push(note(readingSentence(trend)));
  }
  if (trend.otherSamples) body.push(note(otherSetupSentence(trend)));
  if (dropped > 0) {
    body.push(note(`Showing the ${trend.total} most recent replies under this setup.`));
  }
  return (
    `<section class="rp-ledger__group">` +
    `<h3 class="rp-ledger__group-title">Cache reuse over time</h3>` +
    body.join("") +
    `</section>`
  );
}

export function renderContextPanel({
  request,
  usage = null,
  windowLearned = false,
  samples = [],
  scope = "",
  scopeLabel = null,
  pruned = null,
} = {}) {
  if (!request) return "";
  const b = request.breakdown || {};
  const summary = contextSummary(request);
  const percent = (n) => `${Math.round((Number(n) || 0) * 100)}%`;
  // The trend for the setup in force right now. History under any other setup is
  // reported by the section itself and never mixed into these figures.
  const trend = usageTrend(samples, scope, { dropped: pruned ? pruned[scope] : 0 });

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
  // A report saved before the total-volume rename carries `billedInput` only.
  // Both names mean the same figure, so an older chat keeps showing it.
  const reportedInput = typeof usage?.totalInput === "number" ? usage.totalInput : usage?.billedInput;
  if (usage && usage.reported) {
    if (typeof reportedInput === "number") {
      provider.push(row("Input reported", formatTokens(reportedInput), "total input tokens the provider reported for the last reply; cache reads and writes can have different prices"));
    }
    if (usage.overhead > 0) provider.push(addedByProvider(usage.overhead));
    if (usage.cachedTokens > 0) {
      provider.push(row("Served from cache", percent(usage.cacheHitRate), "share of reported input read from cache; pricing depends on your provider"));
    } else if (usage.cachedTokens === 0 && (reportedInput || 0) >= 2000) {
      // A measured zero on a prompt long enough to have been cacheable. The app
      // cannot say *why* — the prompt may have changed since the last message,
      // the provider's copy may have expired, or the provider may not cache at
      // all — so it reports what it measured and leaves the cause open rather
      // than asserting one.
      provider.push(
        row(
          "Served from cache",
          "none",
          "the provider reported no cache reads for this reply; the prompt may have changed, its cached copy may have expired, or caching may be unavailable"
        )
      );
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

  // The group is named for what it is: the last reply, not the next request.
  // Everything else on the sheet is a forecast; these rows are the only
  // measurement, and the trend below them is what turns one measurement into
  // something a reader can act on.
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
    group("From your provider — your last reply", provider) +
    trendSection(trend, { scopeLabel, dropped: trend.dropped })
  );
}
