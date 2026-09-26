import {
  performanceProfile,
  applyPerformanceProfileToPipeline,
} from "./performanceProfile.js";
import { isMobileDevice, isSafari } from "./deviceLayout.js";

/**
 * Player-facing graphics settings: the Development Mode performance knobs
 * (performanceProfile) exposed as presets + individual options in Settings,
 * persisted in localStorage and applied on top of the device defaults.
 *
 * Presets are relative to the device baseline captured at creation (after
 * applyDevicePerformanceDefaults), so "High" is always what the device
 * would get out of the box and nothing re-enables Safari-disabled DoF.
 */

const STORAGE_KEY = "threejs-punk-graphics";

/** Option descriptors: rendered by the Settings panel. */
export const GRAPHICS_OPTIONS = [
  { key: "maxPixelRatio", label: "Resolution", type: "range", min: 0.5, max: 2, step: 0.05, format: (v) => `${v.toFixed(2)}×` },
  { key: "adaptiveDpr", label: "Adaptive resolution", type: "toggle", hint: "Lowers resolution when FPS drops" },
  { key: "smaa", label: "Anti-aliasing (SMAA)", type: "toggle" },
  { key: "bloom", label: "Bloom", type: "toggle" },
  { key: "bloomResolutionScale", label: "Bloom quality", type: "range", min: 0.25, max: 1, step: 0.05, format: pct },
  { key: "ao", label: "Ambient occlusion", type: "toggle" },
  { key: "aoResolutionScale", label: "AO quality", type: "range", min: 0.25, max: 1, step: 0.05, format: pct },
  { key: "aoSamples", label: "AO samples", type: "range", min: 4, max: 16, step: 1, format: (v) => String(v) },
  { key: "lensflare", label: "Lens flare", type: "toggle" },
  { key: "dof", label: "Depth of field", type: "toggle" },
  { key: "groundReflection", label: "Wet reflections", type: "toggle" },
  { key: "groundResolutionScale", label: "Reflection quality", type: "range", min: 0.15, max: 0.75, step: 0.05, format: pct },
  { key: "carSurfaceRain", label: "Car rain droplets", type: "toggle" },
  { key: "rainDensity", label: "Rain density", type: "range", min: 0.25, max: 1, step: 0.05, format: pct },
];

export const GRAPHICS_PRESETS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "ultra", label: "Ultra" },
];

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStored(value) {
  try {
    if (value) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // localStorage may be unavailable
  }
}

export function clearStoredGraphicsSettings() {
  writeStored(null);
}

/**
 * @param {object} options
 * @param {object} options.pipeline      post pipeline (perf setters)
 * @param {object} [options.ground]      wet ground (reflection toggle)
 * @param {object} [options.adaptiveDpr] adaptive DPR controller
 * @param {object} [options.rain]        collision rain
 * @param {() => object|null} [options.getWeather] runner weather system
 */
export function createGraphicsSettings({ pipeline, ground = null, adaptiveDpr = null, rain = null, getWeather = () => null }) {
  const mobile = isMobileDevice();
  const safari = isSafari();
  // Full-storm drop count (weather may already have lowered params.count).
  const baseRainCount = performanceProfile.collisionRainCount;
  const optionKeys = GRAPHICS_OPTIONS.map((option) => option.key);

  // Device baseline = "High".
  const baseline = { rainDensity: 1 };
  for (const key of optionKeys) {
    if (key in performanceProfile) {
      baseline[key] = performanceProfile[key];
    }
  }
  // Phones / Safari: keep the device cap as the resolution ceiling.
  const maxResolution = mobile || safari ? baseline.maxPixelRatio : 2;
  // Safari WebGPU is unstable with DoF (see applyDevicePerformanceDefaults).
  const locked = new Set(safari ? ["dof"] : []);

  const presets = {
    low: {
      maxPixelRatio: Math.min(baseline.maxPixelRatio, 1),
      adaptiveDpr: true,
      smaa: false,
      bloom: true,
      bloomResolutionScale: 0.25,
      ao: false,
      aoResolutionScale: 0.25,
      aoSamples: 4,
      lensflare: false,
      dof: false,
      groundReflection: false,
      groundResolutionScale: 0.25,
      carSurfaceRain: false,
      rainDensity: 0.4,
    },
    medium: {
      maxPixelRatio: Math.min(baseline.maxPixelRatio, 1.25),
      adaptiveDpr: true,
      smaa: true,
      bloom: true,
      bloomResolutionScale: 0.4,
      ao: false,
      aoResolutionScale: 0.4,
      aoSamples: 4,
      lensflare: false,
      dof: false,
      groundReflection: true,
      groundResolutionScale: 0.35,
      carSurfaceRain: true,
      rainDensity: 0.7,
    },
    high: { ...baseline },
    ultra: {
      ...baseline,
      maxPixelRatio: maxResolution,
      adaptiveDpr: false,
      smaa: true,
      bloom: true,
      bloomResolutionScale: 0.75,
      ao: true,
      aoResolutionScale: 0.75,
      aoSamples: 10,
      lensflare: !mobile,
      groundReflection: true,
      groundResolutionScale: 0.6,
      carSurfaceRain: true,
      rainDensity: 1,
    },
  };

  const values = { ...baseline };
  let presetId = "high";

  function clampValue(key, value) {
    const option = GRAPHICS_OPTIONS.find((entry) => entry.key === key);
    if (!option) {
      return value;
    }
    if (locked.has(key)) {
      return baseline[key];
    }
    if (option.type === "toggle") {
      return Boolean(value);
    }
    const max = key === "maxPixelRatio" ? maxResolution : option.max;
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(option.min, number)) : baseline[key];
  }

  function applyRainDensity() {
    const count = baseRainCount * values.rainDensity;
    const weather = getWeather();
    if (weather?.setMaxDropCount) {
      weather.setMaxDropCount(count);
    } else {
      rain?.setDropCount?.(count);
    }
  }

  /** Push `values` into performanceProfile and the live pipeline. */
  function apply() {
    const dprChanged =
      performanceProfile.maxPixelRatio !== values.maxPixelRatio ||
      performanceProfile.adaptiveDpr !== values.adaptiveDpr;
    for (const key of optionKeys) {
      if (key in performanceProfile) {
        performanceProfile[key] = values[key];
      }
    }
    applyPerformanceProfileToPipeline(pipeline);
    ground?.setReflectionEnabled?.(values.groundReflection);
    if (dprChanged) {
      // A deliberate choice overrides an earlier automatic downgrade.
      adaptiveDpr?.resetForcedLow?.();
      adaptiveDpr?.setEnabled?.(values.adaptiveDpr);
    }
    applyRainDensity();
  }

  function persist() {
    writeStored(presetId === "custom" ? { preset: "custom", values } : { preset: presetId });
  }

  function setPreset(id) {
    const preset = presets[id];
    if (!preset) {
      return;
    }
    presetId = id;
    for (const key of optionKeys) {
      values[key] = clampValue(key, preset[key] ?? baseline[key]);
    }
    apply();
    persist();
  }

  function set(key, value) {
    if (!optionKeys.includes(key)) {
      return;
    }
    values[key] = clampValue(key, value);
    // Still matches a preset? Keep its name, otherwise "custom".
    presetId =
      Object.keys(presets).find((id) =>
        optionKeys.every((k) => clampValue(k, presets[id][k] ?? baseline[k]) === values[k]),
      ) ?? "custom";
    apply();
    persist();
  }

  function reset() {
    clearStoredGraphicsSettings();
    presetId = "high";
    Object.assign(values, baseline);
    apply();
  }

  /** Apply what the player chose last session (call once at boot). */
  function applyStored() {
    const stored = readStored();
    if (!stored) {
      return;
    }
    if (stored.preset === "custom" && stored.values) {
      for (const key of optionKeys) {
        values[key] = clampValue(key, stored.values[key] ?? baseline[key]);
      }
      presetId = "custom";
      apply();
    } else if (presets[stored.preset]) {
      setPreset(stored.preset);
    }
  }

  /** Re-read values another tool changed (inspector, adaptive DPR). */
  function syncFromProfile() {
    for (const key of optionKeys) {
      if (key in performanceProfile) {
        values[key] = performanceProfile[key];
      }
    }
  }

  return {
    options: GRAPHICS_OPTIONS,
    presets: GRAPHICS_PRESETS,
    getValues: () => ({ ...values }),
    getPreset: () => presetId,
    getRange: (key) => (key === "maxPixelRatio" ? { max: maxResolution } : null),
    isLocked: (key) => locked.has(key),
    setPreset,
    set,
    reset,
    applyStored,
    syncFromProfile,
  };
}
