/**
 * Procedural adaptive soundtrack (Web Audio, no files). A lookahead step
 * sequencer at 126 BPM; layers fade in with `intensity` (0..1, driven by the
 * combo meter / boss fights):
 *   0.00+ kick + sub pulse   0.2+ bassline   0.4+ hats   0.65+ lead arp
 */
const BPM = 126;
const STEP = 60 / BPM / 4; // 16th note
const LOOKAHEAD = 0.12;
// A minor: bass roots per bar and an arp over them.
const BASS = [45, 45, 48, 43];
const ARP = [0, 7, 12, 15, 12, 7, 3, 7];

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

export function createAdaptiveMusic(context, destination) {
  const out = context.createGain();
  out.gain.value = 0;
  out.connect(destination);

  const layers = {};
  for (const name of ["kick", "bass", "hat", "lead"]) {
    layers[name] = context.createGain();
    layers[name].gain.value = 0;
    layers[name].connect(out);
  }
  const leadFilter = context.createBiquadFilter();
  leadFilter.type = "lowpass";
  leadFilter.frequency.value = 1800;
  leadFilter.connect(layers.lead);

  const noise = context.createBuffer(1, context.sampleRate * 0.2, context.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  let timer = null;
  let step = 0;
  let nextTime = 0;
  let intensity = 0;

  function kick(t) {
    const osc = context.createOscillator();
    const env = context.createGain();
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    env.gain.setValueAtTime(0.9, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    osc.connect(env).connect(layers.kick);
    osc.start(t);
    osc.stop(t + 0.3);
  }

  function hat(t, open) {
    const src = context.createBufferSource();
    src.buffer = noise;
    const hp = context.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7000;
    const env = context.createGain();
    env.gain.setValueAtTime(open ? 0.35 : 0.22, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + (open ? 0.16 : 0.04));
    src.connect(hp).connect(env).connect(layers.hat);
    src.start(t);
    src.stop(t + 0.2);
  }

  function tone(t, note, length, type, gainValue, target) {
    const osc = context.createOscillator();
    const env = context.createGain();
    osc.type = type;
    osc.frequency.value = midi(note);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gainValue, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, t + length);
    osc.connect(env).connect(target);
    osc.start(t);
    osc.stop(t + length + 0.02);
  }

  function schedule() {
    while (nextTime < context.currentTime + LOOKAHEAD) {
      const s = step % 16;
      const bar = Math.floor(step / 16) % 4;
      const root = BASS[bar];
      if (s % 4 === 0) {
        kick(nextTime);
      }
      if (s % 4 === 2 || s === 15) {
        tone(nextTime, root, STEP * 1.6, "sawtooth", 0.22, layers.bass);
      }
      if (s % 2 === 1) {
        hat(nextTime, s % 8 === 7);
      }
      if (s % 2 === 0) {
        tone(nextTime, root + 24 + ARP[(s / 2 + bar) % ARP.length], STEP * 1.8, "square", 0.08, leadFilter);
      }
      nextTime += STEP;
      step += 1;
    }
  }

  function ramp(param, value) {
    param.setTargetAtTime(value, context.currentTime, 0.4);
  }

  function setIntensity(value) {
    intensity = Math.max(0, Math.min(1, value));
    ramp(layers.kick.gain, 0.55);
    ramp(layers.bass.gain, intensity > 0.2 ? 0.5 : 0.12);
    ramp(layers.hat.gain, intensity > 0.4 ? 0.45 : 0);
    ramp(layers.lead.gain, intensity > 0.65 ? 0.4 : 0);
    leadFilter.frequency.setTargetAtTime(1200 + intensity * 3000, context.currentTime, 0.5);
  }

  function start() {
    if (timer) {
      return;
    }
    step = 0;
    nextTime = context.currentTime + 0.05;
    setIntensity(intensity);
    out.gain.setTargetAtTime(0.32, context.currentTime, 0.3);
    timer = setInterval(schedule, 25);
    schedule();
  }

  function stop() {
    out.gain.setTargetAtTime(0, context.currentTime, 0.25);
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, setIntensity, isPlaying: () => Boolean(timer) };
}
