import "./musicPlayer.css";
import { MUSIC_SOURCES } from "../../audio/createMusicPlayer.js";
import { formatTime, trackLabel } from "../../audio/musicCatalog.js";
import { getSfxVolume, setSfxVolume } from "../../audio/audioState.js";

/**
 * Soundtrack UI (EA FC "tracks" style): the full catalog screen, the pause
 * mini player and the now-playing toast. Controls are `data-music="…"`
 * attributes handled by bindMusicControls(); live fields are
 * `data-music-live="…"` and refresh from player state events + a rAF loop
 * (progress / visualizer) only while a player view is on screen.
 */

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5v14l10-7zM15 5h3v14h-3z"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 5v14l-10-7zM6 5h3v14H6z"/></svg>',
  shuffle:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 4h4v4h-2V7.4l-4.3 4.3-1.4-1.4L16.6 6H16zM4 6h3.5l10.5 10.5V16h2v4h-4v-2h.6L7 8.4H4zm0 12h3.4l2.6-2.6 1.4 1.4L8.2 20H4z"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
  note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3v11.3A3.5 3.5 0 1 0 11 17V8h7V3z"/></svg>',
};

const pad2 = (value) => String(value).padStart(2, "0");
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function eqBars(count = 4) {
  return `<span class="mu-eq" aria-hidden="true">${"<i></i>".repeat(count)}</span>`;
}

function toggleRow(key, label, hint, on) {
  return `<button type="button" class="mu-switch${on ? " is-on" : ""}" data-music="set:${key}" aria-pressed="${on}">
    <span><b>${label}</b><em>${hint}</em></span><i></i>
  </button>`;
}

/** Full catalog screen. */
export function renderMusicScreen(player, { back = "menu" } = {}) {
  const { track, settings } = player.getState();
  const catalog = player.catalog;
  const inRotation = catalog.filter((t) => player.isEnabled(t.id)).length;
  const rows = catalog
    .map((t) => {
      const on = player.isEnabled(t.id);
      return `<div class="mu-row${t === track ? " is-current" : ""}${on ? "" : " is-off"}" data-music="track:${t.id}" role="button" tabindex="0">
        <span class="mu-idx"><b>${t.no ? pad2(t.no) : "B"}</b>${eqBars(3)}</span>
        <img class="mu-thumb" src="${t.cover.small}" alt="" loading="lazy" />
        <span class="mu-row-text"><b>${esc(t.title)}${t.version ? ` <em>${esc(t.version)}</em>` : ""}</b><span>${esc(t.artist)}</span></span>
        <span class="mu-genre t-meta">${esc(t.genre ?? t.album)}</span>
        <span class="mu-dur">${formatTime(t.duration)}</span>
        <button type="button" class="mu-rot${on ? " is-on" : ""}" data-music="rot:${t.id}" aria-pressed="${on}" title="${on ? "In rotation — click to skip" : "Skipped — click to add back"}">${on ? ICONS.check : ICONS.plus}</button>
      </div>`;
    })
    .join("");
  const sources = MUSIC_SOURCES.map(
    (s) => `<button type="button" class="mu-seg${settings.source === s.id ? " is-on" : ""}" data-music="source:${s.id}">${s.label}</button>`,
  ).join("");
  return `
    <div class="music-ticket">
      <div class="mu-backdrop" data-music-live="backdrop" style="background-image:url('${track?.cover.large ?? catalog[0].cover.large}')"></div>
      <div class="mt-head">
        <div class="tk-tag"><span class="t-meta">SOUNDTRACK // ${catalog.length} TRACKS</span><span class="mt-title">MUSIC</span></div>
        <button class="mt-back" data-action="${back}"><span>←</span><span>BACK</span></button>
      </div>
      <div class="mu-layout">
        <section class="mu-now">
          <div class="mu-art">
            <div class="mu-vinyl${settings.source === "soundtrack" ? "" : " is-stopped"}" data-music-live="vinyl"><i></i></div>
            <img class="mu-cover" data-music-live="cover" src="${track?.cover.large ?? catalog[0].cover.large}" alt="Album cover" />
            <span class="mu-album-tag t-meta" data-music-live="album">${esc(track?.album ?? catalog[0].album)}</span>
          </div>
          <div class="mu-meta">
            <span class="t-meta mu-status"><span data-music-live="status">NOW PLAYING</span>${eqBars(4)}</span>
            <b class="mu-title" data-music-live="title">${esc(track ? trackLabel(track) : "Press play")}</b>
            <span class="mu-artist" data-music-live="artist">${esc(track ? `${track.artist} — ${track.album}` : catalog[0].artist)}</span>
            <canvas class="mu-viz" width="320" height="56" data-music-live="viz"></canvas>
            <div class="mu-progress" data-music="seek"><i data-music-live="progress"></i></div>
            <div class="mu-times t-meta"><span data-music-live="time">0:00</span><span data-music-live="duration">${formatTime(track?.duration)}</span></div>
            <div class="mu-controls">
              <button type="button" class="mu-btn mu-shuffle${settings.shuffle ? " is-on" : ""}" data-music="set:shuffle" aria-pressed="${settings.shuffle}" title="Shuffle">${ICONS.shuffle}</button>
              <button type="button" class="mu-btn" data-music="prev" title="Previous">${ICONS.prev}</button>
              <button type="button" class="mu-btn mu-play" data-music="toggle" data-music-live="play" title="Play / pause">${ICONS.play}</button>
              <button type="button" class="mu-btn" data-music="next" title="Next (N)">${ICONS.next}</button>
              <label class="mu-volume" title="Music volume">${ICONS.note}<input type="range" min="0" max="1" step="0.01" value="${settings.volume}" data-music="volume" aria-label="Music volume" /></label>
              <label class="mu-volume mu-volume--sfx" title="Sound effects volume"><span class="t-meta">SFX</span><input type="range" min="0" max="1" step="0.01" value="${getSfxVolume()}" data-music="sfx" aria-label="Sound effects volume" /></label>
            </div>
          </div>
        </section>
        <section class="mu-list">
          <div class="mu-list-head">
            <span class="t-meta">TRACKLIST · <b data-music-live="rotation">${inRotation}</b>/${catalog.length} IN ROTATION</span>
            <span class="mu-list-actions"><button type="button" class="t-meta" data-music="all:on">ALL ON</button><button type="button" class="t-meta" data-music="all:off">SOLO CURRENT</button></span>
          </div>
          <div class="mu-rows">${rows}</div>
        </section>
      </div>
      <section class="mu-settings">
        <div class="mu-set-group">
          <span class="t-meta">MUSIC SOURCE</span>
          <div class="mu-segs">${sources}</div>
          <span class="mu-set-hint t-meta">${
            settings.source === "synth"
              ? "PROCEDURAL SCORE THAT REACTS TO COMBO + BOSS FIGHTS"
              : settings.source === "off"
                ? "SOUND EFFECTS ONLY"
                : "LICENSED SOUNDTRACK · PRESS N IN-RUN TO SKIP"
          }</span>
        </div>
        <div class="mu-switches">
          ${toggleRow("inMenus", "MENUS", "Play in menus", settings.inMenus)}
          ${toggleRow("inRuns", "RUNS", "Play during runs", settings.inRuns)}
          ${toggleRow("notify", "POP-UPS", "Now playing cards", settings.notify)}
          ${toggleRow("crossfade", "CROSSFADE", "Blend track changes", settings.crossfade)}
        </div>
      </section>
    </div>`;
}

/** Compact player for the pause screen. */
export function renderMiniPlayer(player) {
  const { track, settings } = player.getState();
  if (settings.source !== "soundtrack") {
    return `<div class="mu-mini is-empty"><span class="t-meta">MUSIC: ${settings.source === "synth" ? "SYNTH SCORE" : "OFF"}</span><button type="button" class="mu-mini-all" data-action="music">SOUNDTRACK →</button></div>`;
  }
  return `<div class="mu-mini">
    <img data-music-live="cover" src="${track?.cover.small ?? player.catalog[0].cover.small}" alt="" />
    <span class="mu-mini-text"><span class="t-meta">${eqBars(3)} NOW PLAYING</span><b data-music-live="title">${esc(track ? trackLabel(track) : "—")}</b><div class="mu-progress mu-progress--mini" data-music="seek"><i data-music-live="progress"></i></div></span>
    <span class="mu-mini-controls">
      <button type="button" class="mu-btn" data-music="prev" title="Previous">${ICONS.prev}</button>
      <button type="button" class="mu-btn mu-play" data-music="toggle" data-music-live="play" title="Play / pause">${ICONS.play}</button>
      <button type="button" class="mu-btn" data-music="next" title="Next">${ICONS.next}</button>
    </span>
    <button type="button" class="mu-mini-all" data-action="music">ALL TRACKS →</button>
  </div>`;
}

/**
 * Wire controls + live fields inside `root`. Returns an unbind function.
 * @param {HTMLElement} root
 * @param {ReturnType<import("../../audio/createMusicPlayer.js").createMusicPlayer>} player
 * @param {{ onRerender?: () => void }} [options]  full re-render (settings that change layout)
 */
export function bindMusicControls(root, player, { onRerender } = {}) {
  let raf = 0;
  let alive = true;

  function syncLive(state = player.getState()) {
    const { track, playing, time, duration, settings } = state;
    for (const el of root.querySelectorAll("[data-music-live]")) {
      const key = el.dataset.musicLive;
      if (key === "play") {
        el.innerHTML = playing ? ICONS.pause : ICONS.play;
        el.classList.toggle("is-playing", playing);
      } else if (key === "progress") {
        el.style.transform = `scaleX(${duration > 0 ? Math.min(1, time / duration) : 0})`;
      } else if (key === "time") {
        el.textContent = formatTime(time);
      } else if (key === "duration") {
        el.textContent = formatTime(duration);
      } else if (!track) {
        continue;
      } else if (key === "title") {
        el.textContent = trackLabel(track);
      } else if (key === "artist") {
        el.textContent = `${track.artist} — ${track.album}`;
      } else if (key === "album") {
        el.textContent = track.album;
      } else if (key === "cover") {
        const src = el.closest(".mu-mini") ? track.cover.small : track.cover.large;
        if (el.getAttribute("src") !== src) {
          el.setAttribute("src", src);
        }
      } else if (key === "backdrop") {
        el.style.backgroundImage = `url('${track.cover.large}')`;
      } else if (key === "status") {
        el.textContent = playing ? "NOW PLAYING" : "PAUSED";
      } else if (key === "vinyl") {
        el.classList.toggle("is-stopped", !playing);
      } else if (key === "rotation") {
        el.textContent = String(player.catalog.filter((t) => player.isEnabled(t.id)).length);
      }
    }
    root.classList.toggle("mu-is-playing", playing);
    for (const row of root.querySelectorAll(".mu-row")) {
      const id = row.dataset.music.slice(6);
      row.classList.toggle("is-current", track?.id === id);
      const on = player.isEnabled(id);
      row.classList.toggle("is-off", !on);
      const rot = row.querySelector(".mu-rot");
      if (rot && rot.classList.contains("is-on") !== on) {
        rot.classList.toggle("is-on", on);
        rot.setAttribute("aria-pressed", String(on));
        rot.innerHTML = on ? ICONS.check : ICONS.plus;
      }
    }
    for (const el of root.querySelectorAll('[data-music^="set:"]')) {
      const on = Boolean(settings[el.dataset.music.slice(4)]);
      el.classList.toggle("is-on", on);
      el.setAttribute("aria-pressed", String(on));
    }
  }

  const viz = root.querySelector('[data-music-live="viz"]');
  const vizCtx = viz?.getContext("2d");
  const levels = new Float32Array(28);

  function drawViz(playing) {
    if (!vizCtx) {
      return;
    }
    const bins = player.getSpectrum();
    const { width, height } = viz;
    vizCtx.clearRect(0, 0, width, height);
    const bars = levels.length;
    const gap = 3;
    const barW = (width - gap * (bars - 1)) / bars;
    for (let i = 0; i < bars; i++) {
      // Log-ish bin spread so the bass doesn't hog every bar.
      const bin = bins ? bins[Math.min(bins.length - 1, Math.floor(Math.pow(i / bars, 1.6) * bins.length * 0.8) + 1)] / 255 : 0;
      const target = playing ? bin : 0;
      levels[i] += (target - levels[i]) * 0.35;
      const h = Math.max(2, levels[i] * height);
      vizCtx.fillStyle = i % 5 === 0 ? "#ff4f74" : "#d9ff3b";
      vizCtx.fillRect(i * (barW + gap), height - h, barW, h);
    }
  }

  function tick() {
    if (!alive) {
      return;
    }
    const state = player.getState();
    for (const el of root.querySelectorAll('[data-music-live="progress"]')) {
      el.style.transform = `scaleX(${state.duration > 0 ? Math.min(1, state.time / state.duration) : 0})`;
    }
    for (const el of root.querySelectorAll('[data-music-live="time"]')) {
      el.textContent = formatTime(state.time);
    }
    drawViz(state.playing);
    raf = requestAnimationFrame(tick);
  }

  function onClick(event) {
    const el = event.target.closest("[data-music]");
    if (!el || !root.contains(el) || el.tagName === "INPUT") {
      return;
    }
    event.stopPropagation();
    const [cmd, arg] = el.dataset.music.split(/:(.*)/s);
    if (cmd === "toggle") {
      player.toggle();
    } else if (cmd === "next") {
      player.next();
    } else if (cmd === "prev") {
      player.prev();
    } else if (cmd === "seek") {
      const rect = el.getBoundingClientRect();
      player.seek((event.clientX - rect.left) / rect.width);
    } else if (cmd === "rot") {
      player.toggleTrack(arg);
    } else if (cmd === "track") {
      player.play(arg);
    } else if (cmd === "set") {
      player.setSetting(arg, !player.getState().settings[arg]);
    } else if (cmd === "source") {
      player.setSetting("source", arg);
      onRerender?.();
    } else if (cmd === "all") {
      if (arg === "on") {
        player.setAllTracks(true);
      } else {
        // Solo the current track (or the first) in rotation.
        player.solo(player.getState().track?.id ?? player.catalog[0].id);
      }
    }
  }

  function onInput(event) {
    if (event.target.dataset?.music === "volume") {
      player.setVolume(Number(event.target.value));
    } else if (event.target.dataset?.music === "sfx") {
      setSfxVolume(Number(event.target.value));
    }
  }

  function onKey(event) {
    if ((event.key === "Enter" || event.key === " ") && event.target.classList?.contains("mu-row")) {
      event.preventDefault();
      player.play(event.target.dataset.music.slice(6));
    }
  }

  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  root.addEventListener("keydown", onKey);
  const offState = player.on("state", syncLive);
  syncLive();
  raf = requestAnimationFrame(tick);

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    offState();
    root.removeEventListener("click", onClick);
    root.removeEventListener("input", onInput);
    root.removeEventListener("keydown", onKey);
  };
}

/** EA FC-style "now playing" card that slides in on every new track. */
export function createNowPlayingToast(player, { isSuppressed = () => false } = {}) {
  const root = document.createElement("div");
  root.className = "np-toast";
  root.setAttribute("aria-live", "polite");
  root.innerHTML = `
    <img class="np-cover" alt="" />
    <span class="np-text">
      <span class="t-meta np-label">${eqBars(4)} NOW PLAYING</span>
      <b class="np-title"></b>
      <span class="np-artist"></span>
    </span>
    <span class="np-stripe" aria-hidden="true"></span>`;
  document.body.appendChild(root);
  const cover = root.querySelector(".np-cover");
  const title = root.querySelector(".np-title");
  const artist = root.querySelector(".np-artist");
  let timer = 0;

  player.on("track", (track) => {
    const { settings } = player.getState();
    if (!settings.notify || settings.source !== "soundtrack" || isSuppressed()) {
      return;
    }
    cover.src = track.cover.small;
    title.textContent = trackLabel(track);
    artist.textContent = `${track.artist} · ${track.album}`;
    root.classList.remove("is-visible");
    // Restart the entrance animation.
    void root.offsetWidth;
    root.classList.add("is-visible");
    clearTimeout(timer);
    timer = setTimeout(() => root.classList.remove("is-visible"), 5200);
  });

  function hide() {
    clearTimeout(timer);
    root.classList.remove("is-visible");
  }

  return { root, hide };
}
