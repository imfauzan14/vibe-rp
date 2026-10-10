// A minimal DOM, just enough to drive a real UI module in a test.
//
// The repo has no DOM library and no browser in its test runner, so the
// presentation layer has only ever been guarded by reading its source text —
// which cannot tell whether a control actually behaves. This shim is the
// smallest surface that lets `choice_panel.js` run for real: element creation,
// attributes, classList, children, event dispatch, and the two selectors the
// panel uses (a tag name, and `[attr]`).
//
// It is deliberately not a browser. Anything the panel does not touch is not
// implemented, so an accidental dependency on a missing API fails loudly here
// rather than passing by accident.

export class ShimNode {
  tagName: string;
  children: ShimNode[] = [];
  parentNode: ShimNode | null = null;
  attributes: Record<string, string> = {};
  listeners: Record<string, Array<(event: any) => void>> = {};
  dataset: Record<string, string> = {};
  style: Record<string, unknown> & { cssText?: string } = {};
  textContent = "";
  innerHTML = "";
  value = "";
  type = "";
  title = "";
  disabled = false;
  hidden = false;
  isContentEditable = false;
  focused = false;

  constructor(tagName: string) {
    this.tagName = String(tagName).toUpperCase();
  }

  get className(): string {
    return this.attributes.class ?? "";
  }
  set className(next: string) {
    this.attributes.class = String(next);
  }

  get classList() {
    const has = (name: string) => this.className.split(/\s+/).filter(Boolean).includes(name);
    return {
      add: (name: string) => {
        if (!has(name)) this.className = [...this.className.split(/\s+/).filter(Boolean), name].join(" ");
      },
      remove: (name: string) => {
        this.className = this.className.split(/\s+/).filter((c) => c && c !== name).join(" ");
      },
      contains: has,
      toggle: (name: string) => (has(name) ? (this.classList.remove(name), false) : (this.classList.add(name), true)),
    };
  }

  get firstChild(): ShimNode | null {
    return this.children[0] ?? null;
  }

  get nextSibling(): ShimNode | null {
    const siblings = this.parentNode?.children ?? [];
    const index = siblings.indexOf(this);
    return index >= 0 ? (siblings[index + 1] ?? null) : null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
    if (name === "hidden") this.hidden = true;
  }
  getAttribute(name: string): string | null {
    return name in this.attributes ? this.attributes[name] : null;
  }
  hasAttribute(name: string): boolean {
    return name in this.attributes;
  }
  removeAttribute(name: string): void {
    delete this.attributes[name];
    if (name === "hidden") this.hidden = false;
  }

  append(...nodes: ShimNode[]): void {
    for (const node of nodes) {
      if (!node) continue;
      node.parentNode?.removeChild(node);
      node.parentNode = this;
      this.children.push(node);
    }
  }
  appendChild(node: ShimNode): ShimNode {
    this.append(node);
    return node;
  }
  removeChild(node: ShimNode): void {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentNode = null;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  replaceChildren(...nodes: ShimNode[]): void {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  insertBefore(node: ShimNode, reference: ShimNode | null): void {
    if (!reference) return this.append(node);
    const index = this.children.indexOf(reference);
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
  }

  addEventListener(type: string, handler: (event: any) => void): void {
    (this.listeners[type] ||= []).push(handler);
  }
  removeEventListener(type: string, handler: (event: any) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((h) => h !== handler);
  }
  /** Fires a listener set directly, for a test driving the control. */
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const handler of this.listeners[type] ?? []) {
      handler({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
    }
  }
  focus(): void {
    this.focused = true;
    (globalThis as any).document.activeElement = this;
  }
  getClientRects(): unknown[] {
    return [{}];
  }

  /** True when this node matches a simple selector: `tag`, `.class` or `[attr]`. */
  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const sel = part.trim();
      if (!sel) return false;
      if (sel.startsWith("[")) {
        const name = sel.slice(1, sel.endsWith("]") ? -1 : undefined).split("=")[0].trim();
        return this.hasAttribute(name);
      }
      if (sel.startsWith(".")) return this.classList.contains(sel.slice(1));
      return this.tagName === sel.toUpperCase();
    });
  }

  private descendants(): ShimNode[] {
    const out: ShimNode[] = [];
    for (const child of this.children) {
      out.push(child, ...child.descendants());
    }
    return out;
  }
  querySelector(selector: string): ShimNode | null {
    return this.descendants().find((node) => node.matches(selector)) ?? null;
  }
  querySelectorAll(selector: string): ShimNode[] {
    return this.descendants().filter((node) => node.matches(selector));
  }
  closest(selector: string): ShimNode | null {
    let node: ShimNode | null = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
}

export interface ShimDocument extends ShimNode {
  createElement(tag: string): ShimNode;
  activeElement: ShimNode | null;
}

/** Installs the shim as `document`/`window` and returns the document root. */
export function installDom(): ShimDocument {
  const doc = new ShimNode("document") as ShimDocument;
  doc.createElement = (tag: string) => new ShimNode(tag);
  doc.activeElement = null;
  (globalThis as any).document = doc;
  (globalThis as any).window = {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  return doc;
}

/** Dispatches a bubbling-style click from `node`, reaching ancestors' handlers. */
export function click(node: ShimNode): void {
  let current: ShimNode | null = node;
  while (current) {
    const handled = (current.listeners.click ?? []).length > 0;
    // `target` stays the clicked node while the handler runs on the ancestor,
    // which is what delegation (`event.target.closest(...)`) reads.
    current.dispatch("click", { target: node });
    if (handled) return;
    current = current.parentNode;
  }
}
