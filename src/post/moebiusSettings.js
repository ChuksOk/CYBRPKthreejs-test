import * as THREE from "three/webgpu";

/**
 * Player tuning + visual presets for the Moebius comic style
 * (src/tsl/moebius.js). Everything maps straight onto the style's uniforms,
 * so changes are live (no shader rebuild). Values persist in localStorage;
 * "Arzach" (the default) is whatever the shader ships with.
 */

const STORAGE_KEY = "threejs-punk-moebius";

const num = (digits) => (v) => Number(v).toFixed(digits);
const pct = (v) => `${Math.round(v * 100)}%`;

/** Tunable options, grouped for the Settings panel. */
export const MOEBIUS_OPTIONS = [
  { group: "Lines", key: "lineWidth", label: "Line width", min: 0.6, max: 2.5, step: 0.05, format: num(2) },
  { group: "Lines", key: "lineThickRadius", label: "Near line thickness", min: 1, max: 4, step: 0.1, format: num(1) },
  { group: "Lines", key: "lineThickFar", label: "Thick lines reach", min: 5, max: 60, step: 1, format: (v) => `${Math.round(v)} m` },
  { group: "Lines", key: "lineFadeEnd", label: "Line fade distance", min: 40, max: 300, step: 5, format: (v) => `${Math.round(v)} m` },
  { group: "Lines", key: "lineFarOpacity", label: "Far line strength", min: 0, max: 1, step: 0.01, format: pct },
  { group: "Lines", key: "depthEdge", label: "Silhouette threshold", min: 0.015, max: 0.12, step: 0.005, format: num(3) },
  { group: "Lines", key: "colorEdge", label: "Detail line threshold", min: 0.08, max: 0.7, step: 0.01, format: num(2) },
  { group: "Lines", key: "glowOutline", label: "Laser / neon outline", min: 0, max: 1, step: 0.01, format: pct },
  { group: "Tone", key: "bands", label: "Tone bands", min: 2, max: 8, step: 1, format: (v) => String(Math.round(v)) },
  { group: "Tone", key: "exposure", label: "Exposure", min: 0.7, max: 1.8, step: 0.01, format: num(2) },
  { group: "Tone", key: "lift", label: "Shadow lift", min: 0, max: 0.25, step: 0.005, format: num(3) },
  { group: "Tone", key: "saturation", label: "Saturation", min: 0, max: 3, step: 0.05, format: num(2) },
  { group: "Tone", key: "paletteMixGrey", label: "Palette strength", min: 0, max: 1, step: 0.01, format: pct },
  { group: "Tone", key: "splitTone", label: "Warm / cool split", min: 0, max: 1, step: 0.01, format: pct },
  { group: "Tone", key: "bloomAmount", label: "Neon glow", min: 0, max: 1.6, step: 0.02, format: num(2) },
  { group: "Texture", key: "hatchStrength", label: "Hatching", min: 0, max: 1, step: 0.01, format: pct },
  { group: "Texture", key: "hatchSpacing", label: "Hatch spacing", min: 3, max: 14, step: 0.5, format: (v) => `${Number(v).toFixed(1)} px` },
  { group: "Texture", key: "hazeAmount", label: "Distance haze", min: 0, max: 1, step: 0.01, format: pct },
  { group: "Texture", key: "paperAmount", label: "Paper tint", min: 0, max: 0.6, step: 0.01, format: pct },
  { group: "Palette", key: "ink", label: "Ink", type: "color" },
  { group: "Palette", key: "shadow", label: "Deep shadow", type: "color" },
  { group: "Palette", key: "shadow2", label: "Shadow", type: "color" },
  { group: "Palette", key: "mid", label: "Midtone", type: "color" },
  { group: "Palette", key: "light", label: "Light", type: "color" },
  { group: "Palette", key: "highlight", label: "Highlight", type: "color" },
  { group: "Palette", key: "haze", label: "Haze", type: "color" },
  { group: "Palette", key: "skyTop", label: "Sky top", type: "color" },
  { group: "Palette", key: "skyMid", label: "Sky middle", type: "color" },
  { group: "Palette", key: "skyHorizon", label: "Horizon", type: "color" },
];

/** Visual presets: partial overrides of the shipped (Arzach) values. */
export const MOEBIUS_PRESETS = [
  { id: "arzach", label: "Arzach", hint: "Full-colour Moebius (default)", values: {} },
  {
    id: "pastel",
    label: "Pastel",
    hint: "Soft desert pastels, paper wash",
    values: {
      saturation: 1.35, paletteMixGrey: 0.5, splitTone: 0.25, exposure: 1.28, lift: 0.08,
      hazeAmount: 0.45, paperAmount: 0.32, bloomAmount: 0.55, hatchStrength: 0.45,
      shadow: "#2e5470", shadow2: "#6e6aa8", mid: "#d08a73", light: "#eccf98", highlight: "#fff1d6",
      haze: "#f2c9a6", skyTop: "#7fc4c8", skyMid: "#b9c9d8", skyHorizon: "#f7d9a6",
    },
  },
  {
    id: "noir",
    label: "Ink Noir",
    hint: "Black & white ink, heavy hatching",
    values: {
      saturation: 0.15, paletteMixGrey: 0.85, splitTone: 0, bands: 3, exposure: 1.1, lift: 0.03,
      hatchStrength: 0.85, hatchSpacing: 5, lineWidth: 1.4, lineThickRadius: 3, lineFarOpacity: 0.45,
      hazeAmount: 0.3, paperAmount: 0.3, bloomAmount: 0.4,
      ink: "#0d0c0b", shadow: "#141414", shadow2: "#2e2e2e", mid: "#8c8a86", light: "#d9d5ca", highlight: "#fbf8ee",
      haze: "#d2cdc2", skyTop: "#e6e2d8", skyMid: "#dcd6c9", skyHorizon: "#f2eee4",
    },
  },
  {
    id: "pulp",
    label: "Sunset Pulp",
    hint: "Hot magentas and oranges",
    values: {
      saturation: 2.3, splitTone: 0.6, paletteMixGrey: 0.72, exposure: 1.18,
      shadow: "#3b0a5a", shadow2: "#a0185e", mid: "#ff5a1f", light: "#ffc233", highlight: "#fff3d6",
      haze: "#ff7a8a", skyTop: "#2b1b6b", skyMid: "#d2359a", skyHorizon: "#ffb03a",
    },
  },
  {
    id: "neon",
    label: "Neon Night",
    hint: "Teal / magenta cyberpunk comic",
    values: {
      saturation: 2.2, exposure: 1.08, lift: 0.03, bloomAmount: 1.05, hatchStrength: 0.3, hazeAmount: 0.3,
      paperAmount: 0.02, splitTone: 0.5,
      shadow: "#0b1a4a", shadow2: "#241078", mid: "#00b8d4", light: "#ff3ea5", highlight: "#e9fbff",
      haze: "#3b2a8a", skyTop: "#050b2e", skyMid: "#3a0f6e", skyHorizon: "#ff2e88",
    },
  },
  {
    id: "clean",
    label: "Clean Line",
    hint: "Ligne claire: flat colour, no hatching",
    values: {
      hatchStrength: 0, paperAmount: 0, bands: 3, colorEdge: 0.38, lineFarOpacity: 0.35,
      hazeAmount: 0.18, saturation: 1.8,
    },
  },
  {
    id: "sketch",
    label: "Sketchbook",
    hint: "Earthy inks on warm paper",
    values: {
      saturation: 0.9, paperAmount: 0.45, hatchStrength: 0.7, hatchSpacing: 4, lineWidth: 1.3,
      colorEdge: 0.14, splitTone: 0.3, paletteMixGrey: 0.6,
      ink: "#2a1c12", shadow: "#4a4a6a", shadow2: "#7a6a86", mid: "#b8744f", light: "#e2c28a", highlight: "#f7ecd4",
      haze: "#e8d8b8", skyTop: "#9fb8b8", skyMid: "#c8c4b0", skyHorizon: "#f0dcb0",
    },
  },
];

const _color = new THREE.Color();

function readUniform(uniform, option) {
  if (option.type === "color") {
    const v = uniform.value;
    return `#${_color.setRGB(v.x, v.y, v.z, THREE.LinearSRGBColorSpace).getHexString()}`;
  }
  return uniform.value;
}

function writeUniform(uniform, option, value) {
  if (option.type === "color") {
    // Color.set("#hex") already converts sRGB → linear (ColorManagement).
    _color.set(value);
    uniform.value.set(_color.r, _color.g, _color.b);
  } else {
    uniform.value = Number(value);
  }
}

function readStored() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {
    return null;
  }
}

function writeStored(value) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // localStorage may be unavailable
  }
}

export function clearStoredMoebiusSettings() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage may be unavailable
  }
}

/** @param {{ moebius: { uniforms: Record<string, any> } }} options */
export function createMoebiusSettings({ moebius }) {
  const uniforms = moebius.uniforms;
  const options = MOEBIUS_OPTIONS.filter((option) => uniforms[option.key]);
  const byKey = new Map(options.map((option) => [option.key, option]));

  // Shipped values = the "Arzach" preset baseline.
  const defaults = {};
  for (const option of options) {
    defaults[option.key] = readUniform(uniforms[option.key], option);
  }

  const values = { ...defaults };
  let presetId = "arzach";
  let saveTimer = 0;

  function apply(key) {
    writeUniform(uniforms[key], byKey.get(key), values[key]);
  }

  function applyAll() {
    for (const option of options) {
      apply(option.key);
    }
  }

  function persist() {
    clearTimeout(saveTimer);
    // Sliders fire continuously; write once they settle.
    saveTimer = setTimeout(() => writeStored({ preset: presetId, values }), 250);
  }

  function presetValues(id) {
    const preset = MOEBIUS_PRESETS.find((entry) => entry.id === id);
    return preset ? { ...defaults, ...preset.values } : null;
  }

  function setPreset(id) {
    const next = presetValues(id);
    if (!next) {
      return;
    }
    presetId = id;
    for (const option of options) {
      values[option.key] = next[option.key];
    }
    applyAll();
    persist();
  }

  function set(key, value) {
    const option = byKey.get(key);
    if (!option) {
      return;
    }
    values[key] = option.type === "color" ? String(value) : Math.min(option.max, Math.max(option.min, Number(value)));
    apply(key);
    presetId = "custom";
    persist();
  }

  function reset() {
    clearTimeout(saveTimer);
    clearStoredMoebiusSettings();
    presetId = "arzach";
    Object.assign(values, defaults);
    applyAll();
  }

  function applyStored() {
    const stored = readStored();
    if (!stored) {
      return;
    }
    const base = presetValues(stored.preset) ?? defaults;
    for (const option of options) {
      values[option.key] = stored.values?.[option.key] ?? base[option.key];
    }
    presetId = stored.preset ?? "custom";
    applyAll();
  }

  return {
    options,
    presets: MOEBIUS_PRESETS,
    getValues: () => ({ ...values }),
    getPreset: () => presetId,
    setPreset,
    set,
    reset,
    applyStored,
  };
}
