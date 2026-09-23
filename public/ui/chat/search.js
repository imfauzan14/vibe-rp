// In-conversation search: find text, jump between matches, highlight them.
//
// The feed renders escaped prose, so a match is highlighted by walking text
// nodes and wrapping matches in <mark>. That never re-parses markup and never
// touches the message data. Highlights are cleared before each new query.
//
// Keyboard: Enter finds the next match, Shift+Enter the previous, Escape clears
// and closes.

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
 * @param {HTMLElement} args.container   the feed root whose text is searched
 * @param {HTMLElement} [args.countEl]   element that receives "3 of 12"
 * @param {HTMLElement} [args.root]      panel wrapper, gets data-open
 * @param {() => void} [args.onChange]   called after each search
 */
export function createSearch({ input, container, countEl = null, root = null, onChange = () => {} }) {
  if (!input || !container) throw new Error("createSearch needs an input and a container");
  let marks = [];
  let index = -1;

  function setCount(text) {
    if (countEl) countEl.textContent = text;
  }

  function focusIndex(next) {
    marks.forEach((m, i) => m.classList.toggle("is-current", i === next));
    const target = marks[next];
    if (target) {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function run({ announce = true } = {}) {
    const query = input.value;
    marks = highlight(container, query);
    index = marks.length ? 0 : -1;
    if (index >= 0) focusIndex(index);
    setCount(marks.length ? `${index + 1} of ${marks.length}` : query.trim() ? "No matches" : "");
    if (announce) {
      const msg = !query.trim()
        ? "Search cleared."
        : marks.length
          ? `${marks.length} match${marks.length === 1 ? "" : "es"} found.`
          : "No matches found.";
      onChange(msg, { count: marks.length });
    }
    return marks.length;
  }

  function next() {
    if (!marks.length) return run();
    index = (index + 1) % marks.length;
    focusIndex(index);
    setCount(`${index + 1} of ${marks.length}`);
    return marks.length;
  }

  function prev() {
    if (!marks.length) return run();
    index = (index - 1 + marks.length) % marks.length;
    focusIndex(index);
    setCount(`${index + 1} of ${marks.length}`);
    return marks.length;
  }

  function clear() {
    clearHighlights(container);
    marks = [];
    index = -1;
    setCount("");
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
      if (root) root.dataset.open = "false";
      onChange("Search closed.", { count: 0 });
    }
  });

  return { run, next, prev, clear, get marks() { return marks; }, get index() { return index; } };
}
