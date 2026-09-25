import { getAudioVolume, subscribe } from "./audioState.js";

/** CC0 Kenney "Starter Kit FPS" sounds (see public/audio/runner/CREDITS.md). */
const SOUND_URLS = {
  shot: "/audio/runner/blaster_repeater.ogg",
  droneShot: "/audio/runner/enemy_attack.ogg",
  hit: "/audio/runner/enemy_hurt.ogg",
  jump: "/audio/runner/jump_a.ogg",
  land: "/audio/runner/land.ogg",
  reload: "/audio/runner/weapon_change.ogg",
};

/**
 * Drop a recorded explosion at this path (ogg/wav/mp3 renamed .ogg is fine)
 * to use it instead of the synthesized one.
 */
const EXPLOSION_OVERRIDE_URL = "/audio/runner/explosion.ogg";
const EXPLOSION_VARIANTS = 3;

/**
 * Physically-inspired explosion, rendered offline once per variant:
 * sub-bass pressure thump + lowpass-swept noise blast + crackling debris
 * grains + brown-noise rumble, through a generated reverb and a soft
 * clipper. Sounds far closer to a real detonation than a sample-based toy
 * "boom", and costs nothing at runtime (plain buffer playback).
 */
export async function renderExplosion(sampleRate, seed) {
  const duration = 2.6;
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  let s = seed * 9973 + 17;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };

  const noiseBuffer = (seconds, brown = false) => {
    const buffer = ctx.createBuffer(2, Math.ceil(seconds * sampleRate), sampleRate);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      let last = 0;
      for (let i = 0; i < data.length; i++) {
        const white = rand() * 2 - 1;
        if (brown) {
          last = (last + 0.02 * white) / 1.02;
          data[i] = last * 3.5;
        } else {
          data[i] = white;
        }
      }
    }
    return buffer;
  };

  // Master: soft clip → out, plus a reverb send.
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
  }
  shaper.curve = curve;
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(shaper);
  shaper.connect(ctx.destination);

  const reverb = ctx.createConvolver();
  const ir = ctx.createBuffer(2, Math.ceil(1.9 * sampleRate), sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = ir.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const t = i / sampleRate;
      data[i] = (rand() * 2 - 1) * Math.exp(-t * 3.2) * (t < 0.012 ? t / 0.012 : 1);
    }
  }
  reverb.buffer = ir;
  const wet = ctx.createGain();
  wet.gain.value = 0.32;
  reverb.connect(wet);
  wet.connect(master);

  const bus = ctx.createGain();
  bus.connect(master);
  bus.connect(reverb);

  // 1) Pressure thump: pitch-dropping sine.
  const thump = ctx.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime(95 + rand() * 20, 0);
  thump.frequency.exponentialRampToValueAtTime(26, 0.45);
  const thumpGain = ctx.createGain();
  thumpGain.gain.setValueAtTime(0, 0);
  thumpGain.gain.linearRampToValueAtTime(1.3, 0.006);
  thumpGain.gain.exponentialRampToValueAtTime(0.001, 0.9);
  thump.connect(thumpGain).connect(bus);
  thump.start(0);
  thump.stop(1);

  // 2) Blast: white noise, lowpass sweeping down.
  const blast = ctx.createBufferSource();
  blast.buffer = noiseBuffer(1.6);
  const blastFilter = ctx.createBiquadFilter();
  blastFilter.type = "lowpass";
  blastFilter.Q.value = 0.7;
  blastFilter.frequency.setValueAtTime(7000, 0);
  blastFilter.frequency.exponentialRampToValueAtTime(260, 0.9);
  const blastGain = ctx.createGain();
  blastGain.gain.setValueAtTime(0, 0);
  blastGain.gain.linearRampToValueAtTime(1, 0.004);
  blastGain.gain.exponentialRampToValueAtTime(0.25, 0.18);
  blastGain.gain.exponentialRampToValueAtTime(0.001, 1.5);
  blast.connect(blastFilter).connect(blastGain).connect(bus);
  blast.start(0);

  // 3) Debris crackle: short band-passed noise grains, thinning out.
  const crackleSource = noiseBuffer(1.2);
  const grains = 34 + Math.floor(rand() * 14);
  for (let i = 0; i < grains; i++) {
    const t = 0.03 + Math.pow(rand(), 1.8) * 1.1;
    const grain = ctx.createBufferSource();
    grain.buffer = crackleSource;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 1400 + rand() * 4200;
    band.Q.value = 1.2 + rand() * 2;
    const g = ctx.createGain();
    const peak = (0.55 + rand() * 0.5) * Math.exp(-t * 2.4);
    const len = 0.006 + rand() * 0.028;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0005, t + len);
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand() * 1.6 - 0.8;
    grain.connect(band).connect(g).connect(pan).connect(bus);
    grain.start(t, rand() * 0.8, len + 0.01);
  }

  // 4) Rumble tail: brown noise, low-passed, slow decay.
  const rumble = ctx.createBufferSource();
  rumble.buffer = noiseBuffer(duration, true);
  const rumbleFilter = ctx.createBiquadFilter();
  rumbleFilter.type = "lowpass";
  rumbleFilter.frequency.value = 180;
  const rumbleGain = ctx.createGain();
  rumbleGain.gain.setValueAtTime(0, 0);
  rumbleGain.gain.linearRampToValueAtTime(0.9, 0.05);
  rumbleGain.gain.exponentialRampToValueAtTime(0.001, duration - 0.05);
  rumble.connect(rumbleFilter).connect(rumbleGain).connect(bus);
  rumble.start(0);

  return ctx.startRendering();
}

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
  let explosionVariants = null;
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

    const explosionLoading = (async () => {
      try {
        const response = await fetch(EXPLOSION_OVERRIDE_URL);
        const type = response.headers.get("content-type") ?? "";
        if (response.ok && !type.includes("text/html")) {
          buffers.set("explosion", await context.decodeAudioData(await response.arrayBuffer()));
          return;
        }
      } catch {
        // No override file — synthesize below.
      }
      const variants = [];
      for (let i = 0; i < EXPLOSION_VARIANTS; i++) {
        variants.push(await renderExplosion(context.sampleRate, i + 1));
      }
      explosionVariants = variants;
    })().catch((error) => console.warn("[runner-audio] explosion synth failed:", error));

    loading = Promise.all([explosionLoading,
      ...Object.entries(SOUND_URLS).map(async ([name, url]) => {
        try {
          const response = await fetch(url);
          const data = await response.arrayBuffer();
          buffers.set(name, await context.decodeAudioData(data));
        } catch (error) {
          console.warn(`[runner-audio] ${name} unavailable:`, error?.message ?? error);
        }
      }),
    ]);
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
    let buffer = buffers.get(name);
    if (!buffer && name === "explosion" && explosionVariants) {
      buffer = explosionVariants[Math.floor(Math.random() * explosionVariants.length)];
    }
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
    hasExplosion: () => Boolean(explosionVariants || buffers.get("explosion")),
    play,
    setHum,
    dispose() {
      unsubscribe();
      context?.close();
    },
  };
}
