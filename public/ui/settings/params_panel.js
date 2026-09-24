// Parameters panel: every sampler and context slider, with live readouts.
//
// Contract
//   - `mountParamsPanel(root, options)` owns the Parameters tab. Every query
//     is scoped to `root`. Options:
//       getParams()        -> the settings object holding the numeric values
//       saveParams(patch)  -> persist a partial settings object
//       host               -> optional toast host
//   - Each slider is paired with its readout through `data-*` attributes in
//     the markup, so adding a parameter is a markup change plus one row in the
//     spec table below, not a new listener block.
//   - Returns `{ refresh, destroy }`.
//
// Exports
//   mountParamsPanel(root, options) -> { refresh, destroy }
//   PARAM_SPECS  the slider id / readout id / settings key triples

import { qs } from "../dom.js";

// sliderId -> { readoutId, key, format }
export const PARAM_SPECS = [
  { slider: "popup-slider-temp", readout: "popup-val-temp", key: "temperature", fallback: 0.95, decimals: 2 },
  { slider: "popup-slider-topp", readout: "popup-val-topp", key: "topP", fallback: 1, decimals: 2 },
  { slider: "popup-slider-minp", readout: "popup-val-minp", key: "minP", fallback: 0, decimals: 2 },
  { slider: "popup-slider-tokens", readout: "popup-val-tokens", key: "maxTokens", fallback: 1200, decimals: 0 },
  { slider: "popup-slider-freq", readout: "popup-val-freq", key: "frequencyPenalty", fallback: 0, decimals: 2 },
  { slider: "popup-slider-pres", readout: "popup-val-pres", key: "presencePenalty", fallback: 0, decimals: 2 },
  { slider: "popup-slider-context", readout: "popup-val-context", key: "maxContextTokens", fallback: 65536, decimals: 0 },
];

function formatValue(value, decimals) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? "");
  return decimals > 0 ? number.toFixed(decimals) : String(Math.round(number));
}

export function mountParamsPanel(root, { getParams, saveParams, host } = {}) {
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

  for (const row of rows) {
    const handler = () => paint(row);
    row.sliderEl.addEventListener("input", handler);
    cleanups.push(() => row.sliderEl.removeEventListener("input", handler));
  }

  function refresh() {
    const settings = getParams?.() || {};
    for (const row of rows) {
      const value = settings[row.key] ?? row.fallback;
      row.sliderEl.value = value;
      paint(row);
    }
  }

  const saveBtn = qs(root, "#popup-save-params-btn");
  const status = qs(root, "#popup-params-status");
  const onSave = () => {
    const patch = {};
    for (const row of rows) {
      patch[row.key] = row.decimals > 0 ? parseFloat(row.sliderEl.value) : parseInt(row.sliderEl.value, 10);
    }
    saveParams?.(patch);
    if (status) status.textContent = "Generation parameters saved.";
    host?.toast?.("Generation parameters saved.", { tone: "success" });
  };
  if (saveBtn) {
    saveBtn.addEventListener("click", onSave);
    cleanups.push(() => saveBtn.removeEventListener("click", onSave));
  }

  return {
    refresh,
    destroy() {
      for (const off of cleanups) off();
    },
  };
}
