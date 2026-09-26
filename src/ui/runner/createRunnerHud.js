import "@fontsource/barlow-condensed/latin-600.css";
import "@fontsource/barlow-condensed/latin-800.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "./runnerHud.css";
import { WEAPONS } from "../../weapon/weaponTypes.js";
import { SPECIALS } from "../../weapon/createSpecials.js";
import { GAME_TITLE_LINES, STORY } from "../../app/credits.js";
import { RUNNER } from "../../runner/runnerConfig.js";
import { renderArmory, renderMissions, renderRecords, renderRewards, renderUpgradePicker } from "./metaScreens.js";
import { bindMusicControls, createNowPlayingToast, eqBars, renderMiniPlayer, renderMusicScreen } from "./musicPlayerUi.js";
import { trackLabel } from "../../audio/musicCatalog.js";

const ARROW_COUNT = 8;
const MAG_TICKS = 32;

function el(tag, className, parent, html) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (html !== undefined) {
    node.innerHTML = html;
  }
  parent?.appendChild(node);
  return node;
}

/** Deterministic pseudo-random barcode as inline SVG (ticket stub motif). */
function barcode(seed = 7, bars = 46, { height = 34 } = {}) {
  let s = seed * 9301 + 49297;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  let x = 0;
  let rects = "";
  for (let i = 0; i < bars; i++) {
    const w = rand() < 0.3 ? 3 : rand() < 0.6 ? 2 : 1;
    if (i % 2 === 0) {
      rects += `<rect x="${x}" y="0" width="${w}" height="${height}"/>`;
    }
    x += w + (rand() < 0.5 ? 1 : 2);
  }
  return `<svg class="t-barcode" viewBox="0 0 ${x} ${height}" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>`;
}

const pad = (value, length) => String(Math.max(0, Math.floor(value))).padStart(length, "0");

/** Restart a one-shot CSS animation class (bumps, pops). */
function bump(node, className = "is-bump") {
  if (!node) {
    return;
  }
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/**
 * Count the first number inside each element up from 0 (keeps zero padding,
 * prefix and suffix text, and child elements like <em>).
 */
function countUp(nodes, duration = 900, delay = 150) {
  const items = [];
  for (const node of nodes) {
    const text = [...node.childNodes].find((child) => child.nodeType === 3 && /\d/.test(child.textContent));
    const match = text?.textContent.match(/^(\D*)(\d+)(.*)$/s);
    if (!match) {
      continue;
    }
    const [, prefix, digits, suffix] = match;
    items.push({ text, prefix, suffix, target: Number(digits), width: digits.length });
    text.textContent = `${prefix}${"0".padStart(digits.length, "0")}${suffix}`;
  }
  if (!items.length) {
    return;
  }
  const start = performance.now() + delay;
  const tick = (now) => {
    const t = Math.min(1, Math.max(0, (now - start) / duration));
    const k = easeOutCubic(t);
    for (const item of items) {
      item.text.textContent = `${item.prefix}${pad(item.target * k, item.width)}${item.suffix}`;
    }
    if (t < 1) {
      requestAnimationFrame(tick);
    }
  };
  requestAnimationFrame(tick);
}

/** Give staggered children an index (CSS uses --i for animation-delay). */
function stagger(root, selector) {
  root.querySelectorAll(selector).forEach((node, index) => {
    node.style.setProperty("--i", String(Math.min(index, 14)));
  });
}

/**
 * Mission list for the briefing / menu / game-over tickets.
 * @param {Array<{text:string,value:number,target:number,done:boolean,xp:number,shards:number}>} list
 */
function renderOrders(list, { title = "TODAY'S ORDERS", note = "" } = {}) {
  if (!list?.length) {
    return "";
  }
  const rows = list
    .map((m) => {
      const value = Math.min(m.target, Math.floor(m.value ?? 0));
      const frac = m.target > 0 ? value / m.target : 0;
      return `<div class="ord-row${m.done ? " is-done" : ""}">
        <i class="ord-check" aria-hidden="true"></i>
        <b>${m.text}</b>
        <span class="t-meta ord-num">${m.done ? "COMPLETE" : `${value} / ${m.target}`}</span>
        <span class="t-meta ord-reward">+${m.xp} XP · +${m.shards} ◆</span>
        <span class="ord-bar"><i style="transform:scaleX(${frac.toFixed(3)})"></i></span>
      </div>`;
    })
    .join("");
  return `<div class="ord-list">
    <div class="ord-head"><span class="t-meta">${title}</span>${note ? `<span class="t-meta">${note}</span>` : ""}</div>
    ${rows}
  </div>`;
}

/**
 * DOM HUD + start / pause / game-over screens. Visual language: transit
 * ticket / utility label — acid lime, cobalt, paper, ink, notched tabs,
 * condensed display numerals, mono metadata, barcodes and dot grids.
 * Pure view: the game calls update() with plain numbers each frame.
 */
export function createRunnerHud({ isTouch = false, music = null } = {}) {
  document.documentElement.classList.add("runner-mode");
  const root = el("div", "runner-hud", document.body);
  const handlers = {
    start: null,
    restart: null,
    resume: null,
    pause: null,
    weapon: null,
    special: null,
    fire: null,
    specialSelect: null,
    action: null,
  };
  root.classList.toggle("is-touch", isTouch);
  document.documentElement.classList.toggle("runner-touch", isTouch);

  // ── Crosshair ──────────────────────────────────────────────────────────
  const crosshair = el("div", "rh-crosshair", root,
    '<i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i><i class="dot"></i>');
  const hitmarker = el("div", "rh-hitmarker", root, "<i></i><i></i><i></i><i></i>");

  // ── Score ticket (top-left) ──────────────────────────────────────────────
  const ticket = el("div", "rh-card rh-ticket", root);
  ticket.innerHTML = `
    <div class="t-strip"><span>${STORY.player.toUpperCase()}</span><span class="rh-sector">SECTOR 01</span><span class="rh-clock">00:00</span></div>
    <div class="t-body">
      <span class="t-meta">SCORE:</span>
      <span class="t-big rh-score-value">000000</span>
      <div class="t-grid">
        <div><span class="t-meta">DIST.</span><b class="rh-dist">0000</b><em>M</em></div>
        <div><span class="t-meta">SPEED</span><b class="rh-speed">000</b><em>KM/H</em></div>
        <div class="t-combo"><span class="t-meta">COMBO</span><b class="rh-combo">×1.0</b></div>
      </div>
    </div>
    <div class="t-stub">${barcode(11, 54, { height: 18 })}<span class="t-code">//OE-${STORY.year}-<b class="rh-code">0000</b></span></div>`;
  const scoreValue = ticket.querySelector(".rh-score-value");
  const distValue = ticket.querySelector(".rh-dist");
  const speedValue = ticket.querySelector(".rh-speed");
  const comboValue = ticket.querySelector(".rh-combo");
  const comboCell = ticket.querySelector(".t-combo");
  const codeValue = ticket.querySelector(".rh-code");
  const sectorValue = ticket.querySelector(".rh-sector");
  const clockValue = ticket.querySelector(".rh-clock");

  // ── Vitals label (bottom-left) ─────────────────────────────────────────
  const vitals = el("div", "rh-card rh-vitals", root);
  vitals.innerHTML = `
    <div class="v-head"><span class="t-meta">${STORY.player.toUpperCase()} // SIM LINK</span><span class="t-meta">${STORY.year}</span></div>
    <div class="v-row">
      <span class="v-label">SHIELD</span>
      <div class="v-bar shield"><b class="v-trail"></b><i></i></div>
      <b class="v-num rh-shield-num">060</b>
    </div>
    <div class="v-row">
      <span class="v-label">INTEGRITY</span>
      <div class="v-bar health"><b class="v-trail"></b><i></i></div>
      <b class="v-num rh-health-num">100</b>
    </div>`;
  const shieldBar = vitals.querySelector(".v-bar.shield i");
  const healthBar = vitals.querySelector(".v-bar.health i");
  const shieldNum = vitals.querySelector(".rh-shield-num");
  const shieldTrail = vitals.querySelector(".v-bar.shield .v-trail");
  const healthTrail = vitals.querySelector(".v-bar.health .v-trail");
  const trail = { shield: 1, health: 1 };
  let scoreShown = 0;
  const healthNum = vitals.querySelector(".rh-health-num");

  // ── Ammo label (bottom-right) ──────────────────────────────────────────
  const ammo = el("div", "rh-card rh-ammo", root);
  ammo.innerHTML = `
    <div class="a-tab"><span class="rh-weapon-name">CARBINE</span><span class="rh-weapon-code">VX-06</span></div>
    <div class="a-body">
      <div class="a-count"><b class="rh-ammo-num">32</b><span class="rh-mag">/ 32</span></div>
      <div class="a-status t-meta rh-ammo-status">READY</div>
    </div>
    <div class="a-mag">${'<i></i>'.repeat(MAG_TICKS)}</div>
    <div class="a-reload"><i></i></div>
    <div class="a-special"><span class="a-special-name t-meta">ALLY DRONE</span><div class="a-special-bar"><i></i></div><kbd class="a-special-key">E</kbd></div>`;
  const ammoNum = ammo.querySelector(".rh-ammo-num");
  const specialRow = ammo.querySelector(".a-special");
  const specialName = ammo.querySelector(".a-special-name");
  const specialBar = ammo.querySelector(".a-special-bar i");

  // Touch: hold-to-fire button (bottom-right) + special button that only
  // appears when the special is charged. A ring around FIRE shows charge.
  const touchControls = el("div", "rh-touch-controls", root);
  const specialButton = el("button", "rh-special-btn", touchControls, '<span class="t-meta">SPECIAL</span><b>ALLY</b>');
  specialButton.type = "button";
  const fireButton = el("button", "rh-fire-btn", touchControls, '<svg viewBox="0 0 100 100" aria-hidden="true"><circle class="ring-bg" cx="50" cy="50" r="46"/><circle class="ring" cx="50" cy="50" r="46"/></svg><b class="rh-fire-ammo">32</b><span class="t-meta">FIRE</span>');
  fireButton.type = "button";
  const fireRing = fireButton.querySelector(".ring");
  const fireAmmo = fireButton.querySelector(".rh-fire-ammo");
  const specialLabel = specialButton.querySelector("b");
  const RING_LENGTH = 2 * Math.PI * 46;
  fireRing.style.strokeDasharray = `${RING_LENGTH}`;
  const firePointers = new Set();
  const releaseFire = (event) => {
    firePointers.delete(event.pointerId);
    if (firePointers.size === 0) {
      fireButton.classList.remove("is-down");
      handlers.fire?.(false);
    }
  };
  fireButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    firePointers.add(event.pointerId);
    try {
      fireButton.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture is best-effort (fails for synthetic / already-released pointers).
    }
    fireButton.classList.add("is-down");
    handlers.fire?.(true);
  });
  fireButton.addEventListener("pointerup", releaseFire);
  fireButton.addEventListener("pointercancel", releaseFire);
  fireButton.addEventListener("lostpointercapture", releaseFire);
  specialButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    handlers.special?.();
  });
  // Sky Run hull gauge (bottom-centre while flying the car).
  const flightPanel = el("div", "rh-flight", root, `
    <div class="fl-head"><span class="t-meta">SKY RUN</span><span class="t-meta fl-mark">QUADRA MK-I</span><b class="fl-mult">×1.5</b><span class="t-meta fl-time">00.0S</span></div>
    <div class="fl-bar"><b class="fl-trail"></b><i></i></div>
    <div class="fl-foot"><span class="t-meta">HULL</span><b class="fl-num">100</b></div>`);
  const flightFill = flightPanel.querySelector(".fl-bar i");
  const flightTrail = flightPanel.querySelector(".fl-trail");
  const flightNum = flightPanel.querySelector(".fl-num");
  const flightTime = flightPanel.querySelector(".fl-time");
  const flightMark = flightPanel.querySelector(".fl-mark");
  let flightTrailValue = 1;
  function setFlight(data) {
    flightPanel.classList.toggle("is-visible", Boolean(data));
    if (!data) {
      flightTrailValue = 1;
      return;
    }
    const hull = Math.max(0, Math.min(1, data.hull));
    flightFill.style.transform = `scaleX(${hull})`;
    // Trail catches up to show the chunk just lost.
    flightTrailValue = Math.max(hull, flightTrailValue - 0.012);
    flightTrail.style.transform = `scaleX(${flightTrailValue})`;
    flightNum.textContent = `${Math.ceil(data.hp ?? hull * 100)}${data.max ? ` / ${Math.round(data.max)}` : ""}`;
    flightMark.textContent = `QUADRA MK-${data.mark ?? "I"}`;
    flightTime.textContent = `${(data.time ?? 0).toFixed(1).padStart(4, "0")}S`;
    flightPanel.classList.toggle("is-low", hull < 0.3);
    if (data.hit) {
      flightPanel.classList.remove("is-hit");
      void flightPanel.offsetWidth;
      flightPanel.classList.add("is-hit");
    }
  }

  // ── Orders: live mission tracker (left, under the score ticket) ──────
  const orders = el("div", "rh-card rh-orders", root, `
    <div class="o-head"><span class="t-meta">ORDERS //</span><b class="o-count">0/3</b></div>
    <div class="o-rows"></div>`);
  const orderRows = orders.querySelector(".o-rows");
  const orderCount = orders.querySelector(".o-count");
  const orderState = new Map();
  // Sits right under the score ticket (touch: under the compact vitals).
  const orderAnchor = isTouch ? vitals : ticket;
  const placeOrders = () => {
    orders.style.top = `${orderAnchor.offsetTop + orderAnchor.offsetHeight + 10}px`;
  };
  new ResizeObserver(placeOrders).observe(orderAnchor);
  window.addEventListener("resize", placeOrders);

  /**
   * @param {Array<{id:string,text:string,value:number,target:number,done:boolean}>|null} list
   *   Live mission progress; rows tick / flash as values rise.
   */
  function setMissions(list) {
    orders.classList.toggle("has-missions", Boolean(list?.length));
    if (!list?.length) {
      return;
    }
    const ids = list.map((m) => m.id).join(",");
    if (orders.dataset.ids !== ids) {
      orders.dataset.ids = ids;
      orderState.clear();
      orderRows.innerHTML = list
        .map((m) => `<div class="o-row" data-id="${m.id}">
          <i class="o-check" aria-hidden="true"></i>
          <span class="o-text">${m.text}</span>
          <b class="o-num"></b>
          <span class="o-bar"><i></i></span>
        </div>`)
        .join("");
    }
    let done = 0;
    let focus = null;
    let focusFrac = -1;
    for (const m of list) {
      const row = orderRows.querySelector(`[data-id="${m.id}"]`);
      if (!row) {
        continue;
      }
      const value = Math.min(m.target, Math.floor(m.value));
      const frac = m.target > 0 ? value / m.target : 0;
      const prev = orderState.get(m.id);
      if (!prev || prev.value !== value || prev.done !== m.done) {
        row.querySelector(".o-bar i").style.transform = `scaleX(${frac.toFixed(3)})`;
        row.querySelector(".o-num").textContent = m.done ? "DONE" : `${value}/${m.target}`;
        row.classList.toggle("is-done", m.done);
        row.classList.toggle("is-near", !m.done && frac >= 0.75);
        // Progress ticks flash the row; the first sync is silent.
        if (prev && value > prev.value && !m.done) {
          bump(row, "is-tick");
        }
        if (prev && m.done && !prev.done) {
          bump(row, "is-complete");
        }
        orderState.set(m.id, { value, done: m.done });
      }
      if (m.done) {
        done += 1;
      } else if (frac > focusFrac) {
        focus = row;
        focusFrac = frac;
      }
    }
    for (const row of orderRows.children) {
      row.classList.toggle("is-focus", row === focus);
    }
    orderCount.textContent = `${done}/${list.length}`;
    orders.classList.toggle("is-all-done", done === list.length);
  }

  // Mission complete: big centre stamp (queued if several land at once).
  const missionStamp = el("div", "rh-mission", root, `
    <span class="rm-label t-meta">ORDER FILLED</span>
    <b class="rm-title">MISSION COMPLETE</b>
    <span class="rm-text"></span>
    <span class="rm-reward t-meta"></span>`);
  const stampQueue = [];
  let stampTimer = 0;
  function showNextStamp() {
    const m = stampQueue.shift();
    if (!m) {
      missionStamp.classList.remove("is-on");
      return;
    }
    missionStamp.querySelector(".rm-text").textContent = m.text;
    missionStamp.querySelector(".rm-reward").textContent = `+${m.xp} XP · +${m.shards} ◆ AT RUN END`;
    bump(missionStamp, "is-on");
    stampTimer = setTimeout(showNextStamp, 2600);
  }
  function missionComplete(mission) {
    stampQueue.push(mission);
    if (!missionStamp.classList.contains("is-on")) {
      clearTimeout(stampTimer);
      showNextStamp();
    }
  }

  // ── Mini music player (top-right): album art + title + progress ─────
  const miniMusic = music
    ? el("div", "rh-music", root, `
      <img class="rmu-cover" alt="" />
      <span class="rmu-text"><span class="t-meta rmu-status">${eqBars(3)}<span class="rmu-state">NOW PLAYING</span></span><b class="rmu-title"></b></span>
      <span class="rmu-progress"><i></i></span>`)
    : null;
  const miniCover = miniMusic?.querySelector(".rmu-cover");
  const miniTitle = miniMusic?.querySelector(".rmu-title");
  const miniState = miniMusic?.querySelector(".rmu-state");
  const miniProgress = miniMusic?.querySelector(".rmu-progress i");
  function syncMiniMusic(state = music.getState()) {
    const { track, playing, settings } = state;
    const show = settings.source === "soundtrack" && Boolean(track);
    miniMusic.classList.toggle("is-visible", show);
    if (!show) {
      return;
    }
    if (miniCover.getAttribute("src") !== track.cover.small) {
      miniCover.setAttribute("src", track.cover.small);
      bump(miniMusic, "is-new");
    }
    const label = trackLabel(track);
    if (miniTitle.textContent !== label) {
      miniTitle.textContent = label;
      miniTitle.title = `${label} — ${track.artist}`;
    }
    miniState.textContent = playing ? "NOW PLAYING" : "PAUSED";
    miniMusic.classList.toggle("is-paused", !playing);
  }
  /**
   * Desktop: sit in the header row, just left of the ABOUT button (layout
   * offsets, so the header's slide-in transform doesn't matter). Touch hides
   * the header during runs, so the CSS spot beside PAUSE is used there.
   */
  function placeMiniMusic() {
    if (!miniMusic || isTouch || !miniMusic.classList.contains("is-visible")) {
      return;
    }
    const actions = document.querySelector(".app-header-actions");
    const header = actions?.offsetParent;
    if (!actions || !header || !actions.offsetWidth) {
      miniMusic.style.removeProperty("top");
      miniMusic.style.removeProperty("right");
      return;
    }
    const left = header.offsetLeft + actions.offsetLeft;
    const top = header.offsetTop + actions.offsetTop + (actions.offsetHeight - miniMusic.offsetHeight) / 2;
    miniMusic.style.right = `${Math.round(window.innerWidth - left + 12)}px`;
    miniMusic.style.top = `${Math.round(Math.max(8, top))}px`;
  }
  if (miniMusic) {
    music.on("state", (state) => {
      const wasVisible = miniMusic.classList.contains("is-visible");
      syncMiniMusic(state);
      if (!wasVisible) {
        placeMiniMusic();
      }
    });
    syncMiniMusic();
    window.addEventListener("resize", placeMiniMusic);
  }

  // Touch: pause button (top-right). Desktop pauses by releasing the mouse.
  const pauseButton = el("button", "rh-pause-btn", root, '<i></i><i></i><span class="t-meta">PAUSE</span>');
  pauseButton.type = "button";
  pauseButton.setAttribute("aria-label", "Pause");
  pauseButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    handlers.fire?.(false);
    handlers.pause?.();
  });
  const magLabel = ammo.querySelector(".rh-mag");
  const weaponName = ammo.querySelector(".rh-weapon-name");
  const weaponCode = ammo.querySelector(".rh-weapon-code");

  // Weapon chips (keys 1–4 / Q / wheel; tappable on touch).
  const chips = el("div", "rh-weapons", root);
  const chipEls = WEAPONS.map((weapon, index) => {
    const chip = el("button", "rh-chip", chips, `<b>${index + 1}</b><span>${weapon.code}</span><em>${weapon.name}</em>`);
    chip.type = "button";
    chip.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      // Touch shows only the active chip: tapping it cycles weapons.
      const isActive = chip.classList.contains("is-active");
      handlers.weapon?.(isTouch && isActive ? (index + 1) % WEAPONS.length : index);
    });
    return chip;
  });
  const ammoStatus = ammo.querySelector(".rh-ammo-status");
  const magTicks = [...ammo.querySelectorAll(".a-mag i")];
  const reloadBar = ammo.querySelector(".a-reload i");

  // ── Transient ──────────────────────────────────────────────────────────
  const banner = el("div", "rh-banner", root, '<span class="b-arrow">→</span><span class="b-text"></span><span class="b-code t-meta">N1</span>');
  const bannerText = banner.querySelector(".b-text");
  const damage = el("div", "rh-damage", root);
  const markers = Array.from({ length: 10 }, () =>
    el("div", "rh-target", root, '<i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i><span class="rh-target-label"></span><b class="rh-target-hp"><i></i></b>'),
  );
  const arrows = Array.from({ length: ARROW_COUNT }, () => el("div", "rh-arrow", root, "<i></i><span>DRN</span>"));

  // Floating score pop-ups (pooled), mission toasts, boss bar, tutorial
  // prompt and the last-chance slow-mo vignette.
  const popups = Array.from({ length: 12 }, () => el("div", "rh-pop", root));
  let popCursor = 0;
  const toasts = el("div", "rh-toasts", root);
  const bossBar = el("div", "rh-boss", root,
    '<div class="rb-head"><span class="t-meta">CARRIER // HOSTILE</span><span class="t-meta rb-state">ARMORED</span></div><div class="rb-bar"><i></i></div>');
  const bossFill = bossBar.querySelector(".rb-bar i");
  const bossState = bossBar.querySelector(".rb-state");
  const prompt = el("div", "rh-prompt", root, '<span class="t-meta">WARM-UP</span><b></b>');
  const promptText = prompt.querySelector("b");
  const slowmo = el("div", "rh-slowmo", root);
  // Speed lines: radial streaks that fade in near top speed (pure CSS layer).
  const speedLines = el("div", "rh-speedlines", root);
  let speedLinesOpacity = -1;

  const touchHint = el("div", "rh-touch-hint t-meta", root,
    "SWIPE LEFT SIDE TO MOVE — HOLD FIRE — AIM IS AUTOMATIC");
  if (isTouch) {
    touchHint.style.display = "block";
  }

  // ── Screens ─────────────────────────────────────────────────────────────
  const screen = el("div", "runner-screen", document.body);
  // EA FC-style "now playing" card on every new soundtrack track.
  const nowPlaying = music
    ? createNowPlayingToast(music, { isSuppressed: () => screen.dataset.mode === "music" })
    : null;

  const controls = isTouch
    ? [
        ["SWIPE ← →", "SWITCH LANE"],
        ["SWIPE ↑", "JUMP"],
        ["SWIPE ↓", "SLIDE"],
        ["DRAG (RIGHT)", "NUDGE AIM"],
        ["FIRE BTN", "SHOOT (AIM IS AUTO)"],
        ["TAP CHIP", "SWITCH WEAPON"],
        ["SPECIAL", "WHEN CHARGED"],
      ]
    : [
        ["A / D", "SWITCH LANE"],
        ["SPACE", "JUMP"],
        ["S / C", "SLIDE"],
        ["MOUSE", "AIM"],
        ["L-CLICK", "FIRE"],
        ["R", "RELOAD"],
        ["1–4 / Q", "WEAPON"],
        ["E", "SPECIAL"],
        ["ESC", "PAUSE"],
        ["T", "AIM ASSIST"],
      ];
  const controlsHtml = controls
    .map(([key, label]) => `<div class="k-row"><kbd>${key}</kbd><span>${label}</span></div>`)
    .join("");

  function renderSpecialPicker(selected) {
    return `
      <div class="tk-special">
        <span class="t-meta">SPECIAL // ONE PER RUN</span>
        <div class="tk-special-options">
          ${Object.values(SPECIALS)
            .map(
              (special) => `<button class="tk-special-opt${special.id === selected ? " is-selected" : ""}" data-special="${special.id}">
                <b>${special.name}</b>
                <span>${special.id === "ally" ? "DEPLOYS A DRONE THAT FIGHTS FOR YOU" : "HOMES IN ON THE NEAREST DRONE"}</span>
              </button>`,
            )
            .join("")}
        </div>
      </div>`;
  }

  function renderStart(best, special = "ally", meta = null, style = "neon") {
    const daily = meta?.daily ?? false;
    screen.innerHTML = `
      <div class="ticket ticket--start">
        <div class="tk-main">
          <div class="tk-top">
            <span class="t-meta">PLAYER<br><b>${STORY.player.toUpperCase()}</b></span>
            <span class="t-meta">YEAR<br><b>${STORY.year}</b></span>
            <span class="t-meta">SIMULATION<br><b>${STORY.world.toUpperCase()}</b></span>
            <span class="tk-arrow">↗</span>
          </div>
          <div class="tk-hero">
            <div class="tk-tag"><span class="t-meta">ON A BREAK, PLAYING:</span><span class="tk-title tk-title--brand">${GAME_TITLE_LINES.join("<br>")}</span></div>
            <div class="tk-side">
              <span class="tk-ghost">${STORY.year}</span>
              <div class="tk-keys">${controlsHtml}</div>
            </div>
          </div>
          ${renderSpecialPicker(special)}
          ${meta?.missions ? renderOrders(meta.missions, { title: "ORDERS // COMPLETE FOR XP + ◆", note: `RANK ${meta.rank}` }) : ""}
          ${meta ? `<div class="tk-nav">
            <button data-action="armory"><b>ARMORY</b><span class="t-meta">${meta.shards} ◆</span></button>
            <button data-action="missions"><b>MISSIONS</b><span class="t-meta">RANK ${meta.rank}${meta.missionsReady ? " · !" : ""}</span></button>
            <button data-action="records"><b>RECORDS</b><span class="t-meta">TOP 10</span></button>
            <button data-action="music" class="tk-music"><b>MUSIC</b><span class="t-meta">${music ? `♪ ${music.catalog.length} TRACKS` : "OFF"}</span></button>
            <button data-action="style" class="tk-style${style === "moebius" ? " is-on" : ""}" aria-pressed="${style === "moebius"}"><b>STYLE</b><span class="t-meta">${style === "moebius" ? "MOEBIUS ✎" : "NEON ◐"}</span></button>
          </div>` : ""}
          <div class="tk-foot">
            <span class="t-meta">DODGE OBSTACLES</span><span class="t-meta">COLLECT ENERGY</span><span class="t-meta">DROP THE DRONES</span><span class="t-meta">DON'T GET CAUGHT</span>
          </div>
        </div>
        <div class="tk-stub">
          <div class="tk-stub-head"><span class="t-meta">HOW FAR CAN SHE GET?</span><span class="t-meta">OE</span></div>
          <div class="tk-best"><span class="t-meta">${daily ? "DAILY BEST" : "BEST SCORE"}</span><b>${pad(daily ? meta.dailyBest : best, 6)}</b></div>
          ${meta ? `<button class="tk-daily${daily ? " is-on" : ""}" data-action="daily"><i></i><span><b>DAILY RUN</b><span class="t-meta">SAME SEED FOR EVERYONE TODAY</span></span></button>` : ""}
          <button class="tk-button" data-action="start"><span>${daily ? "DAILY DIVE" : "DIVE IN"}</span><span>→</span></button>
          ${barcode(3, 70)}
          <span class="t-code">/ / O L D - E A R T H /</span>
        </div>
      </div>`;
  }

  function renderPause() {
    screen.innerHTML = `
      <div class="label label--pause">
        <div class="lb-head"><span class="t-meta">SIM ON HOLD</span><span class="t-meta">${STORY.year}</span></div>
        <div class="lb-title">PAUSED</div>
        <div class="lb-rule"><i></i><i></i><i></i></div>
        <button class="tk-button" data-action="resume"><span>RESUME</span><span>→</span></button>
        <div class="t-meta lb-note">${isTouch ? "TAP RESUME TO CONTINUE" : "CLICK TO RE-LOCK THE MOUSE"}</div>
        ${music ? renderMiniPlayer(music) : ""}
      </div>`;
  }

  /** Random in-run snapshot (createRunSnapshots) + share / save actions. */
  function renderPhoto(photo) {
    if (!photo) {
      return "";
    }
    return `
      <figure class="go-photo-frame" data-action="photo-view" role="button" tabindex="0" title="View full screen">
        <img src="${photo.url}" alt="Snapshot from this run" />
        <span class="go-photo-expand" aria-hidden="true">⛶</span>
        <figcaption><span class="go-photo-rec">● REC</span><b>${photo.label}</b><span>${pad(photo.distance, 4)}M</span></figcaption>
      </figure>
      <div class="go-photo-actions">
        <button class="tk-button tk-button--ghost" data-action="photo-share"><span>SHARE PIC</span><span>⇪</span></button>
        <button class="tk-button tk-button--ghost go-photo-icon" data-action="photo-save" aria-label="Save photo" title="Save photo"><span>↓</span></button>
        ${photo.count > 1 ? '<button class="tk-button tk-button--ghost go-photo-icon" data-action="photo-next" aria-label="Another snapshot" title="Another snapshot"><span>⟳</span></button>' : ""}
      </div>`;
  }

  function setPhoto(photo) {
    currentPhoto = photo;
    const slot = screen.querySelector("[data-photo]");
    if (slot) {
      slot.innerHTML = renderPhoto(photo);
    }
    if (viewer.isOpen()) {
      viewer.show(photo);
    }
  }

  // ── Full-screen snapshot viewer (game over) ──────────────────────────
  let currentPhoto = null;
  const viewer = (() => {
    const el = document.createElement("div");
    el.className = "photo-viewer";
    el.hidden = true;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Snapshot viewer");
    el.innerHTML = `
      <img class="pv-img" alt="Snapshot from this run" />
      <div class="pv-top">
        <span class="pv-rec">● REC</span>
        <b class="pv-label"></b>
        <span class="t-meta pv-meta"></span>
        <button type="button" class="pv-btn pv-close" data-pv="close" aria-label="Close (Esc)">✕</button>
      </div>
      <div class="pv-bar">
        <button type="button" class="pv-btn" data-pv="another" title="Another snapshot (← / →)">⟳ ANOTHER</button>
        <button type="button" class="pv-btn" data-pv="save" title="Save photo card">↓ SAVE</button>
        <button type="button" class="pv-btn pv-btn--main" data-pv="share" title="Share photo card">SHARE PIC ⇪</button>
      </div>`;
    document.body.appendChild(el);
    const img = el.querySelector(".pv-img");
    const label = el.querySelector(".pv-label");
    const meta = el.querySelector(".pv-meta");
    const another = el.querySelector('[data-pv="another"]');

    function show(photo) {
      if (!photo) {
        return;
      }
      img.src = photo.url;
      label.textContent = photo.label;
      meta.textContent = `${pad(photo.distance, 4)} M${photo.count > 1 ? ` · ${photo.count} SHOTS THIS RUN` : ""}`;
      another.hidden = !(photo.count > 1);
    }

    function open() {
      if (!currentPhoto) {
        return;
      }
      show(currentPhoto);
      el.hidden = false;
      requestAnimationFrame(() => el.classList.add("is-open"));
      // PC: real browser fullscreen for the photo.
      if (!isTouch && el.requestFullscreen && !document.fullscreenElement) {
        el.requestFullscreen().catch(() => {});
      }
    }

    function close() {
      if (el.hidden) {
        return;
      }
      el.classList.remove("is-open");
      el.hidden = true;
      if (document.fullscreenElement === el) {
        document.exitFullscreen?.().catch(() => {});
      }
    }

    el.addEventListener("click", (event) => {
      const cmd = event.target.closest("[data-pv]")?.dataset.pv;
      if (!cmd) {
        if (event.target === el) {
          close();
        }
        return;
      }
      event.stopPropagation();
      if (cmd === "close") {
        close();
      } else if (cmd === "another") {
        handlers.action?.("photo-next", {});
      } else if (cmd === "save") {
        handlers.action?.("photo-save", {});
      } else if (cmd === "share") {
        handlers.action?.("photo-share", {});
      }
    });
    // Browser Esc leaves fullscreen first: close the viewer with it.
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement && !el.hidden) {
        close();
      }
    });
    document.addEventListener(
      "keydown",
      (event) => {
        if (el.hidden) {
          return;
        }
        if (event.key === "Escape") {
          close();
        } else if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && !another.hidden) {
          handlers.action?.("photo-next", {});
        }
        // While viewing, keys stay here (Enter would restart the run).
        if (event.key !== "Tab") {
          event.stopPropagation();
        }
      },
      { capture: true },
    );

    return { open, close, show, isOpen: () => !el.hidden };
  })();

  function renderGameOver({ score, distance, kills, best, newBest, cause, detail = "", rewards = null, meta = null, daily = false, build = [], photo = null, missions = null }) {
    currentPhoto = photo;
    const quip = STORY.quips[Math.floor(Math.random() * STORY.quips.length)];
    screen.innerHTML = `
      <div class="ticket ticket--over">
        <div class="tk-main">
          <div class="tk-top">
            <span class="t-meta">STATUS</span>
            <span class="t-meta">CAUSE<br><b>${cause}</b>${detail ? `<br><b class="go-detail">${detail}</b>` : ""}</span>
            ${daily ? '<span class="t-meta">MODE<br><b>DAILY RUN</b></span>' : ""}
            <span class="tk-arrow">↘</span>
          </div>
          <div class="tk-hero">
            <div class="tk-tag tk-tag--pink"><span class="t-meta">THE GAME CAUGHT ${STORY.player.toUpperCase()}:</span><span class="tk-title">CAUGHT<br>${pad(distance, 4)}M</span><span class="t-meta go-quip">${STORY.player.toUpperCase()}: “${quip}”</span></div>
            <div class="tk-stats">
              <div><span class="t-meta">SCORE</span><b>${pad(score, 6)}</b></div>
              <div><span class="t-meta">DISTANCE</span><b>${pad(distance, 4)}<em>M</em></b></div>
              <div><span class="t-meta">DRONES DOWN</span><b>${pad(kills, 3)}</b></div>
              <div><span class="t-meta">${newBest ? "NEW BEST ★" : "BEST"}</span><b>${pad(best, 6)}</b></div>
            </div>
          </div>
          ${renderRewards(missions && rewards ? { ...rewards, completed: [] } : rewards, meta ?? { shards: 0, rank: 1 })}
          ${renderOrders(missions, { title: "ORDERS // THIS RUN", note: missions?.some((m) => m.done) ? "REWARDS BANKED ✓" : "KEEP PUSHING" })}
          ${build.length ? `<div class="go-build"><span class="t-meta">BUILD</span>${build.map((b) => `<em>${b}</em>`).join("")}</div>` : ""}
        </div>
        <div class="tk-stub">
          <div class="tk-stub-head"><span class="t-meta">STILL ON BREAK</span><span class="t-meta">${newBest ? "★" : "N1"}</span></div>
          <button class="tk-button" data-action="restart"><span>ONE MORE RUN</span><span>↻</span></button>
          <div class="go-photo" data-photo>${renderPhoto(photo)}</div>
          <div class="tk-row2">
            <button class="tk-button tk-button--ghost" data-action="share"><span>SHARE</span><span>⇪</span></button>
            <button class="tk-button tk-button--ghost" data-action="menu"><span>MENU</span><span>≡</span></button>
          </div>
          ${barcode(score % 97 + 5, 70)}
          <span class="t-code">${isTouch ? "/ / TAP TO RE-ENTER" : "/ / ENTER TO RESTART"}</span>
        </div>
      </div>`;
  }

  screen.addEventListener("click", (event) => {
    // Soundtrack controls are handled by bindMusicControls.
    if (event.target?.closest?.("[data-music]")) {
      return;
    }
    const specialOption = event.target?.closest?.("[data-special]")?.dataset.special;
    if (specialOption) {
      event.stopPropagation();
      handlers.specialSelect?.(specialOption);
      return;
    }
    const action = event.target?.closest?.("[data-action]")?.dataset.action;
    if (action === "photo-view") {
      event.stopPropagation();
      viewer.open();
      return;
    }
    if (action && handlers[action]) {
      event.stopPropagation();
      handlers[action]();
    } else if (action && handlers.action) {
      event.stopPropagation();
      const button = event.target.closest("[data-action]");
      if (!button.disabled) {
        handlers.action(action, button.dataset);
      }
    } else if (screen.dataset.mode === "pause") {
      handlers.resume?.();
    }
  });

  let hideTimer = 0;
  let unbindMusic = null;
  function showScreen(mode, data = {}) {
    clearTimeout(hideTimer);
    unbindMusic?.();
    unbindMusic = null;
    screen.classList.remove("is-leaving");
    const changed = screen.dataset.mode !== mode;
    screen.dataset.mode = mode;
    screen.classList.remove("is-countdown");
    screen.classList.toggle("is-meta", ["armory", "missions", "records", "upgrade"].includes(mode));
    screen.classList.toggle("is-music", mode === "music");
    if (mode === "start") {
      renderStart(data.best ?? 0, data.special, data.meta ?? null, data.style ?? "neon");
    } else if (mode === "armory") {
      screen.innerHTML = renderArmory(data.meta);
    } else if (mode === "missions") {
      screen.innerHTML = renderMissions(data.meta, data.streakMultiplier ?? 1);
    } else if (mode === "records") {
      screen.innerHTML = renderRecords(data.meta, data.dailyBest ?? 0);
    } else if (mode === "upgrade") {
      screen.innerHTML = renderUpgradePicker(data);
    } else if (mode === "music" && music) {
      // The full player shows the same info; no card on top of it.
      nowPlaying?.hide();
      const renderMusic = () => {
        unbindMusic?.();
        screen.innerHTML = renderMusicScreen(music, { back: data.back ?? "menu" });
        unbindMusic = bindMusicControls(screen, music, { onRerender: renderMusic });
      };
      renderMusic();
    } else if (mode === "pause") {
      renderPause();
      if (music) {
        unbindMusic = bindMusicControls(screen, music, {
          onRerender: () => showScreen("pause"),
        });
      }
    } else if (mode === "gameover") {
      renderGameOver(data);
    } else if (mode === "countdown") {
      screen.classList.add("is-countdown");
      const digit = changed ? null : screen.querySelector(".countdown > b");
      if (digit) {
        // Keep the briefing up; only the digit changes.
        digit.textContent = data.text ?? "";
        bump(digit, "is-count");
      } else {
        screen.innerHTML = `
          <div class="countdown">
            <span class="t-meta">DIVING IN</span>
            <b>${data.text ?? ""}</b>
            <span class="t-meta">// ${STORY.player.toUpperCase()} — SYNCING TO ${STORY.world.toUpperCase()}</span>
            ${data.missions ? `<div class="countdown-orders">${renderOrders(data.missions, { title: "MISSION BRIEFING", note: "TRACKED ON YOUR HUD" })}</div>` : ""}
          </div>`;
      }
    }
    // Entrance choreography: staggered rise for list-like children.
    stagger(screen, ".ord-row, .tk-nav > *, .tk-stats > div, .go-rewards > *, .tk-row2 > *, .mt-grid > *, .mt-missions > *, .mt-recs > *, .mt-stats > *, .tk-special-options > *, .mu-rows > *");
    screen.classList.toggle("is-fresh", changed);
    if (mode === "gameover") {
      countUp(screen.querySelectorAll(".tk-stats b, .go-rewards b"));
    }
    screen.classList.add("is-visible");
  }

  /** Fade + drop the current screen, then clear it. */
  function hideScreen() {
    unbindMusic?.();
    unbindMusic = null;
    if (!screen.classList.contains("is-visible") || screen.dataset.mode === "countdown") {
      screen.dataset.mode = "";
      screen.classList.remove("is-visible", "is-leaving");
      return;
    }
    screen.classList.add("is-leaving");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      screen.dataset.mode = "";
      screen.classList.remove("is-visible", "is-leaving");
    }, 200);
  }

  /** Upgrade pick: chosen card flies up, the rest drop away, then `done`. */
  let picking = false;
  function pickCard(id, done) {
    if (picking) {
      return;
    }
    const cards = [...screen.querySelectorAll(".up-card")];
    if (!cards.length) {
      done();
      return;
    }
    picking = true;
    cards.forEach((card) => card.classList.add(card.dataset.id === id ? "is-picked" : "is-dismissed"));
    setTimeout(() => {
      picking = false;
      done();
    }, 320);
  }

  // ── Transient FX ────────────────────────────────────────────────────────
  let hitTimer = 0;
  let hintTime = 0;
  let bannerTimer = 0;
  let damageLevel = 0;

  function hitMarker(kill = false) {
    hitmarker.classList.toggle("is-kill", kill);
    hitmarker.classList.add("is-on");
    hitTimer = kill ? 0.24 : 0.08;
  }

  function showBanner(text, seconds = 1.6) {
    bannerText.textContent = text;
    banner.classList.remove("is-on");
    void banner.offsetWidth;
    banner.classList.add("is-on");
    bannerTimer = seconds;
  }

  function flashDamage(amount) {
    damageLevel = Math.min(1, damageLevel + amount);
  }

  /** Floating text at a screen position; kind: score | kill | near | boss. */
  function popup(x, y, text, kind = "score") {
    const node = popups[popCursor];
    popCursor = (popCursor + 1) % popups.length;
    node.textContent = text;
    node.className = `rh-pop is-${kind}`;
    node.style.left = `${x.toFixed(0)}px`;
    node.style.top = `${y.toFixed(0)}px`;
    void node.offsetWidth;
    node.classList.add("is-on");
  }

  function toast(title, text) {
    const node = el("div", "rh-toast", toasts, `<span class="t-meta">${title}</span><b>${text}</b>`);
    setTimeout(() => node.classList.add("is-out"), 2600);
    setTimeout(() => node.remove(), 3100);
  }

  function setBoss(boss) {
    bossBar.classList.toggle("is-on", Boolean(boss));
    if (boss) {
      bossFill.style.transform = `scaleX(${boss.hp.toFixed(3)})`;
      bossBar.classList.toggle("is-open", boss.open);
      bossState.textContent = boss.open ? "WEAK POINT OPEN — FIRE" : "ARMORED";
    }
  }

  function setPrompt(text) {
    prompt.classList.toggle("is-on", Boolean(text));
    if (text && promptText.textContent !== text) {
      promptText.textContent = text;
    }
  }

  function setSlowmo(on) {
    slowmo.classList.toggle("is-on", on);
  }

  function setWeaponLocks(locked) {
    chipEls.forEach((chip, index) => chip.classList.toggle("is-locked", Boolean(locked[index])));
  }

  const last = { weapon: -1, score: -1, ammo: -1, dist: -1, speed: -1, combo: "", shield: -1, health: -1, sector: -1, status: "" };

  function update(delta, s) {
    if (hitTimer > 0) {
      hitTimer -= delta;
      if (hitTimer <= 0) {
        hitmarker.classList.remove("is-on");
      }
    }
    if (bannerTimer > 0) {
      bannerTimer -= delta;
      if (bannerTimer <= 0) {
        banner.classList.remove("is-on");
      }
    }
    damageLevel = Math.max(0, damageLevel - delta * 1.6);
    damage.style.opacity = damageLevel.toFixed(3);

    if (!s) {
      return;
    }

    if (miniMusic?.classList.contains("is-visible")) {
      const { time, duration } = music.getState();
      miniProgress.style.transform = `scaleX(${duration > 0 ? Math.min(1, time / duration).toFixed(3) : 0})`;
    }

    if (s.clock && s.clock !== last.clock) {
      clockValue.textContent = s.clock;
      last.clock = s.clock;
    }

    // Score rolls toward the real value; big jumps (kills) punch the ticket.
    if (s.score < scoreShown) {
      scoreShown = s.score;
    }
    const gap = s.score - scoreShown;
    if (gap >= 80) {
      bump(scoreValue);
    }
    scoreShown += gap <= 1 ? gap : Math.max(1, gap * Math.min(1, delta * 10));
    const shownInt = Math.floor(scoreShown);
    if (shownInt !== last.score) {
      scoreValue.textContent = pad(shownInt, 6);
      last.score = shownInt;
    }
    const dist = Math.floor(s.distance);
    if (dist !== last.dist) {
      distValue.textContent = pad(dist, 4);
      codeValue.textContent = pad(dist % 10000, 4);
      last.dist = dist;
      const sector = Math.floor(dist / 500) + 1;
      if (sector !== last.sector) {
        sectorValue.textContent = `SECTOR ${pad(sector, 2)}`;
        last.sector = sector;
      }
    }
    const speed = Math.round(s.speed * 3.6);
    if (speed !== last.speed) {
      speedValue.textContent = pad(speed, 3);
      last.speed = speed;
    }
    const combo = `×${s.combo.toFixed(1)}`;
    if (combo !== last.combo) {
      if (last.combo && s.combo > parseFloat(last.combo.slice(1))) {
        bump(comboValue);
      }
      comboValue.textContent = combo;
      comboCell.classList.toggle("is-hot", s.combo > 1.05);
      // Heat 0..3 drives the meter colour / glow.
      comboCell.dataset.heat = String(s.combo >= 3.2 ? 3 : s.combo >= 2.2 ? 2 : s.combo > 1.05 ? 1 : 0);
      last.combo = combo;
    }

    const shieldT = Math.max(0, s.shield / s.maxShield);
    const healthT = Math.max(0, s.health / s.maxHealth);
    shieldBar.style.transform = `scaleX(${shieldT.toFixed(3)})`;
    healthBar.style.transform = `scaleX(${healthT.toFixed(3)})`;
    // Damage trail: a pale bar that holds, then drains down to the value.
    for (const [key, value, node] of [["shield", shieldT, shieldTrail], ["health", healthT, healthTrail]]) {
      trail[key] = value > trail[key] ? value : trail[key] - Math.min(trail[key] - value, delta * 0.45);
      node.style.transform = `scaleX(${trail[key].toFixed(3)})`;
    }
    const shieldInt = Math.round(s.shield);
    if (shieldInt !== last.shield) {
      shieldNum.textContent = pad(shieldInt, 3);
      last.shield = shieldInt;
    }
    const healthInt = Math.round(s.health);
    if (healthInt !== last.health) {
      healthNum.textContent = pad(healthInt, 3);
      vitals.classList.toggle("is-critical", healthT < 0.35);
      last.health = healthInt;
    }

    const weaponKey = `${s.weaponIndex}:${s.magSize}`;
    if (weaponKey !== last.weapon) {
      last.weapon = weaponKey;
      last.ammo = -1;
      const weapon = WEAPONS[s.weaponIndex];
      weaponName.textContent = weapon.name;
      weaponCode.textContent = weapon.code;
      magLabel.textContent = `/ ${s.magSize || weapon.magSize}`;
      chipEls.forEach((chip, index) => chip.classList.toggle("is-active", index === s.weaponIndex));
      bump(chipEls[s.weaponIndex]);
      bump(ammo, "is-swap");
    }

    const overclock = s.overclock > 0;
    const ammoKey = overclock ? -2 : s.ammo;
    if (ammoKey !== last.ammo) {
      ammoNum.textContent = overclock ? "∞" : pad(s.ammo, 2);
      bump(ammoNum, "is-tick");
      const filled = overclock ? MAG_TICKS : Math.round((s.ammo / s.magSize) * MAG_TICKS);
      magTicks.forEach((tick, index) => tick.classList.toggle("on", index < filled));
      last.ammo = ammoKey;
    }
    reloadBar.style.transform = `scaleX(${s.reload.toFixed(3)})`;
    const status = overclock
      ? `OVERCLOCK ${s.overclock.toFixed(1)}S`
      : s.reloading
        ? "RELOADING…"
        : s.ammo <= Math.max(1, Math.ceil(s.magSize * 0.2))
          ? "LOW — PRESS R"
          : "READY";
    if (status !== last.status) {
      ammoStatus.textContent = status;
      ammo.classList.toggle("is-overclock", overclock);
      ammo.classList.toggle("is-low", !overclock && !s.reloading && s.ammo <= Math.max(1, Math.ceil(s.magSize * 0.2)));
      last.status = status;
    }

    // Special attack state.
    const special = s.special;
    if (special) {
      const meta = SPECIALS[special.type];
      specialName.textContent = special.ready ? `${meta.name} READY` : meta.name;
      specialBar.style.transform = `scaleX(${special.charge.toFixed(3)})`;
      specialRow.classList.toggle("is-ready", special.ready);
      specialLabel.textContent = meta.short;
      specialButton.classList.toggle("is-visible", special.ready);
      fireRing.style.strokeDashoffset = `${(RING_LENGTH * (1 - special.charge)).toFixed(1)}`;
      fireButton.classList.toggle("is-charged", special.ready);
    }
    fireAmmo.textContent = overclock ? "∞" : s.reloading ? "··" : String(s.ammo);
    fireButton.classList.toggle("is-reloading", s.reloading);

    if (isTouch && touchHint.style.display !== "none") {
      hintTime += delta;
      if (hintTime > 5) {
        touchHint.style.display = "none";
      }
    }

    const speedT = Math.max(0, Math.min(1, (s.speed - RUNNER.startSpeed) / (RUNNER.maxSpeed - RUNNER.startSpeed)));
    const lines = Math.round(Math.min(0.6, speedT * speedT * 0.4 + (overclock ? 0.25 : 0)) * 100) / 100;
    if (lines !== speedLinesOpacity) {
      speedLines.style.opacity = String(lines);
      speedLinesOpacity = lines;
    }
    if (lines > 0) {
      speedLines.style.transform = `rotate(${(Math.random() * 6).toFixed(2)}deg) scale(${(1.02 + Math.random() * 0.03).toFixed(3)})`;
    }

    crosshair.style.setProperty("--spread", `${(7 + s.spread * 520).toFixed(1)}px`);
    crosshair.classList.toggle("is-overclock", overclock);

    const targets = s.targets ?? [];
    for (let i = 0; i < markers.length; i++) {
      const marker = markers[i];
      const target = targets[i];
      if (!target) {
        if (marker.style.opacity !== "0") {
          marker.style.opacity = "0";
        }
        continue;
      }
      marker.style.opacity = "1";
      marker.style.width = marker.style.height = `${target.size.toFixed(0)}px`;
      marker.style.transform = `translate(${(target.x - target.size / 2).toFixed(1)}px, ${(target.y - target.size / 2).toFixed(1)}px)`;
      marker.classList.toggle("is-urgent", target.urgent);
      marker.children[4].textContent = `${target.label} ${Math.round(target.distance)}M`;
      marker.children[5].firstChild.style.transform = `scaleX(${target.hp.toFixed(3)})`;
    }

    for (let i = 0; i < ARROW_COUNT; i++) {
      const threat = s.threats[i];
      const arrow = arrows[i];
      if (!threat) {
        arrow.style.opacity = "0";
        continue;
      }
      const radius = Math.min(window.innerWidth, window.innerHeight) * 0.34;
      const x = Math.cos(threat.angle) * radius;
      const y = Math.sin(threat.angle) * radius;
      arrow.style.opacity = threat.urgent ? "1" : "0.75";
      arrow.classList.toggle("is-urgent", threat.urgent);
      arrow.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      arrow.firstChild.style.transform = `rotate(${(threat.angle + Math.PI / 2).toFixed(3)}rad)`;
    }
  }

  function setVisible(visible) {
    // Cards slide in from their edges each time the HUD comes up.
    if (visible && !root.classList.contains("is-visible")) {
      bump(root, "is-entering");
      placeMiniMusic();
    }
    root.classList.toggle("is-visible", visible);
  }

  return {
    root,
    screen,
    update,
    showScreen,
    hideScreen,
    hitMarker,
    showBanner,
    popup,
    toast,
    setMissions,
    missionComplete,
    setBoss,
    setPhoto,
    setFlight,
    setPrompt,
    setSlowmo,
    setWeaponLocks,
    pickCard,
    onAction: (fn) => { handlers.action = fn; },
    flashDamage,
    setVisible,
    onStart: (fn) => { handlers.start = fn; },
    onRestart: (fn) => { handlers.restart = fn; },
    onResume: (fn) => { handlers.resume = fn; },
    onPause: (fn) => { handlers.pause = fn; },
    onWeapon: (fn) => { handlers.weapon = fn; },
    onSpecial: (fn) => { handlers.special = fn; },
    onFire: (fn) => { handlers.fire = fn; },
    onSpecialSelect: (fn) => { handlers.specialSelect = fn; },
    getScreenMode: () => screen.dataset.mode || "",
  };
}
