// Tabs: the WAI-ARIA APG tabs pattern, one implementation.
//
// Contract
//   - Markup: a `[role="tablist"]` holding `[role="tab"]` buttons, plus one
//     `[role="tabpanel"]` per tab. Each tab points at its panel with
//     `aria-controls`; each panel points back with `aria-labelledby`.
//   - `initTabs(tablist, { activation })` wires roles, ids, roving tabindex
//     and the keyboard model. `activation` is `"auto"` (default: arrow keys
//     select as they move) or `"manual"` (arrow keys move focus only; Enter
//     or Space selects).
//   - Keys: ArrowLeft/ArrowRight move between tabs, Home and End jump to the
//     ends, Enter and Space select in manual mode. Disabled tabs are skipped.
//   - Returns `{ select, destroy, activeTab }`. `select(idOrIndex)` is for
//     programmatic changes such as a URL parameter.
//
// Exports
//   initTabs(tablist, options) -> controller

let tabCounter = 0;

// Tabs are discovered by role OR by the shared class, because the caller may
// hand us markup before `role="tab"` has been applied.
function tabsOf(tablist) {
  const found = tablist.querySelectorAll('[role="tab"], .rp-tab');
  return Array.from(found).filter(
    (tab) => !tab.hasAttribute("disabled") && tab.getAttribute("aria-disabled") !== "true"
  );
}

function panelFor(tab, tablist) {
  const id = tab.getAttribute("aria-controls");
  if (id) {
    const found = document.getElementById(id);
    if (found) return found;
  }
  return null;
}

/**
 * Initialises one tablist. The panels may live outside the tablist; they are
 * resolved through `aria-controls`.
 */
export function initTabs(tablist, { activation = "auto" } = {}) {
  if (!tablist) {
    return { select: () => {}, destroy: () => {}, activeTab: () => null };
  }

  const group = `rp-tabs-${++tabCounter}`;
  tablist.setAttribute("role", "tablist");
  if (!tablist.hasAttribute("aria-orientation")) {
    tablist.setAttribute("aria-orientation", "horizontal");
  }

  const tabs = tabsOf(tablist);
  const panels = [];

  tabs.forEach((tab, index) => {
    if (!tab.id) tab.id = `${group}-tab-${index}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("tabindex", "-1");
    const panel = panelFor(tab, tablist);
    if (panel) {
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tab.id);
      if (!panel.id) panel.id = `${group}-panel-${index}`;
      tab.setAttribute("aria-controls", panel.id);
      panel.setAttribute("tabindex", "0");
      panels.push(panel);
    }
  });

  const enabled = tabsOf(tablist);
  if (enabled.length === 0) {
    return { select: () => {}, destroy: () => {}, activeTab: () => null };
  }

  let currentIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.getAttribute("aria-selected") === "true")
  );
  if (tabs[currentIndex] && !enabled.includes(tabs[currentIndex])) currentIndex = 0;

  function render(focusTab) {
    tabs.forEach((tab, index) => {
      const selected = index === currentIndex;
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.classList.toggle("is-active", selected);
      // Roving tabindex: only the selected tab is in the page tab order.
      tab.setAttribute("tabindex", selected ? "0" : "-1");
      const panel = panelFor(tab, tablist);
      if (panel) {
        panel.hidden = !selected;
        panel.classList.toggle("is-active", selected);
      }
      if (selected && focusTab) tab.focus();
    });
  }

  function move(delta) {
    const order = tabs.filter((tab) => enabled.includes(tab));
    const at = order.indexOf(tabs[currentIndex]);
    const next = order[(at + delta + order.length) % order.length];
    currentIndex = tabs.indexOf(next);
    if (activation === "auto") render(true);
    else {
      // Manual activation: focus moves, selection waits for Enter or Space.
      for (const tab of tabs) tab.setAttribute("tabindex", tab === next ? "0" : "-1");
      next.focus();
    }
  }

  function onKeydown(event) {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Home":
        event.preventDefault();
        currentIndex = tabs.indexOf(enabled[0]);
        if (activation === "auto") render(true);
        else {
          for (const tab of tabs) tab.setAttribute("tabindex", tab === enabled[0] ? "0" : "-1");
          enabled[0].focus();
        }
        break;
      case "End":
        event.preventDefault();
        currentIndex = tabs.indexOf(enabled[enabled.length - 1]);
        if (activation === "auto") render(true);
        else {
          for (const tab of tabs) tab.setAttribute("tabindex", tab === enabled[enabled.length - 1] ? "0" : "-1");
          enabled[enabled.length - 1].focus();
        }
        break;
      case "Enter":
      case " ":
        if (activation === "manual") {
          event.preventDefault();
          currentIndex = tabs.indexOf(event.target.closest('[role="tab"]'));
          render(true);
        }
        break;
      default:
        break;
    }
  }

  function onFocusIn(event) {
    if (activation !== "auto") return;
    const tab = event.target.closest?.('[role="tab"]');
    if (!tab || !tabs.includes(tab)) return;
    if (tabs.indexOf(tab) !== currentIndex) {
      currentIndex = tabs.indexOf(tab);
      render(false);
    }
  }

  function onClick(event) {
    const tab = event.target.closest?.('[role="tab"]');
    if (!tab || !tabs.includes(tab)) return;
    currentIndex = tabs.indexOf(tab);
    render(false);
  }

  tablist.addEventListener("keydown", onKeydown);
  tablist.addEventListener("focusin", onFocusIn);
  tablist.addEventListener("click", onClick);
  render(false);

  return {
    /**
     * Selects a tab by index, element id, `data-tab` value, or the id of the
     * panel it controls. Panel-id matching is what the URL handoff uses.
     */
    select(target) {
      let index = -1;
      if (typeof target === "number") index = target;
      else if (typeof target === "string")
        index = tabs.findIndex(
          (tab) => tab.id === target || tab.dataset.tab === target || tab.getAttribute("aria-controls") === target
        );
      else if (target instanceof Element) index = tabs.indexOf(target);
      if (index < 0 || index >= tabs.length || !enabled.includes(tabs[index])) return false;
      currentIndex = index;
      render(false);
      return true;
    },
    /** The currently selected tab element, or null. */
    activeTab() {
      return tabs[currentIndex] || null;
    },
    destroy() {
      tablist.removeEventListener("keydown", onKeydown);
      tablist.removeEventListener("focusin", onFocusIn);
      tablist.removeEventListener("click", onClick);
    },
  };
}
