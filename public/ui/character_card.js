// Character card domain logic. No DOM, no storage, no globals.
//
// Contract
//   - Every function is pure: given the same input it returns the same output
//     and touches nothing outside its arguments. This is what makes the
//     catalogue filter, sort and duplicate rules testable in isolation.
//   - A "card" is the stored record: `{ id, avatar?, data?: {...} }` with the
//     CCv1/v2/v3 fields either under `data` or at the root. `fields(card)`
//     normalises that once so no caller has to repeat the fallbacks.
//   - Tag and text handling never produces markup. Callers escape on render.
//
// Exports
//   fields(card)                  normalised view of the card's data
//   cardTitle(card)               display name, never empty
//   cardByline(card)              creator line, never empty
//   cardTags(card)                array of trimmed tag strings, never empty
//   cardAvatarUrl(card)           data/http url or ""
//   cardInitial(card)             single uppercase letter for the fallback
//   matchesQuery(card, query)     name, byline, tags and description
//   sortCards(cards, mode)        new array, "recent" or "name"
//   allTags(cards)                unique tags, most common first
//   cardFingerprint(card)         identity key for duplicate detection
//   cardContentSig(card)          content key for duplicate detection
//   findDuplicate(cards, incoming) { kind, card } | null
//   withSessions(cards, sessions) pairs cards with their sessions in one pass

const FALLBACK_TITLE = "Unknown persona";
const FALLBACK_BYLINE = "Original cast";
const FALLBACK_TAG = "Scenario";

/** The card's data object, whether the fields sit under `data` or at the root. */
export function fields(card) {
  const source = card && typeof card === "object" ? card : {};
  const data = source.data && typeof source.data === "object" ? source.data : source;
  return { card: source, data };
}

/** Trimmed display name, falling back rather than returning an empty string. */
export function cardTitle(card) {
  const { data } = fields(card);
  const name = String(data.name ?? "").trim();
  return name || FALLBACK_TITLE;
}

/** Trimmed creator line. */
export function cardByline(card) {
  const { data } = fields(card);
  const creator = String(data.creator ?? "").trim();
  return creator || FALLBACK_BYLINE;
}

/** Tags as trimmed strings; an untagged card reports the generic scenario tag. */
export function cardTags(card) {
  const { data } = fields(card);
  const raw = Array.isArray(data.tags) ? data.tags : [];
  const tags = raw.map((tag) => String(tag ?? "").trim()).filter(Boolean);
  return tags.length ? tags : [FALLBACK_TAG];
}

/**
 * A usable image source, or an empty string when the card has no portrait.
 * Only `data:image/...` and `http(s):` URLs are accepted: anything else (a
 * bare `data:` payload, a `javascript:` URL) is dropped rather than handed to
 * an `<img src>`. This is defence in depth behind the escaping in safe_html.
 */
export function cardAvatarUrl(card) {
  const { card: source, data } = fields(card);
  const url = String(source.avatar || data.avatar || "").trim();
  if (/^data:image\//i.test(url)) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return "";
}

/** The single letter shown when there is no portrait. */
export function cardInitial(card) {
  return cardTitle(card).charAt(0).toUpperCase() || "?";
}

/**
 * Avatar inner HTML for a portrait URL or a fallback letter. Accepts only
 * `data:`/`http(s):` portrait URLs; anything else renders the fallback
 * letter, escaped so it can never become markup.
 */
export function avatarInnerHtml(url, fallbackLetter) {
  const src = String(url || "").trim();
  const letter = String(fallbackLetter ?? "").trim().charAt(0).toUpperCase() || "?";
  if (/^data:image\//i.test(src) || /^https?:\/\//i.test(src)) {
    const safe = src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    return `<img src="${safe}" alt="" style="width:100%;height:100%;object-fit:cover;">`;
  }
  return letter.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The card's blurb, trimmed. May be empty; the view supplies its own copy. */
export function cardDescription(card) {
  const { data } = fields(card);
  const text = data.description || data.creator_notes || "";
  return String(text ?? "").trim();
}

/**
 * True when `query` appears in the name, byline, description or any tag.
 * An empty query matches everything. Matching is case-insensitive.
 */
export function matchesQuery(card, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return true;
  const { data } = fields(card);
  const haystack = [
    cardTitle(card),
    cardByline(card),
    cardDescription(card),
    cardTags(card).join(" "),
    String(data.personality ?? ""),
    String(data.scenario ?? ""),
  ]
    .join("\n")
    .toLowerCase();
  // Every whitespace-separated term must appear, so "gothic archivist"
  // narrows rather than widening the result set.
  return needle.split(/\s+/).every((term) => haystack.includes(term));
}

/** Sessions for one card, most recently updated first. */
function sessionsByRecency(sessions) {
  return [...sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * Sorts a copy of `cards`.
 *   "recent" most recently chatted first, then by name; cards without a
 *            session sort after those that have one.
 *   "name"   locale-aware title order.
 * `sessionCount` and `lastUpdated` are read from the card when present (see
 * `withSessions`), so the comparator stays a pure function of its inputs.
 */
export function sortCards(cards, mode = "recent") {
  const copy = [...cards];
  if (mode === "name") {
    return copy.sort((a, b) => cardTitle(a).localeCompare(cardTitle(b), undefined, { sensitivity: "base" }));
  }
  return copy.sort((a, b) => {
    const aTime = a.lastUpdated || 0;
    const bTime = b.lastUpdated || 0;
    if (bTime !== aTime) return bTime - aTime;
    return cardTitle(a).localeCompare(cardTitle(b), undefined, { sensitivity: "base" });
  });
}

/** Unique tags across `cards`, ordered by how many cards carry them. */
export function allTags(cards) {
  const counts = new Map();
  for (const card of cards) {
    for (const tag of cardTags(card)) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

/** Name-only identity key used by duplicate detection. */
export function cardFingerprint(card) {
  return cardTitle(card).trim().toLowerCase();
}

/** Name plus opening-scene key: identical content imports twice identically. */
export function cardContentSig(card) {
  const { data } = fields(card);
  return [cardTitle(card).trim(), String(data.first_mes ?? "").trim().slice(0, 200)].join("\u0000");
}

/**
 * Classifies an incoming card against the existing set.
 *   { kind: "exact" }   same name and same opening scene
 *   { kind: "similar" } same name, different content (a likely update)
 *   null                no name collision
 */
export function findDuplicate(cards, incoming) {
  const name = cardFingerprint(incoming);
  const sig = cardContentSig(incoming);
  const exact = cards.find((card) => cardFingerprint(card) === name && cardContentSig(card) === sig);
  if (exact) return { kind: "exact", card: exact };
  const similar = cards.find((card) => cardFingerprint(card) === name);
  if (similar) return { kind: "similar", card: similar };
  return null;
}

/**
 * Pairs cards with their sessions in a single pass over `sessions`, so the
 * catalogue never issues one query per card. Returns a new array of shallow
 * copies carrying `sessions`, `sessionCount`, `latestSession` and
 * `lastUpdated`, which is what `sortCards` and the view read.
 */
export function withSessions(cards, sessions) {
  const byCard = new Map();
  for (const session of sessions || []) {
    if (!session || !session.cardId) continue;
    const bucket = byCard.get(session.cardId);
    if (bucket) bucket.push(session);
    else byCard.set(session.cardId, [session]);
  }
  return cards.map((card) => {
    const owned = byCard.get(card.id) || [];
    const ordered = sessionsByRecency(owned);
    const latest = ordered[0] || null;
    return {
      ...card,
      sessions: ordered,
      sessionCount: ordered.length,
      latestSession: latest,
      lastUpdated: latest ? latest.updatedAt || 0 : 0,
    };
  });
}
