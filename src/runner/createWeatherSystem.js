import * as THREE from "three/webgpu";

/**
 * Runner weather: a Markov chain of states that hold for 35–70 s and blend
 * over ~10 s. Drives the collision rain (density / opacity, fully disabled
 * when dry so its compute + height pass are skipped), ground wetness
 * (reflection + roughness, dries slowly after rain), ripples, the sky deck
 * and key-light dimming via the day-night cycle, and storm lightning.
 */
export const WEATHER_STATES = {
  clear: { label: "CLEAR", rain: 0, cover: 0, wet: 0, next: { cloudy: 1 } },
  cloudy: { label: "CLOUDY", rain: 0, cover: 0.6, wet: 0, next: { clear: 1, drizzle: 1.2 } },
  drizzle: { label: "DRIZZLE", rain: 0.35, cover: 0.72, wet: 0.65, next: { cloudy: 1, rain: 1.3 } },
  rain: { label: "RAIN", rain: 0.8, cover: 0.86, wet: 1, next: { drizzle: 1, storm: 0.9 } },
  storm: { label: "STORM", rain: 1, cover: 1, wet: 1, lightning: true, next: { rain: 1 } },
};

const BLEND_SECONDS = 10;
const WET_RATE = 1 / 6;
const DRY_RATE = 1 / 30;

function pick(weights) {
  const entries = Object.entries(weights);
  let roll = Math.random() * entries.reduce((sum, [, w]) => sum + w, 0);
  for (const [id, w] of entries) {
    roll -= w;
    if (roll <= 0) {
      return id;
    }
  }
  return entries[0][0];
}

export function createWeatherSystem({ world, dayNight = null, audio = null, initial = "rain" }) {
  const rain = world.rain ?? null;
  const ground = world.ground ?? null;
  const base = {
    opacity: rain?.params.opacity ?? 1,
    count: rain?.params.count ?? 0,
    splash: rain?.params.splashOpacity ?? 1,
    reflection: ground?.uniforms.reflectionStrength.value ?? 0.08,
    roughness: ground?.uniforms.roughnessScale.value ?? 0.55,
  };

  const current = { rain: 0, cover: 0, wet: 0 };
  const state = {
    id: initial,
    from: { ...WEATHER_STATES[initial] },
    blend: 1,
    hold: 0,
    flash: 0,
    lightningTimer: 4,
    rippleAmount: 1,
  };

  function holdTime() {
    return 35 + Math.random() * 35;
  }

  function set(id, { instant = false } = {}) {
    const target = WEATHER_STATES[id];
    if (!target) {
      return;
    }
    state.from = { rain: current.rain, cover: current.cover };
    state.id = id;
    state.blend = instant ? 1 : 0;
    state.hold = holdTime();
    if (instant) {
      current.rain = target.rain;
      current.cover = target.cover;
      current.wet = target.wet;
    }
    applyAll();
  }

  /** New run: start in a random non-storm state so it isn't always raining. */
  function randomize() {
    set(pick({ clear: 1.2, cloudy: 1, drizzle: 0.8, rain: 0.7 }), { instant: true });
  }

  function applyAll() {
    // Rain particles: off entirely when dry (skips compute + height pass).
    if (rain) {
      const on = current.rain > 0.02;
      // Flip the flag directly: rain.setEnabled() is wrapped by the post
      // pipeline and would rebuild (recompile) the output graph.
      rain.params.enabled = on;
      if (on) {
        rain.setOpacity(base.opacity * THREE.MathUtils.lerp(0.45, 1, current.rain));
        rain.setSplashOpacity(base.splash * current.rain);
        rain.setDropCount(base.count * THREE.MathUtils.lerp(0.25, 1, current.rain));
      }
    }
    // Ground: wet = mirror-like + ripples; dry = rougher, faint reflection.
    if (ground) {
      ground.uniforms.reflectionStrength.value = base.reflection * THREE.MathUtils.lerp(0.15, 1, current.wet);
      ground.uniforms.roughnessScale.value = base.roughness * THREE.MathUtils.lerp(2.1, 1, current.wet);
    }
    state.rippleAmount = current.rain > 0.02 ? Math.min(1, current.rain * 1.3) : 0;
    dayNight?.setWeather({ dim: current.cover, overcast: current.cover, flash: state.flash });
  }

  function update(delta) {
    const target = WEATHER_STATES[state.id];
    state.hold -= delta;
    if (state.hold <= 0) {
      set(pick(target.next));
    }
    if (state.blend < 1) {
      state.blend = Math.min(1, state.blend + delta / BLEND_SECONDS);
      const t = THREE.MathUtils.smoothstep(state.blend, 0, 1);
      current.rain = THREE.MathUtils.lerp(state.from.rain, target.rain, t);
      current.cover = THREE.MathUtils.lerp(state.from.cover, target.cover, t);
    }
    const rate = target.wet > current.wet ? WET_RATE : DRY_RATE;
    current.wet += THREE.MathUtils.clamp(target.wet - current.wet, -rate * delta, rate * delta);

    // Lightning: double-strobe flash, thunder a moment later.
    if (target.lightning && state.blend > 0.6) {
      state.lightningTimer -= delta;
      if (state.lightningTimer <= 0) {
        state.lightningTimer = 5 + Math.random() * 9;
        state.flash = 1;
        const distance = Math.random();
        setTimeout(() => {
          audio?.play("explosion", { volume: 0.35 + (1 - distance) * 0.4, detune: -1900 - distance * 500 });
        }, 250 + distance * 1500);
      }
    }
    if (state.flash > 0) {
      state.flash = Math.max(0, state.flash - delta * 4);
      // Second strobe.
      if (state.flash < 0.55 && state.flash > 0.45 && Math.random() < 0.5) {
        state.flash = 0.8;
      }
    }
    applyAll();
  }

  set(initial, { instant: true });

  return {
    state,
    current,
    update,
    set,
    randomize,
    getLabel: () => WEATHER_STATES[state.id].label,
    /** Graphics setting: drop count at full storm (weather scales below it). */
    setMaxDropCount(count) {
      base.count = count;
      applyAll();
    },
    /** Ground ripple amount the render loop should use (0 when dry). */
    getRippleAmount: () => state.rippleAmount,
  };
}
