import { MUSIC_CATALOG, trackLabel } from "./musicCatalog.js";

/**
 * Soundtrack player (EA FC-style licensed-music catalog).
 *
 * Two <audio> decks stream the files (no full decode) through Web Audio:
 *   deck A/B → deck gain → music volume → duck → analyser → destination
 * Deck gains crossfade between tracks; `duck` lowers the music on the pause
 * screen; the analyser feeds the player's visualizer. Gains live in Web Audio
 * because iOS ignores HTMLMediaElement.volume.
 *
 * Game contexts ("menu" | "run" | "paused" | "dead") decide whether music
 * should play, from the player's settings (music in menus / during runs).
 * The "synth" source hands runs back to the procedural adaptive score.
 */

const STORAGE_KEY = "threejs-punk-music";
const CROSSFADE = 1.6;
const DUCK_PAUSED = 0.45;

export const MUSIC_SOURCES = [
  { id: "soundtrack", label: "SOUNDTRACK" },
  { id: "synth", label: "SYNTH SCORE" },
  { id: "off", label: "OFF" },
];

const DEFAULT_SETTINGS = {
  source: "soundtrack",
  volume: 0.7,
  // Album order by default (the tracklist is sequenced).
  shuffle: false,
  inMenus: true,
  inRuns: true,
  notify: true,
  crossfade: true,
  disabled: [],
  lastTrack: null,
};

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage may be unavailable
  }
}

function shuffled(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function createMusicPlayer({ catalog = MUSIC_CATALOG } = {}) {
  const settings = loadSettings();
  const listeners = { track: new Set(), state: new Set() };

  let context = null;
  let musicGain = null;
  let duckGain = null;
  let analyser = null;
  let spectrum = null;
  const decks = [0, 1].map(() => {
    const element = new Audio();
    element.preload = "none";
    element.crossOrigin = "anonymous";
    return { element, gain: null, source: null };
  });
  let active = 0;

  let current = null; // catalog entry
  let queue = [];
  let history = [];
  let playing = false; // user-visible play state
  let gameContext = "menu";
  let unlocked = false;

  const byId = new Map(catalog.map((track) => [track.id, track]));

  function emit(type, payload) {
    for (const fn of listeners[type]) {
      fn(payload);
    }
  }

  function state() {
    const deck = decks[active].element;
    return {
      track: current,
      playing,
      time: deck.currentTime || 0,
      duration: Number.isFinite(deck.duration) ? deck.duration : current?.duration ?? 0,
      settings: { ...settings, disabled: [...settings.disabled] },
      context: gameContext,
    };
  }

  function notifyState() {
    emit("state", state());
  }

  function persist() {
    saveSettings(settings);
  }

  // ── Web Audio graph (created on the first user gesture) ────────────────
  function ensureGraph() {
    if (context) {
      if (context.state !== "running") {
        context.resume().catch(() => {});
      }
      return true;
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      return false;
    }
    context = new AudioContextClass();
    musicGain = context.createGain();
    musicGain.gain.value = settings.volume;
    duckGain = context.createGain();
    duckGain.gain.value = 1;
    analyser = context.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.78;
    spectrum = new Uint8Array(analyser.frequencyBinCount);
    musicGain.connect(duckGain);
    duckGain.connect(analyser);
    analyser.connect(context.destination);
    for (const deck of decks) {
      deck.gain = context.createGain();
      deck.gain.gain.value = 0;
      deck.source = context.createMediaElementSource(deck.element);
      deck.source.connect(deck.gain);
      deck.gain.connect(musicGain);
    }
    return true;
  }

  /** Autoplay policy: the graph / playback start on the first gesture. */
  function unlock() {
    if (unlocked) {
      return;
    }
    unlocked = true;
    ensureGraph();
    applyContext();
  }
  for (const type of ["pointerdown", "keydown", "touchend"]) {
    document.addEventListener(type, unlock, { once: true, capture: true });
  }

  // ── Queue ───────────────────────────────────────────────────────────────
  function enabledTracks() {
    const list = catalog.filter((track) => !settings.disabled.includes(track.id));
    return list.length ? list : catalog;
  }

  function rebuildQueue() {
    const list = enabledTracks();
    if (settings.shuffle) {
      queue = shuffled(list).filter((track) => track !== current);
    } else {
      const start = current ? list.indexOf(current) + 1 : 0;
      queue = [...list.slice(start), ...list.slice(0, start)].filter((track) => track !== current);
    }
  }

  function nextFromQueue() {
    if (!queue.length) {
      rebuildQueue();
    }
    return queue.shift() ?? enabledTracks()[0];
  }

  // ── Playback ────────────────────────────────────────────────────────────
  function fadeDeck(deck, to, seconds) {
    if (!deck.gain) {
      return;
    }
    const now = context.currentTime;
    deck.gain.gain.cancelScheduledValues(now);
    deck.gain.gain.setValueAtTime(deck.gain.gain.value, now);
    deck.gain.gain.linearRampToValueAtTime(to, now + Math.max(0.01, seconds));
  }

  function load(track, { autoplay = true, fade = true } = {}) {
    if (!track) {
      return;
    }
    ensureGraph();
    const fadeTime = fade && settings.crossfade ? CROSSFADE : 0.05;
    const previous = decks[active];
    const pausingPrevious = previous.element;
    fadeDeck(previous, 0, fadeTime);
    setTimeout(() => {
      if (decks[active] !== previous) {
        pausingPrevious.pause();
      }
    }, fadeTime * 1000 + 60);

    active = 1 - active;
    const deck = decks[active];
    deck.element.preload = "auto";
    deck.element.src = track.src;
    deck.element.currentTime = 0;
    if (current && current !== track) {
      history.push(current);
      history = history.slice(-30);
    }
    current = track;
    settings.lastTrack = track.id;
    persist();
    updateMediaSession();
    if (autoplay) {
      startDeck(deck, fadeTime);
    }
    emit("track", track);
    notifyState();
  }

  function startDeck(deck, fadeTime = 0.4) {
    if (!deck.element.src) {
      return;
    }
    ensureGraph();
    playing = true;
    const promise = deck.element.play();
    promise?.catch?.(() => {
      // Blocked until a user gesture; unlock() retries via applyContext().
      playing = false;
      notifyState();
    });
    fadeDeck(deck, 1, fadeTime);
    notifyState();
  }

  function play(id = null) {
    if (id) {
      const track = byId.get(id);
      if (track) {
        load(track);
        rebuildQueue();
      }
      return;
    }
    if (!current) {
      const last = settings.lastTrack && byId.get(settings.lastTrack);
      rebuildQueue();
      load(settings.shuffle || !last ? nextFromQueue() : last);
      return;
    }
    startDeck(decks[active]);
  }

  function pause() {
    const deck = decks[active];
    playing = false;
    if (deck.gain && context) {
      fadeDeck(deck, 0, 0.25);
      setTimeout(() => {
        if (!playing) {
          deck.element.pause();
        }
      }, 280);
    } else {
      deck.element.pause();
    }
    notifyState();
  }

  function toggle() {
    if (playing) {
      pause();
    } else {
      play();
    }
  }

  function next() {
    load(nextFromQueue());
  }

  function prev() {
    const deck = decks[active].element;
    if (deck.currentTime > 4 || !history.length) {
      deck.currentTime = 0;
      notifyState();
      return;
    }
    const track = history.pop();
    if (current) {
      queue.unshift(current);
    }
    // Going back must not push the track we are leaving onto history.
    current = null;
    load(track);
  }

  function seek(fraction) {
    const deck = decks[active].element;
    if (Number.isFinite(deck.duration)) {
      deck.currentTime = Math.max(0, Math.min(1, fraction)) * deck.duration;
      notifyState();
    }
  }

  for (const [index, deck] of decks.entries()) {
    deck.element.addEventListener("ended", () => {
      if (index === active) {
        next();
      }
    });
    deck.element.addEventListener("error", () => {
      if (index === active && current) {
        console.warn("[music] could not play", current.src);
        setTimeout(next, 400);
      }
    });
    deck.element.addEventListener("loadedmetadata", () => {
      if (index === active) {
        notifyState();
      }
    });
    // Near the end: start the crossfade into the next track early.
    deck.element.addEventListener("timeupdate", () => {
      const el = deck.element;
      if (index !== active || !settings.crossfade || !playing || !Number.isFinite(el.duration)) {
        return;
      }
      if (el.duration - el.currentTime < CROSSFADE && el.duration > CROSSFADE * 4) {
        next();
      }
    });
  }

  // ── Game context + settings ─────────────────────────────────────────────
  function wantsMusic() {
    if (settings.source !== "soundtrack") {
      return false;
    }
    if (gameContext === "run" || gameContext === "paused") {
      return settings.inRuns;
    }
    return settings.inMenus;
  }

  function applyContext() {
    if (duckGain && context) {
      duckGain.gain.setTargetAtTime(gameContext === "paused" ? DUCK_PAUSED : 1, context.currentTime, 0.15);
    }
    if (!unlocked) {
      return;
    }
    if (wantsMusic()) {
      if (!playing) {
        play();
      }
    } else if (playing) {
      pause();
    }
  }

  /** @param {"menu"|"run"|"paused"|"dead"} value */
  function setContext(value) {
    const changed = gameContext !== value;
    gameContext = value;
    if (changed) {
      applyContext();
      notifyState();
    }
  }

  function setVolume(value) {
    settings.volume = Math.max(0, Math.min(1, value));
    if (musicGain && context) {
      musicGain.gain.setTargetAtTime(settings.volume, context.currentTime, 0.05);
    }
    persist();
    notifyState();
  }

  function setSetting(key, value) {
    if (!(key in DEFAULT_SETTINGS) || key === "disabled") {
      return;
    }
    settings[key] = value;
    if (key === "volume") {
      setVolume(value);
      return;
    }
    if (key === "shuffle") {
      rebuildQueue();
    }
    persist();
    if (key === "source" || key === "inMenus" || key === "inRuns") {
      applyContext();
    }
    notifyState();
  }

  /** Include / exclude a track from rotation (at least one stays on). */
  function toggleTrack(id) {
    const disabled = new Set(settings.disabled);
    if (disabled.has(id)) {
      disabled.delete(id);
    } else if (catalog.length - disabled.size > 1) {
      disabled.add(id);
    }
    settings.disabled = [...disabled];
    rebuildQueue();
    persist();
    notifyState();
  }

  function setAllTracks(enabled) {
    settings.disabled = enabled ? [] : catalog.slice(1).map((track) => track.id);
    rebuildQueue();
    persist();
    notifyState();
  }

  /** Only `id` stays in rotation. */
  function solo(id) {
    settings.disabled = catalog.filter((track) => track.id !== id).map((track) => track.id);
    rebuildQueue();
    persist();
    notifyState();
  }

  // ── OS media controls ──────────────────────────────────────────────────
  function updateMediaSession() {
    const session = navigator.mediaSession;
    if (!session || !current || typeof MediaMetadata === "undefined") {
      return;
    }
    const absolute = (path) => new URL(path, location.href).href;
    session.metadata = new MediaMetadata({
      title: trackLabel(current),
      artist: current.artist,
      album: current.album,
      artwork: [
        { src: absolute(current.cover.small), sizes: "128x128", type: "image/jpeg" },
        { src: absolute(current.cover.large), sizes: "512x512", type: "image/jpeg" },
      ],
    });
  }
  if (navigator.mediaSession) {
    const handlers = { play: () => play(), pause, nexttrack: next, previoustrack: prev };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Unsupported action.
      }
    }
  }

  return {
    catalog,
    play,
    pause,
    toggle,
    next,
    prev,
    seek,
    setVolume,
    setSetting,
    toggleTrack,
    setAllTracks,
    solo,
    setContext,
    getState: state,
    isEnabled: (id) => !settings.disabled.includes(id),
    /** Soundtrack owns music during runs (else the synth score plays). */
    ownsRunMusic: () => settings.source === "soundtrack" && settings.inRuns,
    wantsSynthInRuns: () => settings.source === "synth",
    /** Frequency bins (0–255), or null before the graph exists. */
    getSpectrum() {
      if (!analyser) {
        return null;
      }
      analyser.getByteFrequencyData(spectrum);
      return spectrum;
    },
    on(type, fn) {
      listeners[type]?.add(fn);
      return () => listeners[type]?.delete(fn);
    },
  };
}
