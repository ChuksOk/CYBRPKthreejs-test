import * as THREE from "three/webgpu";
import { performanceProfile } from "../platform/performanceProfile.js";

/**
 * Day–night cycle for the runner. Advances while the player runs
 * (default: one full day every 2 minutes, starting at night) and drives:
 *  - key light: moonlight (cool) → dawn/dusk (warm, low) → noon (bright)
 *  - fill light, environment-map intensity, scene background
 *  - cloud-sky gradient + cloud preset (via sky.updateFromSun)
 * The sun arcs across the sky; the static shadow map is refreshed at a
 * throttled rate (performanceProfile.runnerSunShadowInterval).
 */

const KEYS = {
  // [skyTop, skyBottom, keyColor, keyIntensity, fillColor, fillIntensity, env]
  night: [0x0a0818, 0x1c2438, 0xcfefff, 10, 0xffd6c8, 1.5, 0.08],
  twilight: [0x2a2a5c, 0xff8a5c, 0xffa468, 7, 0xff9a7a, 1.8, 0.28],
  day: [0x3f74b8, 0xb7d3ee, 0xfff1dc, 15, 0xcfe2ff, 2.4, 0.85],
};

const _a = new THREE.Color();
const _b = new THREE.Color();
const _c = new THREE.Color();

function lerpKey(from, to, t, out) {
  out.skyTop.copy(_a.set(from[0])).lerp(_b.set(to[0]), t);
  out.skyBottom.copy(_a.set(from[1])).lerp(_b.set(to[1]), t);
  out.keyColor.copy(_a.set(from[2])).lerp(_b.set(to[2]), t);
  out.keyIntensity = THREE.MathUtils.lerp(from[3], to[3], t);
  out.fillColor.copy(_a.set(from[4])).lerp(_b.set(to[4]), t);
  out.fillIntensity = THREE.MathUtils.lerp(from[5], to[5], t);
  out.env = THREE.MathUtils.lerp(from[6], to[6], t);
}

const PHASE_LABELS = [
  [0.0, "NIGHT"],
  [0.2, "DAWN"],
  [0.3, "DAY"],
  [0.7, "DUSK"],
  [0.8, "NIGHT"],
];

export function createDayNightCycle({
  sceneResult,
  sky = null,
  envMapBaseIntensity,
  syncEnvironmentIntensity,
  requestShadowMapUpdate,
  cycleSeconds = 120,
  startPhase = 0,
}) {
  const { scene, sunLight, fillLight } = sceneResult;
  const base = {
    position: sunLight.position.clone(),
    background: scene.background?.clone?.() ?? new THREE.Color(0x080610),
  };
  const state = {
    phase: startPhase, // 0 = midnight, 0.5 = noon
    enabled: true,
  };
  const mix = {
    skyTop: new THREE.Color(),
    skyBottom: new THREE.Color(),
    keyColor: new THREE.Color(),
    keyIntensity: 0,
    fillColor: new THREE.Color(),
    fillIntensity: 0,
    env: 0,
  };
  let shadowTimer = 0;
  let lastShadowPhase = -1;

  function apply() {
    // Sun height: -1 at midnight, +1 at noon.
    const angle = state.phase * Math.PI * 2;
    const height = -Math.cos(angle);
    const day = THREE.MathUtils.smoothstep(height, -0.15, 0.45);
    const twilight = Math.exp(-Math.pow(height / 0.28, 2));

    if (day < 0.5) {
      lerpKey(KEYS.night, KEYS.twilight, Math.min(1, twilight * 1.2), mix);
    } else {
      lerpKey(KEYS.twilight, KEYS.day, THREE.MathUtils.smoothstep(day, 0.5, 1), mix);
    }

    sunLight.color.copy(mix.keyColor);
    sunLight.intensity = mix.keyIntensity;
    fillLight.color.copy(mix.fillColor);
    fillLight.intensity = mix.fillIntensity;

    // Arc: sun (day) or moon (night) sweeps east → west over the street.
    const sweep = Math.sin(angle);
    const elevation = 18 + Math.abs(height) * 26;
    sunLight.position.set(base.position.x * 0.4 + sweep * 34, elevation, base.position.z + Math.cos(angle) * 10);
    sunLight.target.updateMatrixWorld();

    envMapBaseIntensity.value = mix.env;
    syncEnvironmentIntensity?.();
    if (scene.background?.isColor) {
      scene.background.copy(_c.copy(mix.skyTop).multiplyScalar(0.6));
    }
    sky?.updateFromSun({
      evening: twilight,
      night: 1 - day,
      skyTop: mix.skyTop,
      skyBottom: mix.skyBottom,
    });
  }

  function update(delta) {
    if (!state.enabled || delta <= 0) {
      return;
    }
    state.phase = (state.phase + delta / cycleSeconds) % 1;
    apply();

    // Moving the key light invalidates the static shadow map: refresh it at
    // a throttled rate (off on mobile budgets).
    const interval = performanceProfile.runnerSunShadowInterval ?? 0;
    if (interval > 0) {
      shadowTimer += delta;
      if (shadowTimer >= interval && Math.abs(state.phase - lastShadowPhase) > 0.002) {
        shadowTimer = 0;
        lastShadowPhase = state.phase;
        requestShadowMapUpdate?.("day-night");
      }
    }
  }

  function getLabel() {
    let label = "NIGHT";
    for (const [start, name] of PHASE_LABELS) {
      if (state.phase >= start) {
        label = name;
      }
    }
    return label;
  }

  /** "HH:MM" where phase 0 = 00:00 and 0.5 = 12:00. */
  function getClock() {
    const minutes = Math.floor(state.phase * 24 * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }

  function setPhase(phase) {
    state.phase = ((phase % 1) + 1) % 1;
    apply();
    requestShadowMapUpdate?.("day-night");
  }

  function restoreBase() {
    scene.background?.copy?.(base.background);
  }

  apply();

  return { state, update, setPhase, getClock, getLabel, apply, restoreBase };
}
