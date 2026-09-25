import "@fontsource/barlow-condensed/latin-600.css";
import "@fontsource/barlow-condensed/latin-800.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "./runnerHud.css";
import { WEAPONS } from "../../weapon/weaponTypes.js";
import { GAME_TITLE } from "../../app/credits.js";

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

/**
 * DOM HUD + start / pause / game-over screens. Visual language: transit
 * ticket / utility label — acid lime, cobalt, paper, ink, notched tabs,
 * condensed display numerals, mono metadata, barcodes and dot grids.
 * Pure view: the game calls update() with plain numbers each frame.
 */
export function createRunnerHud({ isTouch = false } = {}) {
  document.documentElement.classList.add("runner-mode");
  const root = el("div", "runner-hud", document.body);
  const handlers = { start: null, restart: null, resume: null, weapon: null };

  // ── Crosshair ──────────────────────────────────────────────────────────
  const crosshair = el("div", "rh-crosshair", root,
    '<i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i><i class="dot"></i>');
  const hitmarker = el("div", "rh-hitmarker", root, "<i></i><i></i><i></i><i></i>");

  // ── Score ticket (top-left) ──────────────────────────────────────────────
  const ticket = el("div", "rh-card rh-ticket", root);
  ticket.innerHTML = `
    <div class="t-strip"><span>RUN PASS</span><span class="rh-sector">SECTOR 01</span><span>↗</span></div>
    <div class="t-body">
      <span class="t-meta">SCORE:</span>
      <span class="t-big rh-score-value">000000</span>
      <div class="t-grid">
        <div><span class="t-meta">DIST.</span><b class="rh-dist">0000</b><em>M</em></div>
        <div><span class="t-meta">SPEED</span><b class="rh-speed">000</b><em>KM/H</em></div>
        <div class="t-combo"><span class="t-meta">COMBO</span><b class="rh-combo">×1.0</b></div>
      </div>
    </div>
    <div class="t-stub">${barcode(11, 54, { height: 18 })}<span class="t-code">//VX-RN-<b class="rh-code">0000</b></span></div>`;
  const scoreValue = ticket.querySelector(".rh-score-value");
  const distValue = ticket.querySelector(".rh-dist");
  const speedValue = ticket.querySelector(".rh-speed");
  const comboValue = ticket.querySelector(".rh-combo");
  const comboCell = ticket.querySelector(".t-combo");
  const codeValue = ticket.querySelector(".rh-code");
  const sectorValue = ticket.querySelector(".rh-sector");

  // ── Vitals label (bottom-left) ─────────────────────────────────────────
  const vitals = el("div", "rh-card rh-vitals", root);
  vitals.innerHTML = `
    <div class="v-head"><span class="t-meta">UNIT // VX-TR9</span><span class="t-meta">SET 2</span></div>
    <div class="v-row">
      <span class="v-label">SHIELD</span>
      <div class="v-bar shield"><i></i></div>
      <b class="v-num rh-shield-num">060</b>
    </div>
    <div class="v-row">
      <span class="v-label">INTEGRITY</span>
      <div class="v-bar health"><i></i></div>
      <b class="v-num rh-health-num">100</b>
    </div>`;
  const shieldBar = vitals.querySelector(".v-bar.shield i");
  const healthBar = vitals.querySelector(".v-bar.health i");
  const shieldNum = vitals.querySelector(".rh-shield-num");
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
    <div class="a-reload"><i></i></div>`;
  const ammoNum = ammo.querySelector(".rh-ammo-num");
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
      handlers.weapon?.(index);
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
  const arrows = Array.from({ length: ARROW_COUNT }, () => el("div", "rh-arrow", root, "<i></i><span>DRN</span>"));

  const touchHint = el("div", "rh-touch-hint t-meta", root,
    "L: SWIPE LANE / JUMP / SLIDE — R: DRAG AIM — AUTO-FIRE ON LOCK");
  if (isTouch) {
    touchHint.style.display = "block";
  }

  // ── Screens ─────────────────────────────────────────────────────────────
  const screen = el("div", "runner-screen", document.body);

  const controls = isTouch
    ? [
        ["SWIPE ← →", "SWITCH LANE"],
        ["SWIPE ↑", "JUMP"],
        ["SWIPE ↓", "SLIDE"],
        ["DRAG (RIGHT)", "AIM / AUTO-FIRE"],
        ["TAP CHIP", "SWITCH WEAPON"],
      ]
    : [
        ["A / D", "SWITCH LANE"],
        ["SPACE", "JUMP"],
        ["S / C", "SLIDE"],
        ["MOUSE", "AIM"],
        ["L-CLICK", "FIRE"],
        ["R", "RELOAD"],
        ["1–4 / Q", "WEAPON"],
        ["ESC", "PAUSE"],
      ];
  const controlsHtml = controls
    .map(([key, label]) => `<div class="k-row"><kbd>${key}</kbd><span>${label}</span></div>`)
    .join("");

  function renderStart(best) {
    screen.innerHTML = `
      <div class="ticket ticket--start">
        <div class="tk-main">
          <div class="tk-top">
            <span class="t-meta">PASS TIER</span>
            <span class="t-meta">GROUP<br><b>A</b></span>
            <span class="t-meta">CLEARANCE<br><b>DRONE CURFEW</b></span>
            <span class="tk-arrow">↗</span>
          </div>
          <div class="tk-hero">
            <div class="tk-tag"><span class="t-meta">SECTOR:</span><span class="tk-title">${GAME_TITLE.split(" ").join("<br>")}</span></div>
            <div class="tk-side">
              <span class="tk-ghost">2077</span>
              <div class="tk-keys">${controlsHtml}</div>
            </div>
          </div>
          <div class="tk-foot">
            <span class="t-meta">JUMP BARRIERS</span><span class="t-meta">SLIDE BEAMS</span><span class="t-meta">DODGE CARS</span><span class="t-meta">DROP DRONES</span>
          </div>
        </div>
        <div class="tk-stub">
          <div class="tk-stub-head"><span class="t-meta">ONE RUN ONLY</span><span class="t-meta">2B</span></div>
          <div class="tk-best"><span class="t-meta">BEST SCORE</span><b>${pad(best, 6)}</b></div>
          <button class="tk-button" data-action="start"><span>START RUN</span><span>→</span></button>
          ${barcode(3, 70)}
          <span class="t-code">/ / V X - R N 7 /</span>
        </div>
      </div>`;
  }

  function renderPause() {
    screen.innerHTML = `
      <div class="label label--pause">
        <div class="lb-head"><span class="t-meta">SIGNAL HELD</span><span class="t-meta">⚠</span></div>
        <div class="lb-title">PAUSED</div>
        <div class="lb-rule"><i></i><i></i><i></i></div>
        <button class="tk-button" data-action="resume"><span>RESUME</span><span>→</span></button>
        <div class="t-meta lb-note">CLICK TO RE-LOCK THE MOUSE</div>
      </div>`;
  }

  function renderGameOver({ score, distance, kills, best, newBest, cause }) {
    screen.innerHTML = `
      <div class="ticket ticket--over">
        <div class="tk-main">
          <div class="tk-top">
            <span class="t-meta">STATUS</span>
            <span class="t-meta">CAUSE<br><b>${cause}</b></span>
            <span class="tk-arrow">↘</span>
          </div>
          <div class="tk-hero">
            <div class="tk-tag tk-tag--pink"><span class="t-meta">RESULT:</span><span class="tk-title">SIGNAL<br>LOST</span></div>
            <div class="tk-stats">
              <div><span class="t-meta">SCORE</span><b>${pad(score, 6)}</b></div>
              <div><span class="t-meta">DISTANCE</span><b>${pad(distance, 4)}<em>M</em></b></div>
              <div><span class="t-meta">DRONES DOWN</span><b>${pad(kills, 3)}</b></div>
              <div><span class="t-meta">${newBest ? "NEW BEST ★" : "BEST"}</span><b>${pad(best, 6)}</b></div>
            </div>
          </div>
        </div>
        <div class="tk-stub">
          <div class="tk-stub-head"><span class="t-meta">RE-ENTRY</span><span class="t-meta">${newBest ? "★" : "N1"}</span></div>
          <button class="tk-button" data-action="restart"><span>RUN AGAIN</span><span>↻</span></button>
          ${barcode(score % 97 + 5, 70)}
          <span class="t-code">${isTouch ? "/ / TAP TO RE-ENTER" : "/ / ENTER TO RESTART"}</span>
        </div>
      </div>`;
  }

  screen.addEventListener("click", (event) => {
    const action = event.target?.closest?.("[data-action]")?.dataset.action;
    if (action && handlers[action]) {
      event.stopPropagation();
      handlers[action]();
    } else if (screen.dataset.mode === "pause") {
      handlers.resume?.();
    }
  });

  function showScreen(mode, data = {}) {
    screen.dataset.mode = mode;
    screen.classList.remove("is-countdown");
    if (mode === "start") {
      renderStart(data.best ?? 0);
    } else if (mode === "pause") {
      renderPause();
    } else if (mode === "gameover") {
      renderGameOver(data);
    } else if (mode === "countdown") {
      screen.classList.add("is-countdown");
      screen.innerHTML = `
        <div class="countdown">
          <span class="t-meta">BOARDING IN</span>
          <b>${data.text ?? ""}</b>
          <span class="t-meta">//VX-TR9 — HOLD LANE</span>
        </div>`;
    }
    screen.classList.add("is-visible");
  }

  function hideScreen() {
    screen.dataset.mode = "";
    screen.classList.remove("is-visible");
  }

  // ── Transient FX ────────────────────────────────────────────────────────
  let hitTimer = 0;
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

    if (s.score !== last.score) {
      scoreValue.textContent = pad(s.score, 6);
      last.score = s.score;
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
      comboValue.textContent = combo;
      comboCell.classList.toggle("is-hot", s.combo > 1.05);
      last.combo = combo;
    }

    const shieldT = Math.max(0, s.shield / s.maxShield);
    const healthT = Math.max(0, s.health / s.maxHealth);
    shieldBar.style.transform = `scaleX(${shieldT.toFixed(3)})`;
    healthBar.style.transform = `scaleX(${healthT.toFixed(3)})`;
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

    if (s.weaponIndex !== last.weapon) {
      last.weapon = s.weaponIndex;
      last.ammo = -1;
      const weapon = WEAPONS[s.weaponIndex];
      weaponName.textContent = weapon.name;
      weaponCode.textContent = weapon.code;
      magLabel.textContent = `/ ${weapon.magSize}`;
      chipEls.forEach((chip, index) => chip.classList.toggle("is-active", index === s.weaponIndex));
    }

    const overclock = s.overclock > 0;
    const ammoKey = overclock ? -2 : s.ammo;
    if (ammoKey !== last.ammo) {
      ammoNum.textContent = overclock ? "∞" : pad(s.ammo, 2);
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

    crosshair.style.setProperty("--spread", `${(7 + s.spread * 520).toFixed(1)}px`);
    crosshair.classList.toggle("is-overclock", overclock);

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
    flashDamage,
    setVisible,
    onStart: (fn) => { handlers.start = fn; },
    onRestart: (fn) => { handlers.restart = fn; },
    onResume: (fn) => { handlers.resume = fn; },
    onWeapon: (fn) => { handlers.weapon = fn; },
    getScreenMode: () => screen.dataset.mode || "",
  };
}
