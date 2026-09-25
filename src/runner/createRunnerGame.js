import * as THREE from "three/webgpu";
import { createRunnerControls } from "../controls/createRunnerControls.js";
import { createViewmodel } from "../weapon/createViewmodel.js";
import { createWeapon } from "../weapon/createWeapon.js";
import { createWeaponFx } from "../weapon/createWeaponFx.js";
import { createDroneManager } from "../enemies/createDroneManager.js";
import { createEnemyProjectiles } from "../enemies/createEnemyProjectiles.js";
import { DRONE_TYPES } from "../enemies/droneTypes.js";
import { createObstacles } from "./createObstacles.js";
import { createPickups } from "./createPickups.js";
import { createLaneLights } from "./createLaneLights.js";
import { createRunnerHud } from "../ui/runner/createRunnerHud.js";
import { shareRun } from "../ui/runner/shareCard.js";
import { createRunnerAudio } from "../audio/createRunnerAudio.js";
import { performanceProfile } from "../platform/performanceProfile.js";
import {
  getStoredRunnerBest,
  getStoredRunnerSpecial,
  setStoredRunnerBest,
  setStoredRunnerSpecial,
} from "../platform/userPreferences.js";
import { createSpecials } from "../weapon/createSpecials.js";
import { WEAPONS } from "../weapon/weaponTypes.js";
import { RUNNER } from "./runnerConfig.js";
import { createProgression } from "./progression.js";
import { createRunMods, rollUpgradeChoices, UPGRADES } from "./upgrades.js";
import { rr, rrDrone, rrPick, rrRange, rrShuffle, rrWeighted, setRunSeed, todayKey } from "./rng.js";

const STREET_CENTER_Z = RUNNER.laneZ[1];
const OBSTACLE_LOOKAHEAD = 115;
const FIRST_OBSTACLE_DISTANCE = 55;
const FIRST_DRONE_TIME = 3;
const SECTOR_LENGTH = 500;
const BOSS_INTERVAL = 1500;
const COMBO_STEP = 0.2;
const COMBO_MAX = 4;
const COMBO_DECAY_DELAY = 4;
const DEATH_SLOWMO = 0.22;
const DEATH_DURATION = 1.25;
const MAX_FRAME_DELTA = 1 / 20;
// Last-chance slow-mo: when a lethal hit is imminent, time drops to 35% for
// ~0.45 s of real time so the player can react (8 s cooldown).
const LAST_CHANCE_SCALE = 0.35;
const LAST_CHANCE_TIME = 0.45;
const LAST_CHANCE_COOLDOWN = 8;
// Hit-stop (sim freeze, real seconds) per kill.
const HIT_STOP = { scout: 0.045, kamikaze: 0.05, gunship: 0.09, carrier: 0.26 };
const NEAR_MISS_SCORE = 150;
const NEAR_MISS_WINDOW = 0.35;
// Sector colour grades (cycled after sector 1, which keeps the player's look).
const SECTOR_THEMES = ["magentaRain", "tealDusk", "sinCity", "neonNoir", "silentHill"];

const TUTORIAL_STEPS = [
  { id: "lane", desktop: "A / D — CHANGE LANE", touch: "SWIPE ← → — CHANGE LANE" },
  { id: "jump", desktop: "SPACE — JUMP THE BARRIER", touch: "SWIPE ↑ — JUMP THE BARRIER" },
  { id: "slide", desktop: "S — SLIDE UNDER THE BEAM", touch: "SWIPE ↓ — SLIDE UNDER THE BEAM" },
  { id: "shoot", desktop: "CLICK — SHOOT THE DRONE", touch: "HOLD FIRE — SHOOT THE DRONE" },
  { id: "special", desktop: "E — USE YOUR SPECIAL", touch: "TAP SPECIAL — USE IT" },
];

function vibrate(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Unsupported — ignore.
  }
}

/**
 * First-person endless runner + shooter on top of the Threejs-Punk scene.
 *
 * Owns: runner controls, rifle, drones, bolts, obstacles, pickups, HUD, SFX,
 * plus the meta layer (progression, missions, in-run upgrades, daily seed).
 * The render loop calls update(delta) right after the camera director and
 * before rain / ground / post, so the camera pose is final for every pass.
 */
export async function createRunnerGame({ scene, renderer, camera, world, baseFov }) {
  const track = world.track;
  const progression = createProgression();
  const meta = progression.data;
  let runMods = createRunMods();

  const controls = createRunnerControls({
    camera,
    domElement: renderer.domElement,
    baseFov,
  });
  const isTouch = controls.isTouch();

  const fx = createWeaponFx({ scene, camera });
  const audio = createRunnerAudio();
  const hud = createRunnerHud({ isTouch });

  const viewmodel = createViewmodel({ scene, camera });

  const projectiles = createEnemyProjectiles({ scene, fx });

  const game = {
    state: "idle",
    distance: 0,
    bonus: 0,
    score: 0,
    kills: 0,
    combo: 1,
    comboTimer: 0,
    health: RUNNER.maxHealth,
    shield: RUNNER.maxShield,
    sinceDamage: 99,
    stateTime: 0,
    countdown: 0,
    nextObstacleX: 0,
    droneTimer: FIRST_DRONE_TIME,
    nextSector: SECTOR_LENGTH,
    nextBoss: BOSS_INTERVAL,
    best: getStoredRunnerBest(),
    deathCause: "",
    deathDetail: "",
    daily: false,
    hitStop: 0,
    slowmo: 0,
    slowmoCooldown: 0,
    invuln: 0,
    clock: 0,
    tutorial: -1,
    tutorialTimer: 0,
    upgradeChoices: [],
    taken: {},
    build: [],
    sector: 1,
    lastRewards: null,
    missionTimer: 0,
  };
  const runStats = {};
  function resetStats() {
    Object.assign(runStats, {
      kills: 0,
      gunshipKills: 0,
      kamikazeKills: 0,
      slides: 0,
      barriersJumped: 0,
      cleanDistance: 0,
      distance: 0,
      nearMisses: 0,
      shards: 0,
      specialsUsed: 0,
      bossKills: 0,
    });
  }
  resetStats();
  let cleanRun = 0;

  const player = {
    x: 0,
    z: STREET_CENTER_Z,
    eyeY: 0,
    floorY: RUNNER.floorY,
    speed: RUNNER.startSpeed,
    streetCenterZ: STREET_CENTER_Z,
  };
  const playerBox = new THREE.Box3();

  const maxShield = () => RUNNER.maxShield + 10 * (meta.tiers.armor ?? 0);

  // ── Juice helpers ───────────────────────────────────────────────────────
  const _ndc = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  function toScreen(position, out = { x: 0, y: 0, behind: false }) {
    _ndc.copy(position).project(camera);
    out.behind = _ndc.z > 1;
    out.x = window.innerWidth / 2 + _ndc.x * (window.innerWidth / 2);
    out.y = window.innerHeight / 2 - _ndc.y * (window.innerHeight / 2);
    out.nx = _ndc.x;
    out.ny = _ndc.y;
    return out;
  }
  const _screen = {};

  function hitStop(seconds) {
    game.hitStop = Math.max(game.hitStop, seconds);
  }

  /** Directional shake: pushes the view away from `position`, scaled by distance. */
  function impactShake(position, strength, duration = 0.3) {
    const distance = Math.max(2, position.distanceTo(camera.position));
    const falloff = THREE.MathUtils.clamp(14 / distance, 0.25, 1.6);
    toScreen(position, _screen);
    const x = _screen.behind ? -_screen.nx : _screen.nx;
    const y = _screen.behind ? -_screen.ny : _screen.ny;
    const len = Math.hypot(x, y) || 1;
    controls.shake(strength * falloff, duration, { x: -x / len, y: -y / len });
  }

  const drones = createDroneManager({
    scene,
    fx,
    projectiles,
    audio,
    maxAlive: performanceProfile.runnerMaxDrones ?? 8,
    getBlastHex: () => progression.blastHex(),
    onKill: (drone) => {
      const id = drone.type.id;
      game.kills += 1;
      runStats.kills += 1;
      if (id === "gunship") {
        runStats.gunshipKills += 1;
      } else if (id === "kamikaze") {
        runStats.kamikazeKills += 1;
      } else if (id === "carrier") {
        runStats.bossKills += 1;
      }
      game.combo = Math.min(COMBO_MAX, game.combo + COMBO_STEP);
      game.comboTimer = COMBO_DECAY_DELAY;
      const points = Math.round(drone.type.score * game.combo);
      game.bonus += points;
      specials?.addCharge(0, true);
      hud.hitMarker(true);

      // Juice: hit-stop, directional shake, debris along the shot vector,
      // floating score, haptics.
      hitStop(HIT_STOP[id] ?? 0.05);
      impactShake(drone.position, drone.type.boss ? 0.2 : id === "gunship" ? 0.07 : 0.035, drone.type.boss ? 0.8 : 0.3);
      camera.getWorldDirection(_dir);
      fx.emitSparks(drone.position, drone.type.boss ? 60 : 26, {
        hex: progression.blastHex(),
        speed: 7,
        life: 0.7,
        size: 0.08,
        gravity: 5,
        baseVelocity: _dir.multiplyScalar(drone.type.boss ? 6 : 9),
      });
      toScreen(drone.position, _screen);
      if (!_screen.behind) {
        hud.popup(_screen.x, _screen.y, drone.type.boss ? `CARRIER DOWN +${points}` : `+${points} ×${game.combo.toFixed(1)}`, drone.type.boss ? "boss" : "kill");
      }
      if (drone.type.boss) {
        hud.showBanner("CARRIER DOWN", 2.2);
        hud.setBoss(null);
        if (isTouch) {
          vibrate([60, 40, 120]);
        }
      } else if (isTouch) {
        vibrate(25);
      }
      if (game.tutorial >= 0 && TUTORIAL_STEPS[game.tutorial]?.id === "shoot") {
        advanceTutorial();
      }
    },
    onKamikazeHit: (damage) => {
      damagePlayer(damage, "KAMIKAZE IMPACT", `KAMIKAZE DIVE · ${damage} DMG`);
      controls.shake(0.12, 0.45);
    },
    getDecoy: () => specials?.getAllyTarget() ?? null,
  });

  // Special attack (charged by hits; one type chosen per run).
  const specials = createSpecials({ scene, fx, drones, audio, getMods: () => runMods });
  specials.setType(getStoredRunnerSpecial());

  const obstacles = createObstacles({
    scene,
    carModel: world.car ?? null,
    poolSize: 6,
  });

  const pickups = createPickups({ scene });
  const laneLights = performanceProfile.runnerLaneLights === false ? null : createLaneLights({ scene });

  const weapon = viewmodel
    ? createWeapon({
        camera,
        controls,
        viewmodel,
        fx,
        drones,
        projectiles,
        audio,
        getWorldColliders: () => track?.colliders ?? [],
        getMods: () => runMods,
        getMetaDamage: () => 1 + 0.06 * (meta.tiers.damage ?? 0),
        isUnlocked: (index) => progression.isWeaponUnlocked(index),
        onLocked: (index) => {
          hud.showBanner(`${WEAPONS[index]?.code ?? "GUN"} LOCKED — ARMORY`, 1.4);
          audio.play("locked", { volume: 0.4 });
        },
        getTracerHex: () => progression.tracerHex(),
        onHit: (kind, drone, damage) => {
          if (kind === "drone") {
            specials.addCharge(damage ?? weapon?.state.weapon.damage ?? 1);
            hud.hitMarker(false);
            if (isTouch) {
              vibrate(8);
            }
          } else if (kind === "bolt") {
            game.bonus += 10;
            hud.hitMarker(false);
          }
        },
      })
    : null;

  const _specialOrigin = new THREE.Vector3();
  const _specialDir = new THREE.Vector3();
  function useSpecial() {
    if (game.state !== "running" || !specials.state.ready) {
      return;
    }
    viewmodel.getMuzzleWorldPosition(_specialOrigin);
    camera.getWorldDirection(_specialDir);
    if (specials.activate(_specialOrigin, _specialDir, player)) {
      runStats.specialsUsed += 1;
      hud.showBanner(specials.state.type === "ally" ? "ALLY DEPLOYED" : "SEEKER AWAY", 1.2);
      viewmodel.kick(1.5);
      if (game.tutorial >= 0 && TUTORIAL_STEPS[game.tutorial]?.id === "special") {
        advanceTutorial();
      }
    }
  }
  controls.on("special", useSpecial);
  hud.onSpecial(useSpecial);
  hud.onFire((held) => controls.setTrigger(held && game.state === "running"));
  hud.onSpecialSelect((id) => {
    specials.setType(id);
    setStoredRunnerSpecial(id);
    showStart();
  });

  // Action timestamps for near-miss detection.
  const actions = { jump: -99, slide: -99, laneLeft: [-99, -99, -99] };
  let currentLane = 1;
  controls.on("jump", () => {
    actions.jump = game.clock;
    audio.play("jump", { volume: 0.35 });
    tutorialAction("jump");
  });
  controls.on("land", () => audio.play("land", { volume: 0.35 }));
  controls.on("slide", () => {
    actions.slide = game.clock;
    audio.play("slide", { volume: 0.3 });
    tutorialAction("slide");
  });
  controls.on("lane", (lane) => {
    actions.laneLeft[currentLane] = game.clock;
    currentLane = lane;
    tutorialAction("lane");
  });
  controls.on("lockChange", (locked) => {
    if (!locked && game.state === "running" && !isTouch) {
      pause();
    } else if (locked && game.state === "paused") {
      resume();
    }
  });

  // ── Sector themes (colour grade per sector) ─────────────────────────────
  let pipeline = null;
  let basePreset = null;
  function applySectorTheme(sector) {
    if (!pipeline?.applyLookPreset) {
      return;
    }
    basePreset ??= pipeline.look?.getCurrentPresetId?.() ?? "neonNoir";
    const themes = SECTOR_THEMES.filter((id) => id !== basePreset);
    const id = sector <= 1 ? basePreset : themes[(sector - 2) % themes.length];
    pipeline.applyLookPreset(id, { bloomPass: pipeline.bloomPass, lensflare: pipeline.lensflare });
  }
  function restoreTheme() {
    if (pipeline && basePreset) {
      pipeline.applyLookPreset(basePreset, { bloomPass: pipeline.bloomPass, lensflare: pipeline.lensflare });
    }
    basePreset = null;
  }

  // ── State transitions ──────────────────────────────────────────────────
  function setState(next) {
    game.state = next;
    game.stateTime = 0;
    // Lets CSS hide chrome (header / audio button) during play on touch.
    document.documentElement.classList.toggle(
      "runner-playing",
      next === "running" || next === "countdown" || next === "dying" || next === "upgrade",
    );
    if (next !== "running") {
      controls.setTrigger(false);
    }
  }

  function syncMeta() {
    pickups.setMagnet(meta.tiers.magnet ?? 0, runMods.magnet);
    hud.setWeaponLocks(WEAPONS.map((_, index) => !progression.isWeaponUnlocked(index)));
  }

  function resetRun() {
    runMods = createRunMods();
    game.taken = {};
    game.build = [];
    controls.reset();
    weapon?.reset();
    weapon?.refreshMods?.();
    specials.reset(0.15 * (meta.tiers.charge ?? 0));
    drones.clear();
    projectiles.clear();
    obstacles.clear();
    pickups.clear();
    fx.clear();
    hud.setBoss(null);
    hud.setPrompt(null);
    hud.setSlowmo(false);
    game.distance = 0;
    game.bonus = 0;
    game.score = 0;
    game.kills = 0;
    game.combo = 1;
    game.comboTimer = 0;
    game.health = RUNNER.maxHealth;
    game.shield = maxShield();
    game.sinceDamage = 99;
    game.nextObstacleX = controls.state.x + FIRST_OBSTACLE_DISTANCE;
    game.droneTimer = FIRST_DRONE_TIME;
    game.nextSector = SECTOR_LENGTH;
    game.nextBoss = BOSS_INTERVAL;
    game.hitStop = 0;
    game.slowmo = 0;
    game.slowmoCooldown = 0;
    game.invuln = 0;
    game.sector = 1;
    game.deathDetail = "";
    currentLane = 1;
    cleanRun = 0;
    resetStats();
    syncMeta();
    track?.followGround(controls.state.x);
  }

  function metaSummary() {
    return {
      shards: meta.shards,
      rank: meta.rank,
      daily: game.daily,
      dailyBest: progression.todayDailyBest(),
      missionsReady: meta.missions.some((m) => m.done),
    };
  }

  function showStart() {
    hud.showScreen("start", { best: game.best, special: specials.state.type, meta: metaSummary() });
  }

  function enterMenu() {
    restoreTheme();
    audio.stopMusic();
    resetRun();
    controls.setActive(true);
    controls.setInputEnabled(false);
    hud.setVisible(false);
    specials.lock(false);
    showStart();
    setState("menu");
  }

  function prepareRun() {
    // The special chosen on the ticket is locked for the whole run.
    specials.lock(true);
    audio.ensureContext();
    // Daily Run: identical layout for everyone today.
    setRunSeed(game.daily ? todayKey() : null);
    game.nextObstacleX = controls.state.x + FIRST_OBSTACLE_DISTANCE;
    progression.beginRun();
    weather?.randomize();
    applySectorTheme(1);
    game.tutorial = !meta.tutorialDone && !game.daily ? 0 : -1;
  }

  function startCountdown() {
    prepareRun();
    controls.requestPointerLock();
    hud.hideScreen();
    hud.setVisible(true);
    game.countdown = 3;
    hud.showScreen("countdown", { text: "3" });
    audio.play("countdown");
    setState("countdown");
  }

  function beginRun(label = "RUN") {
    hud.hideScreen();
    hud.showBanner(label, 1.1);
    audio.play("go");
    audio.startMusic();
    controls.setInputEnabled(true);
    setState("running");
    if (game.tutorial >= 0) {
      startTutorialStep();
    }
  }

  function pause() {
    if (game.state !== "running") {
      return;
    }
    controls.setInputEnabled(false);
    hud.showScreen("pause");
    setState("paused");
  }

  function resume() {
    if (game.state !== "paused") {
      return;
    }
    if (!controls.isPointerLocked() && !isTouch) {
      controls.requestPointerLock();
      return;
    }
    hud.hideScreen();
    controls.setInputEnabled(true);
    setState("running");
  }

  /** Second wind (upgrade): survive one fatal hit. */
  function trySecondWind() {
    if (runMods.secondWind <= 0) {
      return false;
    }
    runMods.secondWind -= 1;
    game.health = Math.max(game.health, 35);
    game.shield = maxShield();
    game.invuln = 1.4;
    game.slowmo = 0.6;
    hud.showBanner("SECOND WIND", 1.6);
    audio.play("upgrade", { volume: 0.6 });
    return true;
  }

  function die(cause, detail = "") {
    if (game.state !== "running") {
      return;
    }
    game.deathCause = cause;
    game.deathDetail = detail;
    controls.setInputEnabled(false);
    controls.shake(0.18, 0.6);
    hud.flashDamage(1);
    hud.setSlowmo(false);
    audio.play("crash", { volume: 0.6 });
    audio.stopMusic();
    if (isTouch) {
      vibrate([80, 50, 160]);
    }
    setState("dying");
  }

  function showGameOver() {
    const newBest = game.score > game.best;
    if (newBest) {
      game.best = game.score;
      setStoredRunnerBest(game.best);
    }
    runStats.distance = game.distance;
    runStats.cleanDistance = Math.max(runStats.cleanDistance, cleanRun);
    const rewards = progression.endRun({
      ...runStats,
      score: game.score,
      distance: game.distance,
      kills: game.kills,
      daily: game.daily,
    });
    game.lastRewards = rewards;
    controls.exitPointerLock();
    hud.setVisible(false);
    hud.setBoss(null);
    hud.setPrompt(null);
    hud.showScreen("gameover", {
      score: game.score,
      distance: game.distance,
      kills: game.kills,
      best: game.daily ? meta.daily.best : game.best,
      newBest: game.daily ? rewards.dailyBest : newBest,
      cause: game.deathCause,
      detail: game.deathDetail,
      rewards,
      meta,
      daily: game.daily,
      build: game.build,
    });
    setState("dead");
  }

  /** Instant restart: no countdown, back in the run in well under a second. */
  function restart() {
    restoreTheme();
    resetRun();
    hud.setVisible(true);
    prepareRun();
    controls.requestPointerLock();
    beginRun("GO");
  }

  hud.onStart(startCountdown);
  hud.onRestart(restart);
  hud.onResume(resume);
  hud.onWeapon((index) => {
    if (game.state === "running") {
      weapon?.selectWeapon(index);
    }
  });

  // Menu / meta actions (Armory, Missions, Records, Daily, Share, upgrades).
  hud.onAction((action, data) => {
    switch (action) {
      case "armory":
        hud.showScreen("armory", { meta });
        break;
      case "missions":
        hud.showScreen("missions", { meta, streakMultiplier: progression.streakMultiplier() });
        break;
      case "records":
        hud.showScreen("records", { meta, dailyBest: progression.todayDailyBest() });
        break;
      case "daily":
        game.daily = !game.daily;
        showStart();
        break;
      case "menu":
        if (game.state === "dead") {
          enterMenu();
        } else {
          showStart();
        }
        break;
      case "buy": {
        const kind = data.kind;
        const ok =
          kind === "weapon"
            ? progression.buyWeapon(Number(data.id))
            : kind === "tier"
              ? progression.buyTier(data.id)
              : progression.buyOrEquip(kind, data.id);
        audio.ensureContext();
        audio.play(ok ? "pickup" : "locked", { volume: 0.5 });
        hud.showScreen("armory", { meta });
        if (!ok) {
          hud.screen
            .querySelector(`[data-kind="${kind}"][data-id="${data.id}"]`)
            ?.classList.add("is-denied");
        }
        syncMeta();
        break;
      }
      case "share":
        shareRun({
          score: game.score,
          distance: game.distance,
          kills: game.kills,
          cause: game.deathCause,
          build: game.build,
          daily: game.daily,
          rank: meta.rank,
        });
        break;
      case "upgrade":
        pickUpgrade(data.id);
        break;
      default:
        break;
    }
  });

  document.addEventListener("keydown", (event) => {
    if (game.state === "upgrade") {
      const index = ["Digit1", "Digit2", "Digit3", "Numpad1", "Numpad2", "Numpad3"].indexOf(event.code) % 3;
      if (index >= 0 && game.upgradeChoices[index]) {
        pickUpgrade(game.upgradeChoices[index].id);
      }
      return;
    }
    if (event.code !== "Enter" && event.code !== "NumpadEnter") {
      return;
    }
    if (game.state === "dead") {
      restart();
    } else if (game.state === "menu" && hud.getScreenMode() === "start") {
      startCountdown();
    }
  });

  // ── In-run upgrades (sector gates) ──────────────────────────────────────
  function openUpgradePicker() {
    const choices = rollUpgradeChoices(
      game.taken,
      { special: specials.state.type, hasRail: progression.isWeaponUnlocked(2) },
      rrDrone,
    );
    if (!choices.length) {
      return false;
    }
    game.upgradeChoices = choices;
    controls.setInputEnabled(false);
    if (!isTouch) {
      controls.exitPointerLock();
    }
    hud.showScreen("upgrade", { choices, sector: game.sector });
    audio.play("upgrade", { volume: 0.5 });
    setState("upgrade");
    return true;
  }

  function pickUpgrade(id) {
    if (game.state !== "upgrade") {
      return;
    }
    const upgrade = UPGRADES.find((u) => u.id === id);
    if (!upgrade) {
      return;
    }
    upgrade.apply(runMods);
    game.taken[id] = (game.taken[id] ?? 0) + 1;
    game.build.push(upgrade.name);
    weapon?.refreshMods?.();
    syncMeta();
    hud.hideScreen();
    hud.showBanner(upgrade.name, 1.2);
    controls.setInputEnabled(true);
    if (!isTouch) {
      controls.requestPointerLock();
    }
    setState("running");
    spawnSectorWave();
  }

  // ── Tutorial (first run only) ──────────────────────────────────────────
  function startTutorialStep() {
    const step = TUTORIAL_STEPS[game.tutorial];
    if (!step) {
      finishTutorial();
      return;
    }
    game.tutorialTimer = 0;
    hud.setPrompt(isTouch ? step.touch : step.desktop);
    const x = controls.state.x + 34;
    if (step.id === "jump") {
      obstacles.spawn("barrier", x, currentLane);
    } else if (step.id === "slide") {
      obstacles.spawn("beam", x, currentLane);
    } else if (step.id === "shoot") {
      drones.spawn("scout", player, { force: true });
    } else if (step.id === "special") {
      specials.grantCharge();
    }
  }

  function tutorialAction(id) {
    if (game.state === "running" && game.tutorial >= 0 && TUTORIAL_STEPS[game.tutorial]?.id === id) {
      advanceTutorial();
    }
  }

  function advanceTutorial() {
    game.tutorial += 1;
    audio.play("pickup", { volume: 0.4 });
    // Small delay so the next prompt doesn't stomp the action feedback.
    hud.setPrompt(null);
    game.tutorialTimer = -0.9;
  }

  function finishTutorial() {
    game.tutorial = -1;
    hud.setPrompt(null);
    hud.showBanner("TRAINING COMPLETE", 1.8);
    progression.setTutorialDone();
    game.nextObstacleX = controls.state.x + 40;
    game.droneTimer = 2;
  }

  function updateTutorial(delta) {
    if (game.tutorialTimer < 0) {
      game.tutorialTimer += delta;
      if (game.tutorialTimer >= 0) {
        startTutorialStep();
      }
      return;
    }
    game.tutorialTimer += delta;
    const step = TUTORIAL_STEPS[game.tutorial];
    // Re-issue a drone if the tutorial target escaped.
    if (step?.id === "shoot" && drones.countAlive() === 0 && game.tutorialTimer > 2) {
      drones.spawn("scout", player, { force: true });
      game.tutorialTimer = 0;
    }
    // Re-spawn the obstacle if it was dodged without the asked-for move.
    if ((step?.id === "jump" || step?.id === "slide") && game.tutorialTimer > 4) {
      obstacles.spawn(step.id === "jump" ? "barrier" : "beam", controls.state.x + 34, currentLane);
      game.tutorialTimer = 0;
    }
  }

  // ── Combat ─────────────────────────────────────────────────────────────
  function damagePlayer(amount, cause = "SHOT DOWN", detail = "") {
    if (game.state !== "running" || game.invuln > 0) {
      return;
    }
    const absorbed = Math.min(game.shield, amount);
    game.shield -= absorbed;
    game.health -= amount - absorbed;
    game.sinceDamage = 0;
    game.combo = 1;
    runStats.cleanDistance = Math.max(runStats.cleanDistance, cleanRun);
    cleanRun = 0;
    hud.flashDamage(absorbed === amount ? 0.35 : 0.8);
    audio.play("damage", { volume: 0.5 });
    if (isTouch) {
      vibrate(absorbed === amount ? 30 : 70);
    }
    if (game.tutorial >= 0) {
      game.health = Math.max(game.health, 20);
    }
    if (game.health <= 0) {
      game.health = 0;
      if (!trySecondWind()) {
        die(cause, detail);
      }
    }
  }

  function onNearMiss(label, position = null) {
    runStats.nearMisses += 1;
    const points = Math.round(NEAR_MISS_SCORE * game.combo);
    game.bonus += points;
    game.combo = Math.min(COMBO_MAX, game.combo + COMBO_STEP * 0.5);
    game.comboTimer = COMBO_DECAY_DELAY;
    specials.addCharge(4);
    audio.play("nearMiss", { volume: 0.4 });
    let x = window.innerWidth / 2;
    let y = window.innerHeight * 0.42;
    if (position) {
      toScreen(position, _screen);
      if (!_screen.behind) {
        x = THREE.MathUtils.clamp(_screen.x, 80, window.innerWidth - 80);
        y = THREE.MathUtils.clamp(_screen.y, 80, window.innerHeight - 80);
      }
    }
    hud.popup(x, y, `${label} +${points}`, "near");
  }

  // ── Spawning (seeded via rng.js for the Daily Run) ─────────────────────
  function difficulty() {
    return THREE.MathUtils.clamp(game.distance / RUNNER.difficultyDistance, 0, 1);
  }

  function spawnRewardLine(x, freeLanes, lanes) {
    const d = difficulty();
    if (rr() < 0.09 + d * 0.04) {
      const lane = freeLanes.length ? rrPick(freeLanes) : lanes[0];
      const id = rrWeighted([
        { value: "shield", weight: 1.2 },
        { value: "health", weight: game.health < RUNNER.maxHealth * 0.6 ? 1.5 : 0.4 },
        { value: "overclock", weight: 1 },
      ]);
      pickups.spawn(id, x - 8, lane, 1.1);
    } else if (freeLanes.length > 0) {
      const lane = rrPick(freeLanes);
      for (let i = 0; i < 5; i++) {
        pickups.spawn("shard", x - 14 + i * 2.6, lane, 1.0);
      }
    } else {
      const lane = lanes[0];
      for (let i = 0; i < 4; i++) {
        const t = i / 3;
        pickups.spawn("shard", x - 3.5 + t * 7, lane, 1.1 + Math.sin(t * Math.PI) * 0.9);
      }
    }
  }

  function spawnObstacleRow(x) {
    const d = difficulty();
    const lanes = rrShuffle([0, 1, 2]);
    let count = 1;
    if (rr() < 0.2 + d * 0.5) {
      count = 2;
    }
    if (d > 0.45 && rr() < 0.2 + (d - 0.45) * 0.4) {
      count = 3;
    }

    const kinds = [];
    const hasCar = obstacles.kinds.includes("car");
    const hasBarrier = obstacles.kinds.includes("barrier");
    for (let i = 0; i < count; i++) {
      const options = [{ value: "beam", weight: 1 }];
      if (hasBarrier) {
        options.push({ value: "barrier", weight: 1.1 });
      }
      if (hasCar) {
        options.push({ value: "car", weight: 1 });
      }
      kinds.push(rrWeighted(options));
    }
    // Never wall off every lane with cars: keep one jump / slide answer.
    if (count === 3 && kinds.every((kind) => kind === "car")) {
      kinds[Math.floor(rr() * 3)] = hasBarrier ? "barrier" : "beam";
    }
    // Rows of 3 use one answer so there is always a readable escape.
    if (count === 3 && !kinds.includes("car")) {
      const answer = kinds[0];
      kinds.fill(answer);
    }

    const blocked = new Set();
    for (let i = 0; i < count; i++) {
      const lane = lanes[i];
      if (obstacles.spawn(kinds[i], x, lane)) {
        blocked.add(lane);
      }
    }
    spawnRewardLine(x, [0, 1, 2].filter((lane) => !blocked.has(lane)), lanes);
    return 0;
  }

  /**
   * Set pieces: authored patterns mixed into the stream after 250 m.
   * Returns extra length consumed beyond the normal row gap.
   */
  const SET_PIECES = {
    // Rhythm run: full rows alternating jump / slide.
    gauntlet(x) {
      const hasBarrier = obstacles.kinds.includes("barrier");
      for (let i = 0; i < 4; i++) {
        const kind = hasBarrier && i % 2 === 0 ? "barrier" : "beam";
        for (const lane of [0, 1, 2]) {
          obstacles.spawn(kind, x + i * 10, lane);
        }
        pickups.spawn("shard", x + i * 10 + 5, 1, 1.2);
      }
      return 32;
    },
    // Car pile-up: the free lane zig-zags.
    pileup(x) {
      if (!obstacles.kinds.includes("car")) {
        return spawnObstacleRow(x);
      }
      let free = Math.floor(rr() * 3);
      for (let i = 0; i < 3; i++) {
        for (const lane of [0, 1, 2]) {
          if (lane !== free) {
            obstacles.spawn("car", x + i * 16, lane);
          }
        }
        for (let s = 0; s < 3; s++) {
          pickups.spawn("shard", x + i * 16 - 3 + s * 3, free, 1.0);
        }
        free = (free + (rr() < 0.5 ? 1 : 2)) % 3;
      }
      return 34;
    },
    // Drone ambush from behind + a normal row.
    ambush(x) {
      spawnObstacleRow(x);
      hud.showBanner("AMBUSH — CHECK SIX", 1.4);
      for (let i = 0; i < 2; i++) {
        drones.spawn(i === 0 && game.distance > DRONE_TYPES.gunship.unlockDistance ? "gunship" : "scout", player, { fromBehind: true });
      }
      return 6;
    },
  };

  function updateObstacleSpawner() {
    if (game.tutorial >= 0) {
      return;
    }
    const d = difficulty();
    while (game.nextObstacleX < controls.state.x + OBSTACLE_LOOKAHEAD) {
      let extra = 0;
      if (game.distance > 250 && rr() < 0.1 + d * 0.06) {
        const piece = rrWeighted([
          { value: "gauntlet", weight: 1 },
          { value: "pileup", weight: 1 },
          { value: "ambush", weight: game.distance > 400 ? 0.8 : 0 },
        ]);
        extra = SET_PIECES[piece](game.nextObstacleX);
      } else {
        spawnObstacleRow(game.nextObstacleX);
      }
      const gap = THREE.MathUtils.lerp(34, 19, d) * rrRange(0.9, 1.3);
      game.nextObstacleX += gap + extra;
    }
  }

  function updateDroneSpawner(delta) {
    if (game.tutorial >= 0) {
      return;
    }
    const d = difficulty();
    game.droneTimer -= delta;
    const bossUp = Boolean(drones.getBoss());
    const cap = Math.min(performanceProfile.runnerMaxDrones ?? 8, 3 + Math.floor(d * 6)) - (bossUp ? 2 : 0);
    if (game.droneTimer > 0 || drones.countAlive() >= cap) {
      return;
    }
    const options = Object.values(DRONE_TYPES)
      .filter((type) => !type.boss && game.distance >= type.unlockDistance)
      .map((type) => ({
        value: type.id,
        weight: type.id === "scout" ? 3 : type.id === "gunship" ? 0.8 + d : 1 + d,
      }));
    const typeId = rrWeighted(options, rrDrone);
    drones.spawn(typeId, player);
    game.droneTimer = THREE.MathUtils.lerp(3.2, 1.0, d) * (0.7 + rrDrone() * 0.5);
  }

  function spawnSectorWave() {
    hud.showBanner(`SECTOR ${game.sector}`, 1.8);
    applySectorTheme(game.sector);
    const waveSize = Math.min(3, 1 + Math.floor(difficulty() * 3));
    for (let i = 0; i < waveSize; i++) {
      drones.spawn(i === 0 && game.distance > DRONE_TYPES.gunship.unlockDistance ? "gunship" : "scout", player);
    }
  }

  function spawnBoss() {
    if (drones.getBoss()) {
      return;
    }
    const boss = drones.spawn("carrier", player, { force: true });
    if (boss) {
      hud.showBanner("CARRIER INBOUND", 2.2);
      audio.play("boss", { volume: 0.7 });
      if (isTouch) {
        vibrate([100, 60, 100]);
      }
    }
  }

  // ── Per-frame ──────────────────────────────────────────────────────────
  function syncPlayer() {
    const s = controls.state;
    player.x = s.x;
    player.z = s.z;
    player.eyeY = s.feetY + s.eyeHeight;
    player.speed = s.speed;
    controls.getPlayerBox(playerBox);
  }

  function applyWrap() {
    const shift = track?.getWrapShift(controls.state.x) ?? 0;
    if (shift === 0) {
      return;
    }
    controls.shiftX(shift);
    drones.shiftX(shift);
    projectiles.shiftX(shift);
    obstacles.shiftX(shift);
    pickups.shiftX(shift);
    fx.shiftX(shift);
    specials.shiftX(shift);
    game.nextObstacleX += shift;
  }

  const threats = [];

  const targets = [];
  let dayNight = null;
  let weather = null;

  function collectThreats() {
    threats.length = 0;
    targets.length = 0;
    let nearest = Infinity;
    const halfW = window.innerWidth / 2;
    const halfH = window.innerHeight / 2;
    const focal = halfH / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    drones.forEachThreat((drone) => {
      const distance = drone.position.distanceTo(camera.position);
      nearest = Math.min(nearest, distance);
      _ndc.copy(drone.position).project(camera);
      const behind = _ndc.z > 1;
      const onScreen = !behind && Math.abs(_ndc.x) < 0.92 && Math.abs(_ndc.y) < 0.88;
      const urgent = drone.state === "dive" || drone.charge > 0 || drone.burstLeft > 0;
      if (onScreen) {
        if (targets.length < 10) {
          targets.push({
            x: halfW + _ndc.x * halfW,
            y: halfH - _ndc.y * halfH,
            size: Math.max(26, Math.min(160, (drone.type.radius * 1.5 * focal) / Math.max(1, distance))),
            urgent,
            hp: Math.max(0, drone.hp / drone.type.hp),
            label: drone.type.boss ? "CRR" : drone.type.id === "gunship" ? "GNS" : drone.type.id === "kamikaze" ? "KMZ" : "SCT",
            distance,
          });
        }
        return;
      }
      if (threats.length >= 8) {
        return;
      }
      let x = _ndc.x;
      let y = -_ndc.y;
      if (behind) {
        x = -x;
        y = -y;
      }
      threats.push({ angle: Math.atan2(y, x), urgent });
    });
    audio.setHum(nearest < 60 ? 1 - nearest / 60 : 0);
    return threats;
  }

  function snapshot() {
    return {
      score: game.score,
      combo: game.combo,
      distance: game.distance,
      speed: controls.state.speed,
      health: game.health,
      maxHealth: RUNNER.maxHealth,
      shield: game.shield,
      maxShield: maxShield(),
      ammo: weapon?.state.ammo ?? 0,
      magSize: weapon?.state.magSize ?? 0,
      reloading: weapon?.state.reloading ?? false,
      reload: weapon?.getReloadProgress() ?? 0,
      overclock: weapon?.state.overclock ?? 0,
      spread: weapon?.state.spread ?? 0,
      weaponIndex: weapon?.state.index ?? 0,
      threats: collectThreats(),
      clock: dayNight ? `${dayNight.getClock()} ${dayNight.getLabel()}${weather ? ` · ${weather.getLabel()}` : ""}` : "",
      special: {
        type: specials.state.type,
        charge: specials.state.charge,
        ready: specials.state.ready,
        allyHp: specials.getAllyHp(),
      },
      targets,
    };
  }

  /**
   * Touch auto-aim priority: the boss while its weak point is open, a drone
   * that is charging / diving, else the nearest drone ahead within range.
   */
  function pickAutoAimTarget() {
    let best = null;
    let bestScore = Infinity;
    drones.forEachThreat((drone) => {
      if (drone.state === "enter" || drone.position.x < player.x + 2) {
        return;
      }
      const distance = drone.position.distanceTo(camera.position);
      if (distance > 70) {
        return;
      }
      const urgent = drone.state === "dive" || drone.charge > 0 || drone.burstLeft > 0;
      const bossOpen = drone.type.boss && drones.isOpen(drone);
      const score = distance - (urgent ? 40 : 0) - (bossOpen ? 60 : 0) + (drone.type.boss && !bossOpen ? 30 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = drone;
      }
    });
    return best ? best.position : null;
  }

  /** Obstacle arrivals: near-miss + mission stats (jumped / slid). */
  function checkObstacleArrivals() {
    for (const obstacle of obstacles.getActive()) {
      if (obstacle.arrived || obstacle.box.min.x > player.x + 0.4) {
        continue;
      }
      obstacle.arrived = true;
      if (game.tutorial >= 0) {
        continue;
      }
      const lane = obstacle.lane;
      if (lane === currentLane) {
        if (obstacle.kind === "barrier") {
          runStats.barriersJumped += 1;
          if (game.clock - actions.jump < NEAR_MISS_WINDOW) {
            onNearMiss("CLOSE CALL");
          }
        } else if (obstacle.kind === "beam") {
          runStats.slides += 1;
          if (game.clock - actions.slide < NEAR_MISS_WINDOW) {
            onNearMiss("CLOSE CALL");
          }
        }
      } else if (game.clock - actions.laneLeft[lane] < NEAR_MISS_WINDOW) {
        onNearMiss("CLOSE CALL");
      }
    }
  }

  /** True when a lethal hit lands within ~0.3 s unless the player reacts. */
  function lethalHitImminent() {
    const speed = Math.max(1, controls.state.speed);
    for (const obstacle of obstacles.getActive()) {
      if (obstacle.lane !== currentLane || obstacle.arrived) {
        continue;
      }
      const gap = obstacle.box.min.x - playerBox.max.x;
      if (gap > 0 && gap / speed < 0.3 && obstacle.box.max.y > playerBox.min.y && obstacle.box.min.y < playerBox.max.y) {
        return true;
      }
    }
    const pool = game.health + game.shield;
    let lethal = false;
    projectiles.forEachAlive((bolt) => {
      if (lethal || bolt.damage < pool) {
        return;
      }
      const distance = playerBox.distanceToPoint(bolt.position);
      const approach = bolt.velocity.x - controls.state.speed;
      if (distance < 5 && approach < -1 && distance / -approach < 0.25) {
        lethal = true;
      }
    });
    return lethal;
  }

  function simulateWorld(delta, { running }) {
    syncPlayer();

    if (running) {
      updateObstacleSpawner();
      updateDroneSpawner(delta);
      if (game.distance >= game.nextBoss && game.tutorial < 0) {
        spawnBoss();
        game.nextBoss += BOSS_INTERVAL;
      }
    }

    drones.update(delta, player, { allowFire: running });
    projectiles.update(delta, {
      playerBox,
      floorY: RUNNER.floorY,
      playerX: player.x,
      onHitPlayer: (damage, position, source) => {
        if (position) {
          impactShake(position, 0.06, 0.25);
        }
        damagePlayer(damage, "SHOT DOWN", `${source ?? "DRONE BOLT"} · ${damage} DMG`);
      },
      onNearMiss: running ? (bolt) => onNearMiss("DODGED", bolt.position) : null,
      ally: specials.getAllyTarget(),
      onHitAlly: (damage) => specials.damageAlly(damage),
    });

    if (running) {
      checkObstacleArrivals();
      const hit = obstacles.update(playerBox, player.x);
      if (hit && game.tutorial < 0 && game.invuln <= 0) {
        const cause = hit.kind === "car" ? "HIT A PARKED CAR" : hit.kind === "beam" ? "CLOTHESLINED" : "TRIPPED A BARRIER";
        const detail = `${hit.kind.toUpperCase()} · LANE ${hit.lane + 1} · ${Math.round(controls.state.speed * 3.6)} KM/H`;
        if (trySecondWind()) {
          controls.shake(0.15, 0.5);
        } else {
          die(cause, detail);
        }
      }
      pickups.update(delta, playerBox, player.x, (pickup) => {
        audio.play("pickup", { volume: 0.4 });
        if (pickup.id === "shard") {
          runStats.shards += 1;
          game.bonus += Math.round(pickup.type.score * game.combo);
        } else if (pickup.id === "shield") {
          game.shield = maxShield();
          hud.showBanner("SHIELD RESTORED", 1.2);
        } else if (pickup.id === "health") {
          game.health = Math.min(RUNNER.maxHealth, game.health + 35);
          hud.showBanner("INTEGRITY +35", 1.2);
        } else if (pickup.id === "overclock") {
          weapon?.addOverclock(6);
          hud.showBanner("OVERCLOCK", 1.4);
        }
      });
    }

    if (running && isTouch) {
      controls.autoAim(pickAutoAimTarget(), delta);
    }
    specials.update(delta, player);
    weapon?.update(delta, { canFire: running });
    if (weapon) {
      viewmodel?.setAmmoDisplay(
        weapon.state.ammo,
        weapon.state.magSize,
        weapon.state.overclock > 0,
        weapon.state.reloading,
      );
    }
    viewmodel?.update(delta, controls.state);
    fx.update(delta);
  }

  function updateRunning(realDelta) {
    // Hit-stop freezes the sim; last-chance slow-mo scales it.
    if (game.hitStop > 0) {
      game.hitStop -= realDelta;
      controls.update(0, { simulateMovement: false });
      return;
    }
    game.slowmoCooldown -= realDelta;
    if (game.slowmo <= 0 && game.slowmoCooldown <= 0 && game.tutorial < 0 && lethalHitImminent()) {
      game.slowmo = LAST_CHANCE_TIME;
      game.slowmoCooldown = LAST_CHANCE_COOLDOWN;
      audio.play("nearMiss", { volume: 0.3, detune: -1200 });
    }
    let delta = realDelta;
    if (game.slowmo > 0) {
      game.slowmo -= realDelta;
      delta *= LAST_CHANCE_SCALE;
    }
    hud.setSlowmo(game.slowmo > 0);
    game.clock += delta;
    game.invuln = Math.max(0, game.invuln - delta);

    const d = difficulty();
    const eased = 1 - Math.pow(1 - d, 1.6);
    controls.setSpeed(THREE.MathUtils.lerp(RUNNER.startSpeed, RUNNER.maxSpeed, eased));
    controls.update(delta);
    applyWrap();
    track?.followGround(controls.state.x);
    const step = controls.state.speed * delta;
    game.distance += step;
    cleanRun += step;
    dayNight?.update(delta);
    weather?.update(delta);

    game.sinceDamage += delta;
    if (game.sinceDamage > RUNNER.shieldRechargeDelay) {
      game.shield = Math.min(maxShield(), game.shield + RUNNER.shieldRechargeRate * runMods.shieldRegen * delta);
    }
    if (game.comboTimer > 0) {
      game.comboTimer -= delta;
    } else if (game.combo > 1) {
      game.combo = Math.max(1, game.combo - delta * 0.5);
    }

    if (game.tutorial >= 0) {
      updateTutorial(delta);
    }

    simulateWorld(delta, { running: true });
    game.score = Math.floor(game.distance) + game.bonus;
    if (game.state !== "running") {
      return;
    }

    // Boss HUD + adaptive music.
    const boss = drones.getBoss();
    hud.setBoss(boss ? { hp: Math.max(0, boss.hp / boss.type.hp), open: drones.isOpen(boss) } : null);
    const heat = (game.combo - 1) / (COMBO_MAX - 1);
    audio.setMusicIntensity(Math.max(boss ? 0.75 : 0, 0.1 + heat * 0.9));

    // Live mission progress → toasts.
    game.missionTimer -= realDelta;
    if (game.missionTimer <= 0) {
      game.missionTimer = 0.5;
      runStats.distance = game.distance;
      runStats.cleanDistance = Math.max(runStats.cleanDistance, cleanRun);
      for (const mission of progression.trackRun(runStats)) {
        hud.toast("MISSION COMPLETE", mission.text);
        audio.play("mission", { volume: 0.5 });
      }
    }

    // Sector gate → upgrade picker.
    if (game.distance >= game.nextSector) {
      game.nextSector += SECTOR_LENGTH;
      game.sector += 1;
      if (!openUpgradePicker()) {
        spawnSectorWave();
      }
    }
  }

  function update(rawDelta) {
    const delta = Math.min(rawDelta, MAX_FRAME_DELTA);
    game.stateTime += delta;

    switch (game.state) {
      case "idle":
      case "menu": {
        controls.update(delta, { simulateMovement: false });
        viewmodel?.update(delta, controls.state);
        fx.update(delta);
        break;
      }
      case "countdown": {
        controls.update(delta, { simulateMovement: false });
        viewmodel?.update(delta, controls.state);
        const before = Math.ceil(game.countdown);
        game.countdown -= delta;
        const after = Math.ceil(game.countdown);
        if (game.countdown <= 0) {
          beginRun();
        } else if (after !== before) {
          hud.showScreen("countdown", { text: String(after) });
          audio.play("countdown");
        }
        break;
      }
      case "running": {
        updateRunning(delta);
        break;
      }
      case "paused":
      case "upgrade": {
        controls.update(0, { simulateMovement: false });
        viewmodel?.update(0, controls.state);
        break;
      }
      case "dying": {
        const slow = delta * DEATH_SLOWMO;
        controls.update(slow, { simulateMovement: false });
        simulateWorld(slow, { running: false });
        if (game.stateTime >= DEATH_DURATION) {
          showGameOver();
        }
        break;
      }
      case "dead": {
        controls.update(delta, { simulateMovement: false });
        simulateWorld(delta * 0.35, { running: false });
        break;
      }
      default:
        break;
    }

    laneLights?.update(game.state === "running" ? delta : delta * 0.3, controls.state.x, controls.state.speed);
    hud.update(rawDelta, game.state === "idle" || game.state === "menu" ? null : snapshot());
  }

  /** Place the camera at the run start (used before the intro reveals). */
  function placeAtStart() {
    resetRun();
    controls.setActive(true);
    controls.setInputEnabled(false);
    controls.update(0, { simulateMovement: false });
    viewmodel?.update(0, controls.state);
  }

  // ── Warmup: make one of every pooled object visible for compileAsync ─────
  const _warmPos = new THREE.Vector3();
  const warm = {
    begin() {
      camera.getWorldDirection(_warmPos).multiplyScalar(8).add(camera.position);
      fx.setWarmupVisible(true, _warmPos);
      drones.setWarmupVisible(true, _warmPos);
      specials.setWarmupVisible(true, _warmPos);
      projectiles.setWarmupVisible(true, _warmPos);
      obstacles.setWarmupVisible(true, _warmPos);
      pickups.setWarmupVisible(true, _warmPos);
      viewmodel?.setWarmupVisible(true);
    },
    end() {
      fx.setWarmupVisible(false);
      drones.setWarmupVisible(false);
      specials.setWarmupVisible(false);
      projectiles.setWarmupVisible(false);
      obstacles.setWarmupVisible(false);
      pickups.setWarmupVisible(false);
      viewmodel?.setWarmupVisible(false);
    },
  };

  /** Dynamic runner objects never belong in the rain collision height map. */
  const collisionHideObjects = [
    specials.group,
    drones.group,
    projectiles.group,
    pickups.group,
    ...(laneLights ? [laneLights.mesh] : []),
    ...fx.hideObjects,
    ...(viewmodel ? [viewmodel.rig] : []),
  ];

  return {
    controls,
    hud,
    weapon,
    specials,
    drones,
    projectiles,
    obstacles,
    pickups,
    fx,
    audio,
    game,
    progression,
    runStats,
    getRunMods: () => runMods,
    warm,
    collisionHideObjects,
    update,
    setDayNight: (cycle) => {
      dayNight = cycle;
    },
    getDayNight: () => dayNight,
    setWeather: (system) => {
      weather = system;
    },
    getWeather: () => weather,
    /** Post pipeline, for per-sector colour grades. */
    setPipeline: (value) => {
      pipeline = value;
    },
    enterMenu,
    placeAtStart,
    getState: () => game.state,
  };
}
