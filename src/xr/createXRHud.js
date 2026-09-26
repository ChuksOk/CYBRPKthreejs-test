import * as THREE from "three/webgpu";
import { VIEWMODEL_LAYER } from "../runner/runnerConfig.js";
import { WEAPONS } from "../weapon/weaponTypes.js";

const DISPLAY = "'Barlow Condensed', 'Orbitron', sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";
const CYAN = "#d9ff3b"; // --t-acid (ticketTheme.css)
const MAGENTA = "#ff4f74"; // --t-pink
const YELLOW = "#ffd23f";
const RED = "#ff4a4a";
const INK = "rgba(6, 8, 14, 0.82)";

/** Main panel: menus, countdown, banners (body-locked, ahead of the player). */
const MAIN_PX = { w: 1024, h: 640 };
const MAIN_M = { w: 1.8, h: 1.125 };
const MAIN_POSITION = new THREE.Vector3(0, 1.6, -2.5);
/** Stats strip: health / shield / ammo / special, low and tilted toward the eyes. */
const STATS_PX = { w: 1024, h: 192 };
const STATS_M = { w: 1.2, h: 0.225 };
const STATS_POSITION = new THREE.Vector3(0, 0.95, -1.15);
const STATS_TILT = -0.55;
const STATS_INTERVAL = 0.1;

function createPanel({ px, m, name }) {
  const canvas = document.createElement("canvas");
  canvas.width = px.w;
  canvas.height = px.h;
  const ctx = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.MeshBasicNodeMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(m.w, m.h), material);
  mesh.name = name;
  mesh.renderOrder = 1000;
  mesh.frustumCulled = false;
  mesh.layers.set(VIEWMODEL_LAYER);
  mesh.visible = false;
  return { canvas, ctx, texture, mesh };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function bar(ctx, x, y, w, h, t, color, label) {
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = color;
  roundRect(ctx, x, y, Math.max(h, w * THREE.MathUtils.clamp(t, 0, 1)), h, h / 2);
  ctx.fill();
  ctx.font = `600 22px ${MONO}`;
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.textAlign = "left";
  ctx.fillText(label, x, y - 10);
}

/**
 * In-headset HUD. DOM overlays are invisible inside a WebXR session, so the
 * runner mirrors its HUD calls here (see mirrorHud in createRunnerGame.js).
 * Panels are canvas textures on VIEWMODEL_LAYER (never in the AO, mirror or
 * rain height passes), drawn on top of the scene and redrawn only when dirty.
 */
export function createXRHud({ onHit = null, onDamage = null } = {}) {
  const group = new THREE.Group();
  group.name = "xr-hud";

  const main = createPanel({ px: MAIN_PX, m: MAIN_M, name: "xr-hud-main" });
  main.mesh.position.copy(MAIN_POSITION);
  group.add(main.mesh);

  const stats = createPanel({ px: STATS_PX, m: STATS_M, name: "xr-hud-stats" });
  stats.mesh.position.copy(STATS_POSITION);
  stats.mesh.rotation.x = STATS_TILT;
  group.add(stats.mesh);

  // Damage: a red shell around the head (parented to the XR camera by
  // createXRMode). A shell needs no FOV math and covers both eyes.
  const damageMaterial = new THREE.MeshBasicNodeMaterial({
    color: 0xff1030,
    transparent: true,
    opacity: 0,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const damageMesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), damageMaterial);
  damageMesh.name = "xr-hud-damage";
  damageMesh.renderOrder = 1001;
  damageMesh.frustumCulled = false;
  damageMesh.layers.set(VIEWMODEL_LAYER);
  damageMesh.visible = false;

  const state = {
    screen: null, // { mode, data }
    banner: null, // { text, time }
    toast: null, // { title, text, time }
    prompt: null,
    boss: null,
    slowmo: false,
    statsVisible: false,
    damage: 0,
    highlight: 1,
    countdownText: "",
    dirty: true,
    statsTimer: 0,
  };

  function markDirty() {
    state.dirty = true;
  }

  // ── Mirrored runner HUD API ─────────────────────────────────────────────
  function showScreen(mode, data = {}) {
    state.screen = { mode, data };
    if (mode === "upgrade") {
      state.highlight = 1;
    }
    markDirty();
  }

  function hideScreen() {
    state.screen = null;
    markDirty();
  }

  function showBanner(text, duration = 1.2) {
    state.banner = { text, time: duration };
    markDirty();
  }

  function toast(title, text) {
    state.toast = { title, text, time: 2.6 };
    markDirty();
  }

  function setPrompt(text) {
    state.prompt = text || null;
    markDirty();
  }

  function setBoss(boss) {
    state.boss = boss;
  }

  function setSlowmo(value) {
    state.slowmo = Boolean(value);
  }

  function flashDamage(amount = 0.5) {
    state.damage = Math.max(state.damage, amount);
    onDamage?.(amount);
  }

  /** Haptics stand in for the DOM hit marker. */
  function hitMarker(kill = false) {
    onHit?.(kill);
  }

  function setVisible(value) {
    state.statsVisible = Boolean(value);
    stats.mesh.visible = state.statsVisible;
  }

  /** Rebuild the current screen after entering VR mid-menu. */
  function syncScreen(mode, game) {
    if (!mode || mode === "countdown") {
      hideScreen();
      return;
    }
    if (mode === "gameover") {
      showScreen(mode, { score: game.score, distance: game.distance, kills: game.kills, best: game.best, cause: game.deathCause });
    } else if (mode === "upgrade") {
      showScreen(mode, { choices: game.upgradeChoices, sector: game.sector });
    } else {
      showScreen(mode, { best: game.best, meta: { daily: game.daily } });
    }
  }

  // ── Upgrade card selection ─────────────────────────────────────────────
  function isPicking() {
    return state.screen?.mode === "upgrade";
  }

  function moveHighlight(step) {
    const count = state.screen?.data?.choices?.length ?? 0;
    if (!count) {
      return;
    }
    state.highlight = THREE.MathUtils.euclideanModulo(state.highlight + step, count);
    markDirty();
  }

  function setHighlight(index) {
    if (index !== state.highlight) {
      state.highlight = index;
      markDirty();
    }
  }

  const _hits = [];
  /** Card index under a ray (the right controller), or -1. */
  function pickCardFromRay(raycaster) {
    if (!isPicking() || !main.mesh.visible) {
      return -1;
    }
    _hits.length = 0;
    raycaster.intersectObject(main.mesh, false, _hits);
    const uv = _hits[0]?.uv;
    if (!uv) {
      return -1;
    }
    const count = state.screen.data.choices?.length ?? 0;
    const y = 1 - uv.y;
    if (y < 0.28 || y > 0.86 || count === 0) {
      return -1;
    }
    return Math.min(count - 1, Math.floor(uv.x * count));
  }

  // ── Drawing ────────────────────────────────────────────────────────────
  function text(ctx, value, x, y, { size = 48, weight = 700, color = "#fff", align = "center", font = DISPLAY } = {}) {
    ctx.font = `${weight} ${size}px ${font}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(value, x, y);
  }

  function card(ctx, x, y, w, h, accent) {
    ctx.fillStyle = INK;
    roundRect(ctx, x, y, w, h, 18);
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  function drawScreen(ctx, screen) {
    const { w, h } = MAIN_PX;
    const { mode, data } = screen;
    if (mode === "countdown") {
      text(ctx, data.text ?? "", w / 2, h / 2 + 80, { size: 260, color: CYAN });
      return;
    }
    if (mode === "upgrade") {
      text(ctx, `SECTOR ${data.sector ?? ""} — PICK AN UPGRADE`, w / 2, 110, { size: 54, color: YELLOW });
      const choices = data.choices ?? [];
      const cardW = 300;
      const gap = 24;
      const x0 = (w - (choices.length * cardW + (choices.length - 1) * gap)) / 2;
      choices.forEach((choice, index) => {
        const x = x0 + index * (cardW + gap);
        const active = index === state.highlight;
        card(ctx, x, 180, cardW, 370, active ? YELLOW : "rgba(255,255,255,0.25)");
        text(ctx, String(index + 1), x + cardW / 2, 250, { size: 44, color: active ? YELLOW : "rgba(255,255,255,0.5)" });
        wrap(ctx, choice.name ?? "", x + cardW / 2, 320, cardW - 36, 44, { size: 40, color: "#fff" });
        wrap(ctx, choice.desc ?? "", x + cardW / 2, 440, cardW - 40, 32, { size: 26, weight: 500, color: "rgba(255,255,255,0.75)", font: MONO });
      });
      text(ctx, "POINT + TRIGGER · OR STICK ← → THEN TRIGGER", w / 2, 610, { size: 26, weight: 500, color: "rgba(255,255,255,0.7)", font: MONO });
      return;
    }

    card(ctx, 40, 40, w - 80, h - 80, mode === "gameover" ? MAGENTA : CYAN);
    if (mode === "gameover") {
      text(ctx, "RUN OVER", w / 2, 150, { size: 96, color: MAGENTA });
      text(ctx, data.cause ?? "", w / 2, 210, { size: 34, weight: 500, font: MONO, color: "rgba(255,255,255,0.8)" });
      text(ctx, `${data.score ?? 0}`, w / 2, 340, { size: 130, color: "#fff" });
      text(ctx, `${Math.floor(data.distance ?? 0)} M · ${data.kills ?? 0} KILLS · BEST ${data.best ?? 0}${data.newBest ? " · NEW BEST" : ""}`, w / 2, 410, {
        size: 32,
        weight: 500,
        font: MONO,
        color: data.newBest ? YELLOW : "rgba(255,255,255,0.8)",
      });
      text(ctx, "TRIGGER — RUN AGAIN", w / 2, 510, { size: 46, color: CYAN });
      text(ctx, "B — MENU", w / 2, 560, { size: 30, weight: 500, font: MONO, color: "rgba(255,255,255,0.7)" });
      return;
    }
    if (mode === "pause") {
      text(ctx, "PAUSED", w / 2, 250, { size: 120, color: CYAN });
      text(ctx, "TRIGGER / Y — RESUME", w / 2, 380, { size: 48, color: "#fff" });
      text(ctx, "B — QUIT TO MENU", w / 2, 450, { size: 30, weight: 500, font: MONO, color: "rgba(255,255,255,0.7)" });
      return;
    }
    if (mode === "start") {
      text(ctx, "LOW GAMMA: REDUX", w / 2, 150, { size: 92, color: CYAN });
      text(ctx, `BEST ${data.best ?? 0}${data.meta?.daily ? " · DAILY RUN" : ""}`, w / 2, 210, { size: 32, weight: 500, font: MONO, color: "rgba(255,255,255,0.8)" });
      text(ctx, "PULL TRIGGER TO RUN", w / 2, 320, { size: 64, color: "#fff" });
      const help = [
        "RIGHT TRIGGER  FIRE        LEFT TRIGGER  SPECIAL",
        "STICK ← →  LANE     A / STICK ↑  JUMP     B / DUCK  SLIDE",
        "RIGHT GRIP  RELOAD   LEFT GRIP  WEAPON   Y  PAUSE",
        "STICK CLICK  RECENTER    X  TOGGLE DAILY RUN",
      ];
      help.forEach((line, index) => {
        text(ctx, line, w / 2, 410 + index * 44, { size: 24, weight: 500, font: MONO, color: "rgba(255,255,255,0.75)" });
      });
      return;
    }
    // Armory / missions / records are DOM-only screens.
    text(ctx, mode.toUpperCase(), w / 2, 250, { size: 90, color: CYAN });
    text(ctx, "AVAILABLE OUTSIDE VR", w / 2, 340, { size: 40, color: "#fff" });
    text(ctx, "TRIGGER — BACK", w / 2, 430, { size: 34, weight: 500, font: MONO, color: "rgba(255,255,255,0.7)" });
  }

  function wrap(ctx, value, x, y, maxWidth, lineHeight, style) {
    ctx.font = `${style.weight ?? 700} ${style.size}px ${style.font ?? DISPLAY}`;
    const words = String(value).split(" ");
    let line = "";
    let lineY = y;
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > maxWidth && line) {
        text(ctx, line, x, lineY, style);
        line = word;
        lineY += lineHeight;
      } else {
        line = next;
      }
    }
    if (line) {
      text(ctx, line, x, lineY, style);
    }
  }

  function drawMain() {
    const { ctx, canvas } = main;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let any = false;
    if (state.screen) {
      drawScreen(ctx, state.screen);
      any = true;
    } else {
      if (state.banner) {
        ctx.fillStyle = INK;
        roundRect(ctx, 150, 150, MAIN_PX.w - 300, 130, 20);
        ctx.fill();
        text(ctx, state.banner.text, MAIN_PX.w / 2, 240, { size: 76, color: YELLOW });
        any = true;
      }
      if (state.toast) {
        ctx.fillStyle = INK;
        roundRect(ctx, 220, 20, MAIN_PX.w - 440, 110, 16);
        ctx.fill();
        text(ctx, state.toast.title, MAIN_PX.w / 2, 64, { size: 34, color: CYAN });
        text(ctx, state.toast.text, MAIN_PX.w / 2, 108, { size: 26, weight: 500, font: MONO, color: "#fff" });
        any = true;
      }
      if (state.prompt) {
        ctx.fillStyle = INK;
        roundRect(ctx, 100, 470, MAIN_PX.w - 200, 100, 18);
        ctx.fill();
        text(ctx, state.prompt, MAIN_PX.w / 2, 537, { size: 44, color: "#fff" });
        any = true;
      }
    }
    main.mesh.visible = any;
    if (any) {
      main.texture.needsUpdate = true;
    }
  }

  function drawStats(s) {
    const { ctx, canvas } = stats;
    const { w, h } = STATS_PX;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = INK;
    roundRect(ctx, 4, 4, w - 8, h - 8, 24);
    ctx.fill();

    bar(ctx, 30, 70, 280, 22, s.health / s.maxHealth, s.health < 35 ? RED : "#f5f7ff", `HP ${Math.ceil(s.health)}`);
    bar(ctx, 30, 140, 280, 16, s.shield / Math.max(1, s.maxShield), CYAN, `SHIELD ${Math.ceil(s.shield)}`);

    text(ctx, String(s.score), w / 2, 92, { size: 72, color: "#fff" });
    const tag = state.slowmo ? "LAST CHANCE" : state.boss ? `CARRIER ${Math.round(state.boss.hp * 100)}%${state.boss.open ? " · CORE OPEN" : ""}` : `×${s.combo.toFixed(1)} · ${Math.floor(s.distance)} M`;
    text(ctx, tag, w / 2, 150, { size: 30, weight: 500, font: MONO, color: state.slowmo || state.boss ? MAGENTA : "rgba(255,255,255,0.8)" });

    const weapon = WEAPONS[s.weaponIndex];
    const ammo = s.overclock > 0 ? "∞" : s.reloading ? "RELOAD" : `${s.ammo}/${s.magSize}`;
    text(ctx, ammo, w - 30, 92, { size: 60, color: s.reloading ? YELLOW : s.overclock > 0 ? MAGENTA : "#fff", align: "right" });
    const special = s.special.ready ? `${s.special.type.toUpperCase()} READY` : `${s.special.type.toUpperCase()} ${Math.floor(s.special.charge * 100)}%`;
    text(ctx, `${weapon?.code ?? ""} · ${special}`, w - 30, 150, {
      size: 26,
      weight: 500,
      font: MONO,
      color: s.special.ready ? YELLOW : "rgba(255,255,255,0.75)",
      align: "right",
    });
    stats.texture.needsUpdate = true;
  }

  /**
   * @param {number} delta  real seconds
   * @param {object|null} snapshot  runner stats (createXRMode.readStats) or null in menus
   */
  function update(delta, snapshot) {
    if (state.banner) {
      state.banner.time -= delta;
      if (state.banner.time <= 0) {
        state.banner = null;
        markDirty();
      }
    }
    if (state.toast) {
      state.toast.time -= delta;
      if (state.toast.time <= 0) {
        state.toast = null;
        markDirty();
      }
    }
    if (state.dirty) {
      state.dirty = false;
      drawMain();
    }

    if (state.statsVisible && snapshot) {
      state.statsTimer -= delta;
      if (state.statsTimer <= 0) {
        state.statsTimer = STATS_INTERVAL;
        drawStats(snapshot);
      }
    }

    if (state.damage > 0) {
      state.damage = Math.max(0, state.damage - delta * 2.2);
      damageMaterial.opacity = state.damage * 0.45;
    }
    damageMesh.visible = state.damage > 0.01;
  }

  function reset() {
    state.banner = null;
    state.toast = null;
    state.damage = 0;
    damageMesh.visible = false;
    markDirty();
  }

  function dispose() {
    for (const panel of [main, stats]) {
      panel.texture.dispose();
      panel.mesh.geometry.dispose();
      panel.mesh.material.dispose();
    }
    damageMesh.geometry.dispose();
    damageMaterial.dispose();
  }

  return {
    group,
    damageMesh,
    mainPanel: main.mesh,
    showScreen,
    hideScreen,
    showBanner,
    toast,
    setPrompt,
    setBoss,
    setSlowmo,
    flashDamage,
    hitMarker,
    setVisible,
    syncScreen,
    isPicking,
    moveHighlight,
    setHighlight,
    getHighlight: () => state.highlight,
    pickCardFromRay,
    getScreenMode: () => state.screen?.mode ?? "",
    update,
    reset,
    dispose,
  };
}
