import { getAudioVolume, subscribe } from "./audioState.js";

/** CC0 Kenney "Starter Kit FPS" sounds (see public/audio/runner/CREDITS.md). */
const SOUND_URLS = {
  shot: "/audio/runner/blaster_repeater.ogg",
  droneShot: "/audio/runner/enemy_attack.ogg",
  explosion: "/audio/runner/enemy_destroy.ogg",
  hit: "/audio/runner/enemy_hurt.ogg",
  jump: "/audio/runner/jump_a.ogg",
  land: "/audio/runner/land.ogg",
  reload: "/audio/runner/weapon_change.ogg",
};

/**
 * Lightweight Web Audio SFX bus for the runner. Created lazily on the first
 * user gesture (Start button) so autoplay policies are satisfied. Missing or
 * undecodable files are skipped; procedural fallbacks cover the rest.
 */
export function createRunnerAudio() {
  let context = null;
  let master = null;
  let humGain = null;
  let humOsc = null;
  const buffers = new Map();
  let loading = null;
  let volume = getAudioVolume();

  const unsubscribe = subscribe(({ audioVolume }) => {
    volume = audioVolume;
    if (master) {
      master.gain.value = 0.35 + volume;
    }
  });

  async function ensureContext() {
    if (context) {
      if (context.state !== "running") {
        await context.resume().catch(() => {});
      }
      return context;
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      return null;
    }
    context = new AudioContextClass();
    master = context.createGain();
    master.gain.value = 0.35 + volume;
    master.connect(context.destination);

    // Procedural drone hum: detuned saws through a lowpass, gain follows the
    // nearest drone distance.
    humGain = context.createGain();
    humGain.gain.value = 0;
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 420;
    humOsc = [context.createOscillator(), context.createOscillator()];
    humOsc[0].type = "sawtooth";
    humOsc[1].type = "sawtooth";
    humOsc[0].frequency.value = 96;
    humOsc[1].frequency.value = 97.3;
    for (const osc of humOsc) {
      osc.connect(filter);
      osc.start();
    }
    filter.connect(humGain);
    humGain.connect(master);

    loading = Promise.all(
      Object.entries(SOUND_URLS).map(async ([name, url]) => {
        try {
          const response = await fetch(url);
          const data = await response.arrayBuffer();
          buffers.set(name, await context.decodeAudioData(data));
        } catch (error) {
          console.warn(`[runner-audio] ${name} unavailable:`, error?.message ?? error);
        }
      }),
    );
    if (context.state !== "running") {
      await context.resume().catch(() => {});
    }
    return context;
  }

  function synthBlip({ frequency = 220, duration = 0.12, type = "square", gain = 0.2, sweep = 0.5 }) {
    const now = context.currentTime;
    const osc = context.createOscillator();
    const env = context.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, frequency * sweep), now + duration);
    env.gain.setValueAtTime(gain, now);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(env);
    env.connect(master);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  const FALLBACKS = {
    droneSpawn: { frequency: 660, duration: 0.25, type: "triangle", gain: 0.08, sweep: 1.6 },
    dive: { frequency: 900, duration: 0.5, type: "sawtooth", gain: 0.07, sweep: 0.3 },
    pickup: { frequency: 880, duration: 0.14, type: "triangle", gain: 0.12, sweep: 1.8 },
    damage: { frequency: 140, duration: 0.25, type: "sawtooth", gain: 0.2, sweep: 0.4 },
    crash: { frequency: 90, duration: 0.6, type: "sawtooth", gain: 0.3, sweep: 0.25 },
    countdown: { frequency: 520, duration: 0.12, type: "square", gain: 0.08, sweep: 1 },
    go: { frequency: 1040, duration: 0.25, type: "square", gain: 0.09, sweep: 1 },
    slide: { frequency: 300, duration: 0.2, type: "triangle", gain: 0.05, sweep: 0.6 },
  };

  function play(name, { volume: gain = 0.5, detune = 0, pan = 0 } = {}) {
    if (!context || context.state !== "running") {
      return;
    }
    const buffer = buffers.get(name);
    if (!buffer) {
      const fallback = FALLBACKS[name];
      if (fallback) {
        synthBlip(fallback);
      }
      return;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.detune.value = detune;
    const env = context.createGain();
    env.gain.value = gain;
    let node = source.connect(env);
    if (pan !== 0 && context.createStereoPanner) {
      const panner = context.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      node = env.connect(panner);
      node.connect(master);
    } else {
      env.connect(master);
    }
    source.start();
  }

  /** 0..1 — how close the nearest drone is. */
  function setHum(amount) {
    if (!humGain || !context) {
      return;
    }
    humGain.gain.setTargetAtTime(amount * 0.05, context.currentTime, 0.2);
    const pitch = 90 + amount * 40;
    humOsc[0].frequency.setTargetAtTime(pitch, context.currentTime, 0.3);
    humOsc[1].frequency.setTargetAtTime(pitch * 1.013, context.currentTime, 0.3);
  }

  return {
    ensureContext,
    ready: () => loading,
    play,
    setHum,
    dispose() {
      unsubscribe();
      context?.close();
    },
  };
}
