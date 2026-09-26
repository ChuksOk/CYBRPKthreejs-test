/**
 * Gameplay preferences (persisted). Aim assist is always on for touch; on
 * PC it is an opt-in magnetism toward the same targets touch auto-aim uses.
 */
const STORAGE_KEY = "threejs-punk-gameplay";

const DEFAULTS = {
  aimAssist: false,
  aimAssistStrength: 0.5,
};

function read() {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") ?? {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

const settings = read();
const listeners = new Set();

export function getGameplaySettings() {
  return { ...settings };
}

export function setGameplaySetting(key, value) {
  if (!(key in DEFAULTS)) {
    return;
  }
  settings[key] = typeof DEFAULTS[key] === "boolean" ? Boolean(value) : Math.max(0, Math.min(1, Number(value)));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage may be unavailable
  }
  listeners.forEach((listener) => listener({ ...settings }));
}

export function resetGameplaySettings() {
  Object.assign(settings, DEFAULTS);
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage may be unavailable
  }
  listeners.forEach((listener) => listener({ ...settings }));
}

export function onGameplaySettingsChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
