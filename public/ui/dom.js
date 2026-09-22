// Small DOM helpers shared by the ui modules.
//
// Contract
//   - No global state, no document-level listeners, no innerHTML with data.
//   - `text` always lands as a text node, so card content can never become
//     markup. Anything that must be markup is built from elements instead.
//
// Exports
//   el(tag, props, children)   create an element; props.text sets textContent
//   qs(root, selector)         first match, or null
//   qsa(root, selector)        array of matches (never a live NodeList)
//   delegate(root, type, selector, handler, options)  one listener per root
//   renderKeyed(container, items, keyOf, renderItem)  reuse nodes by key
//   isVisible(node)            true when the node has layout boxes

/**
 * Creates an element.
 * `props` supports `class`, `text`, `html` (trusted markup only), `dataset`,
 * `attrs`, `style`, and any other property assigned directly.
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "attrs") for (const [k, v] of Object.entries(value)) {
      if (v === false || v === null || v === undefined) node.removeAttribute(k);
      else node.setAttribute(k, v === true ? "" : String(v));
    } else if (key === "style") Object.assign(node.style, value);
    else node[key] = value;
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** First match inside `root`, or null. */
export function qs(root, selector) {
  return root ? root.querySelector(selector) : null;
}

/** Every match inside `root`, as an array. */
export function qsa(root, selector) {
  return root ? Array.from(root.querySelectorAll(selector)) : [];
}

/**
 * One listener on `root` for every match of `selector`, including matches that
 * are added later. Returns a function that removes the listener.
 */
export function delegate(root, type, selector, handler, options) {
  if (!root) return () => {};
  const listener = (event) => {
    const target = event.target instanceof Element ? event.target.closest(selector) : null;
    if (target && root.contains(target)) handler(event, target);
  };
  root.addEventListener(type, listener, options);
  return () => root.removeEventListener(type, listener, options);
}

/** True when the node currently has layout boxes (so it can take focus). */
export function isVisible(node) {
  return Boolean(node && node.getClientRects().length);
}

/** The elements inside `root` that can hold focus, in tab order. */
export function focusables(root) {
  if (!root) return [];
  return qsa(
    root,
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), ' +
      'select:not([disabled]), details > summary, [tabindex]:not([tabindex="-1"])'
  ).filter((node) => !node.hasAttribute("inert") && isVisible(node));
}

/**
 * Renders `items` into `container`, reusing the node already keyed with the
 * same id instead of rebuilding the list. `renderItem(item, existingNode)`
 * returns the node for that item, updating `existingNode` in place when it is
 * given. Nodes whose key is gone from `items` are removed.
 */
export function renderKeyed(container, items, keyOf, renderItem, keyAttribute = "data-key") {
  if (!container) return;
  const existing = new Map();
  for (const child of Array.from(container.children)) {
    const key = child.getAttribute(keyAttribute);
    // A child with no key was not produced by this renderer (an empty state,
    // a placeholder). It can never be reused, so it is removed here rather
    // than left to linger beside the keyed rows.
    if (key === null) child.remove();
    else existing.set(key, child);
  }

  let previous = null;
  const used = new Set();
  for (const item of items) {
    const key = String(keyOf(item));
    let node = existing.get(key) || null;
    if (node) existing.delete(key);
    node = renderItem(item, node);
    if (!node) continue;
    node.setAttribute(keyAttribute, key);
    // Move only when the node is out of position, so untouched rows keep
    // their focus, selection and scroll position.
    const expectedNext = previous ? previous.nextSibling : container.firstChild;
    if (node !== expectedNext) container.insertBefore(node, expectedNext);
    previous = node;
    used.add(key);
  }

  for (const [key, node] of existing) {
    if (!used.has(key)) node.remove();
  }
}
