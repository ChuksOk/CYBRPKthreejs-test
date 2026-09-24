import "./runnerHud.css";

const ARROW_COUNT = 8;

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

/**
 * DOM HUD + start / pause / game-over screens for the runner. Pure view: the
 * game calls update() with plain numbers each frame.
 */
export function createRunnerHud({ isTouch = false } = {}) {
  const root = el("div", "runner-hud", document.body);

  const crosshair = el("div", "rh-crosshair", root,
    '<span class="t"></span><span class="b"></span><span class="l"></span><span class="r"></span><span class="dot"></span>');
  const hitmarker = el("div", "rh-hitmarker", root);

  const scorePanel = el("div", "rh-panel rh-score", root);
  el("span", "rh-label", scorePanel, "SCORE");
  const scoreValue = el("span", "rh-value", scorePanel, "0");
  const scoreRow = el("div", "rh-row", scorePanel);
  const comboValue = el("span", "rh-combo", scoreRow, "x1.0");
  const distanceValue = el("span", "", scoreRow, "0 m");
  const speedValue = el("span", "", scoreRow, "0 km/h");

  const vitals = el("div", "rh-panel rh-vitals", root);
  el("span", "rh-label", vitals, "SHIELD");
  const shieldBar = el("div", "rh-bar shield", vitals, "<i></i>").firstChild;
  el("span", "rh-label", vitals, "INTEGRITY");
  const healthBar = el("div", "rh-bar health", vitals, "<i></i>").firstChild;

  const ammoPanel = el("div", "rh-panel rh-ammo", root);
  el("span", "rh-label", ammoPanel, "REPEATER");
  const ammoValue = el("span", "rh-value", ammoPanel, "32 <small>/ 32</small>");
  const reloadBar = el("div", "rh-reload", ammoPanel, "<i></i>").firstChild;
  const statusValue = el("div", "rh-status", ammoPanel, "");

  const banner = el("div", "rh-banner", root, "");
  const damage = el("div", "rh-damage", root);
  const arrows = Array.from({ length: ARROW_COUNT }, () => el("div", "rh-arrow", root));

  const touchHint = el("div", "rh-touch-hint", root,
    "SWIPE LEFT SIDE: LANE / JUMP / SLIDE · DRAG RIGHT SIDE: AIM · AUTO-FIRE ON TARGET");
  if (isTouch) {
    touchHint.style.display = "block";
  }

  // ── Screens ─────────────────────────────────────────────────────────────
  const screen = el("div", "runner-screen", document.body);
  const handlers = { start: null, restart: null, resume: null };

  const controlsHtml = isTouch
    ? `<kbd>Swipe ← →</kbd><span>Switch lane (left half)</span>
       <kbd>Swipe ↑</kbd><span>Jump</span>
       <kbd>Swipe ↓</kbd><span>Slide</span>
       <kbd>Drag</kbd><span>Aim (right half) — auto-fire on target</span>`
    : `<kbd>A / D · ← →</kbd><span>Switch lane</span>
       <kbd>Space · W</kbd><span>Jump</span>
       <kbd>S · C · Ctrl</kbd><span>Slide</span>
       <kbd>Mouse</kbd><span>Aim</span>
       <kbd>Left click</kbd><span>Fire (hold)</span>
       <kbd>R</kbd><span>Reload</span>
       <kbd>Esc</kbd><span>Pause</span>`;

  function renderStart(best) {
    screen.innerHTML = `
      <div class="rs-card">
        <div class="rs-kicker">SECTOR 7 // DRONE CURFEW</div>
        <div class="rs-title">NEON RUN</div>
        <div class="rs-controls">${controlsHtml}</div>
        <button class="rs-button" data-action="start">START RUN</button>
        ${best > 0 ? `<div class="rs-best">BEST ${best.toLocaleString()}</div>` : ""}
        <div class="rs-hint">JUMP BARRIERS · SLIDE UNDER BEAMS · DODGE CARS · SHOOT DOWN DRONES</div>
      </div>`;
  }

  function renderPause() {
    screen.innerHTML = `
      <div class="rs-card">
        <div class="rs-kicker">SIGNAL HELD</div>
        <div class="rs-title">PAUSED</div>
        <button class="rs-button" data-action="resume">RESUME</button>
        <div class="rs-hint">CLICK TO RE-LOCK THE MOUSE</div>
      </div>`;
  }

  function renderGameOver({ score, distance, kills, best, newBest, cause }) {
    screen.innerHTML = `
      <div class="rs-card">
        <div class="rs-kicker">${cause}</div>
        <div class="rs-title">SIGNAL LOST</div>
        <div class="rs-stats">
          <div><b>${score.toLocaleString()}</b><span>SCORE</span></div>
          <div><b>${Math.round(distance).toLocaleString()} m</b><span>DISTANCE</span></div>
          <div><b>${kills}</b><span>DRONES DOWN</span></div>
          <div><b>${best.toLocaleString()}</b><span>${newBest ? "NEW BEST" : "BEST"}</span></div>
        </div>
        <button class="rs-button" data-action="restart">RUN AGAIN</button>
        <div class="rs-hint">${isTouch ? "" : "PRESS ENTER TO RESTART"}</div>
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
      screen.innerHTML = `<div class="rs-countdown">${data.text ?? ""}</div>`;
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
    hitTimer = kill ? 0.22 : 0.08;
  }

  function showBanner(text, seconds = 1.6) {
    banner.textContent = text;
    banner.classList.add("is-on");
    bannerTimer = seconds;
  }

  function flashDamage(amount) {
    damageLevel = Math.min(1, damageLevel + amount);
  }

  let lastScore = -1;
  let lastAmmo = "";

  /**
   * @param {number} delta
   * @param {object} s  snapshot from the game
   */
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

    if (s.score !== lastScore) {
      scoreValue.textContent = s.score.toLocaleString();
      lastScore = s.score;
    }
    comboValue.textContent = `x${s.combo.toFixed(1)}`;
    distanceValue.textContent = `${Math.round(s.distance)} m`;
    speedValue.textContent = `${Math.round(s.speed * 3.6)} km/h`;

    shieldBar.style.transform = `scaleX(${Math.max(0, s.shield / s.maxShield).toFixed(3)})`;
    healthBar.style.transform = `scaleX(${Math.max(0, s.health / s.maxHealth).toFixed(3)})`;

    const ammoText = s.overclock > 0 ? "∞" : `${s.ammo} <small>/ ${s.magSize}</small>`;
    if (ammoText !== lastAmmo) {
      ammoValue.innerHTML = ammoText;
      lastAmmo = ammoText;
    }
    reloadBar.style.transform = `scaleX(${s.reload.toFixed(3)})`;
    statusValue.textContent = s.overclock > 0
      ? `OVERCLOCK ${s.overclock.toFixed(1)}s`
      : s.reloading
        ? "RELOADING"
        : s.ammo <= 6
          ? "LOW AMMO · R"
          : "";

    crosshair.style.setProperty("--spread", `${(5 + s.spread * 600).toFixed(1)}px`);
    crosshair.classList.toggle("is-overclock", s.overclock > 0);

    // Off-screen / edge threat arrows.
    for (let i = 0; i < ARROW_COUNT; i++) {
      const threat = s.threats[i];
      const arrow = arrows[i];
      if (!threat) {
        arrow.style.opacity = "0";
        continue;
      }
      const radius = Math.min(window.innerWidth, window.innerHeight) * 0.32;
      const x = Math.cos(threat.angle) * radius;
      const y = Math.sin(threat.angle) * radius;
      arrow.style.opacity = threat.urgent ? "1" : "0.7";
      arrow.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(threat.angle + Math.PI / 2).toFixed(3)}rad)`;
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
    getScreenMode: () => screen.dataset.mode || "",
  };
}
