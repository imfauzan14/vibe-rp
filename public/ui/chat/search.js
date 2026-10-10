// In-conversation search: find text, jump between matches, highlight them.
//
// The feed renders escaped prose, so a match is highlighted by walking text
// nodes and wrapping matches in <mark>. That never re-parses markup and never
// touches the message data. Highlights are cleared before each new query.
//
// Keyboard: Enter finds the next match, Shift+Enter the previous, Escape clears
// and closes.
//
// Two things this module deliberately does NOT own:
//   - the open/closed state. Escape used to set `root.dataset.open` directly,
//     which left the toggle button advertising `aria-expanded="true"` on a panel
//     that was hidden, and focus stranded inside a `display:none` field. Closing
//     is the page's business, so it is reported through `onClose` and the page
//     moves the attribute, the button and focus together.
//   - the transcript. `container` is the rendered feed, which is capped, so the
//     page tells this module how many matches exist in the whole transcript via
//     `matchTotal` and this module reports a partial count honestly.

import { scrollIntoViewRespectingMotion } from "../dom.js";

const MARK_CLASS = "rp-search-hit";

/** Removes every highlight and restores the original text nodes. */
export function clearHighlights(container) {
  if (!container) return;
  const parents = new Set();
  for (const mark of container.querySelectorAll(`mark.${MARK_CLASS}`)) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
    parents.add(parent);
  }
  for (const parent of parents) {
    parent.normalize();
  }
}

/** Collects the text nodes under a root, skipping script and style. */
function textNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const tag = node.parentNode?.nodeName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "MARK") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const out = [];
  let n;
  while ((n = walker.nextNode())) out.push(n);
  return out;
}

/** Escapes a query for use inside a RegExp. */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Highlights every case-insensitive match of `query` inside `container`.
 * Returns the created <mark> elements in document order.
 */
export function highlight(container, query) {
  clearHighlights(container);
  const needle = String(query || "").trim();
  if (!container || !needle) return [];
  const re = new RegExp(escapeRegExp(needle), "gi");
  const marks = [];
  for (const node of textNodes(container)) {
    const text = node.nodeValue;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement("mark");
      mark.className = MARK_CLASS;
      mark.textContent = m[0];
      frag.appendChild(mark);
      marks.push(mark);
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex += 1;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
  return marks;
}

/**
 * Wires a search field to a feed container.
 *
 * @param {object} args
 * @param {HTMLInputElement} args.input
 * @param {HTMLElement} args.container   the rendered feed, which is capped
 * @param {HTMLElement} [args.countEl]   element that receives "3 of 12"
 * @param {(msg: string, info: object) => void} [args.onChange]  after each search
 * @param {() => void} [args.onClose]    the page closes the panel and moves focus
 * @param {(query: string) => number} [args.matchTotal]
 *        Occurrences across the WHOLE transcript. Without it the count describes
 *        only what happens to be rendered, and a match in an older turn is
 *        reported as absent.
 * @param {() => boolean} [args.onExpand]
 *        Renders more of the transcript. Returns false when there is nothing
 *        left to render.
 *
 * There is deliberately no `root`: this module used to write the panel's own
 * `data-open`, which is how the toggle and the panel came to disagree.
 */
export function createSearch({
  input,
  container,
  countEl = null,
  onChange = () => {},
  onClose = null,
  matchTotal = null,
  onExpand = null,
}) {
  if (!input || !container) throw new Error("createSearch needs an input and a container");
  let marks = [];
  let index = -1;
  let shown = 0;
  let total = 0;

  const totalFor = (query) => {
    if (typeof matchTotal !== "function") return null;
    try {
      const n = matchTotal(query);
      return Number.isFinite(n) ? n : null;
    } catch (_) {
      return null;
    }
  };

  /**
   * The count line. When the transcript holds more than the rendered window,
   * it says so — the alternative is the old behaviour, where a match in an
   * older turn was reported as no match at all.
   */
  function setCount() {
    if (!countEl) return;
    const query = input.value.trim();
    if (!query) {
      countEl.textContent = "";
      return;
    }
    if (!total) {
      countEl.textContent = "No matches";
      return;
    }
    const partial = shown < total ? ` (${shown} loaded)` : "";
    countEl.textContent = `${index + 1} of ${total}${partial}`;
  }

  function focusIndex(next) {
    marks.forEach((m, i) => m.classList.toggle("is-current", i === next));
    const target = marks[next];
    if (target) scrollIntoViewRespectingMotion(target, { block: "center", behavior: "smooth" });
  }

  function run({ announce = true } = {}) {
    const query = input.value;
    marks = highlight(container, query);
    shown = marks.length;
    const known = totalFor(query);
    total = known === null ? marks.length : known;
    index = marks.length ? 0 : -1;
    if (index >= 0) focusIndex(index);
    setCount();
    if (announce) {
      const trimmed = query.trim();
      let msg;
      if (!trimmed) msg = "Search cleared.";
      else if (!total) msg = "No matches found.";
      else if (shown < total) {
        msg = `${total} match${total === 1 ? "" : "es"} found, ${shown} shown. Press Enter to load older ones.`;
      } else {
        msg = `${total} match${total === 1 ? "" : "es"} found.`;
      }
      onChange(msg, { count: total, shown });
    }
    return total;
  }

  /**
   * Moves through the matches. When the reader walks past the last rendered
   * match but the transcript holds more, one more slice of history is rendered
   * and the search re-runs, so Next keeps working instead of wrapping.
   */
  function step(delta) {
    if (!marks.length) return run();
    const last = marks.length - 1;
    const atEdge = delta > 0 ? index === last : index === 0;
    if (atEdge && shown < total && typeof onExpand === "function") {
      let grew = false;
      try {
        grew = onExpand() !== false;
      } catch (_) {
        grew = false;
      }
      if (grew) {
        const previousIndex = index;
        run({ announce: false });
        // Keep the reader where they were, then step from there.
        index = Math.max(0, Math.min(previousIndex, marks.length - 1));
      }
    }
    if (!marks.length) return 0;
    index = (index + delta + marks.length) % marks.length;
    focusIndex(index);
    setCount();
    return marks.length;
  }

  const next = () => step(1);
  const prev = () => step(-1);

  function clear() {
    clearHighlights(container);
    marks = [];
    index = -1;
    shown = 0;
    total = 0;
    setCount();
  }

  input.addEventListener("input", () => run());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) prev();
      else next();
    } else if (e.key === "Escape") {
      e.preventDefault();
      clear();
      // Closing is the page's business: it owns the panel's `data-open`, the
      // toggle's `aria-expanded` and where focus goes. Writing `data-open` here
      // left the button claiming the panel was still open and focus stranded in
      // a hidden field, so the module reports the intent and nothing else.
      onClose?.();
      onChange("Search closed.", { count: 0 });
    }
  });

  return {
    run,
    next,
    prev,
    clear,
    get marks() { return marks; },
    get index() { return index; },
    /** Matches across the whole transcript, as opposed to `marks.length`. */
    get total() { return total; },
  };
}
