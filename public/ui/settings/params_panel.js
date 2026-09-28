// Parameters panel: every sampler and context slider, with live readouts.
//
// Contract
//   - `mountParamsPanel(root, options)` owns the Parameters tab. Every query
//     is scoped to `root`. Options:
//       getParams()        -> the settings object holding the numeric values
//       saveParams(patch)  -> persist a partial settings object
//   - Each slider is paired with its readout through `data-*` attributes in
//     the markup, so adding a parameter is a markup change plus one row in the
//     spec table below, not a new listener block.
//   - A slider commits on `change`, i.e. when the value settles, and the
//     readout follows the drag on `input`. Both numbers here decide what the
//     very next request can carry — the reply ceiling is a reservation taken
//     out of the window before history is sized, and the context budget is the
//     window itself — so a control that only took effect after a separate
//     confirmation would describe a request the app is not building. The
//     markup default is the only default: `refresh` writes a value only when
//     settings actually hold one, so a default cannot drift from its spec.
//   - Returns `{ refresh, destroy }`.
//
// Exports
//   mountParamsPanel(root, options) -> { refresh, destroy }
//   PARAM_SPECS  the slider id / readout id / settings key triples

import { qs } from "../dom.js";

// sliderId -> { readoutId, key, format }
export const PARAM_SPECS = [
  { slider: "popup-slider-temp", readout: "popup-val-temp", key: "temperature", decimals: 2 },
  { slider: "popup-slider-topp", readout: "popup-val-topp", key: "topP", decimals: 2 },
  { slider: "popup-slider-minp", readout: "popup-val-minp", key: "minP", decimals: 2 },
  { slider: "popup-slider-tokens", readout: "popup-val-tokens", key: "maxTokens", decimals: 0 },
  { slider: "popup-slider-freq", readout: "popup-val-freq", key: "frequencyPenalty", decimals: 2 },
  { slider: "popup-slider-pres", readout: "popup-val-pres", key: "presencePenalty", decimals: 2 },
  { slider: "popup-slider-context", readout: "popup-val-context", key: "maxContextTokens", decimals: 0 },
];

function formatValue(value, decimals) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? "");
  return decimals > 0 ? number.toFixed(decimals) : String(Math.round(number));
}

export function mountParamsPanel(root, { getParams, saveParams } = {}) {
  if (!root) return { refresh: () => {}, destroy: () => {} };

  const rows = PARAM_SPECS.map((spec) => ({
    ...spec,
    sliderEl: qs(root, `#${spec.slider}`),
    readoutEl: qs(root, `#${spec.readout}`),
  })).filter((row) => row.sliderEl);

  const cleanups = [];

  function paint(row) {
    if (row.readoutEl) row.readoutEl.textContent = formatValue(row.sliderEl.value, row.decimals);
  }

  function read(row) {
    return row.decimals > 0 ? parseFloat(row.sliderEl.value) : parseInt(row.sliderEl.value, 10);
  }

  for (const row of rows) {
    const onInput = () => paint(row);
    const onChange = () => {
      paint(row);
      saveParams?.({ [row.key]: read(row) });
    };
    row.sliderEl.addEventListener("input", onInput);
    row.sliderEl.addEventListener("change", onChange);
    cleanups.push(() => {
      row.sliderEl.removeEventListener("input", onInput);
      row.sliderEl.removeEventListener("change", onChange);
    });
  }

  function refresh() {
    const settings = getParams?.() || {};
    for (const row of rows) {
      const value = settings[row.key];
      // Leave the markup default in place when settings hold nothing for this
      // key, rather than carrying a second copy of the default in the spec.
      if (value !== undefined && value !== null) row.sliderEl.value = value;
      paint(row);
    }
  }

  return {
    refresh,
    destroy() {
      for (const off of cleanups) off();
    },
  };
}
