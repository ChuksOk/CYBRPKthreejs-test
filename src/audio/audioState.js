/**
 * Shared audio state: the ambience toggle (audio button) and the player's
 * sound-effects volume. `audioVolume` is what ambience / engines / footsteps
 * already read; it is the base level scaled by the SFX setting, so every
 * existing subscriber follows the slider. Soundtrack volume lives in the
 * music player (createMusicPlayer).
 */
const listeners = new Set();
const SFX_KEY = "threejs-punk-sfx-volume";
const BASE_VOLUME = 0.5;

function readSfx() {
  try {
    const stored = localStorage.getItem(SFX_KEY);
    const value = stored == null ? 1 : Number(stored);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
  } catch {
    return 1;
  }
}

let sfxVolume = readSfx();
let audioVolume = BASE_VOLUME * sfxVolume;
let isMusicPlaying = false;

function notify() {
  for (const listener of listeners) {
    listener({ audioVolume, sfxVolume, isMusicPlaying });
  }
}

export function getAudioVolume() {
  return audioVolume;
}

/** 0..1 sound-effects volume (Settings → Audio). */
export function getSfxVolume() {
  return sfxVolume;
}

export function setSfxVolume(value) {
  sfxVolume = Math.max(0, Math.min(1, Number(value) || 0));
  audioVolume = BASE_VOLUME * sfxVolume;
  try {
    localStorage.setItem(SFX_KEY, String(sfxVolume));
  } catch {
    // localStorage may be unavailable
  }
  notify();
}

export function getIsMusicPlaying() {
  return isMusicPlaying;
}

export function setMusicPlaying(value) {
  if (isMusicPlaying === value) {
    return;
  }

  isMusicPlaying = value;
  notify();
}

export function toggleMusic(value) {
  if (value !== undefined) {
    setMusicPlaying(value);
  } else {
    setMusicPlaying(!isMusicPlaying);
  }
}

export function subscribe(listener) {
  listeners.add(listener);
  listener({ audioVolume, sfxVolume, isMusicPlaying });
  return () => listeners.delete(listener);
}
