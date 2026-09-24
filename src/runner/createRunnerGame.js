import * as THREE from "three/webgpu";
import { getGltfLoader } from "../world/loaders/createGltfLoaders.js";
import { createRunnerControls } from "../controls/createRunnerControls.js";
import { createViewmodel } from "../weapon/createViewmodel.js";
import { createWeapon } from "../weapon/createWeapon.js";
import { createWeaponFx } from "../weapon/createWeaponFx.js";
import { createDroneManager } from "../enemies/createDroneManager.js";
import { createEnemyProjectiles } from "../enemies/createEnemyProjectiles.js";
import { DRONE_TYPES } from "../enemies/droneTypes.js";
import { createObstacles } from "./createObstacles.js";
import { createPickups } from "./createPickups.js";
import { createRunnerHud } from "../ui/runner/createRunnerHud.js";
import { createRunnerAudio } from "../audio/createRunnerAudio.js";
import { performanceProfile } from "../platform/performanceProfile.js";
import { getStoredRunnerBest, setStoredRunnerBest } from "../platform/userPreferences.js";
import { RUNNER } from "./runnerConfig.js";

const MODEL_PATHS = {
  rifle: "/models/runner/blaster-repeater.glb",
  drone: "/models/runner/enemy-flying.glb",
  barrier: "/models/runner/wall-low.glb",
};

const STREET_CENTER_Z = RUNNER.laneZ[1];
const OBSTACLE_LOOKAHEAD = 115;
const FIRST_OBSTACLE_DISTANCE = 55;
const FIRST_DRONE_TIME = 6;
const SECTOR_LENGTH = 500;
const COMBO_STEP = 0.2;
const COMBO_MAX = 4;
const COMBO_DECAY_DELAY = 4;
const DEATH_SLOWMO = 0.22;
const DEATH_DURATION = 1.25;
const MAX_FRAME_DELTA = 1 / 20;

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function pickWeighted(entries) {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * total;
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll <= 0) {
      return entry.value;
    }
  }
  return entries[entries.length - 1].value;
}

async function loadModels(renderer) {
  const loader = getGltfLoader(renderer);
  const entries = await Promise.all(
    Object.entries(MODEL_PATHS).map(async ([key, url]) => {
      try {
        const gltf = await loader.loadAsync(url);
        return [key, gltf.scene];
      } catch (error) {
        console.warn(`[runner] Failed to load ${url}:`, error);
        return [key, null];
      }
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * First-person endless runner + shooter on top of the Threejs-Punk scene.
 *
 * Owns: runner controls, rifle, drones, bolts, obstacles, pickups, HUD, SFX.
 * The render loop calls update(delta) right after the camera director and
 * before rain / ground / post, so the camera pose is final for every pass.
 */
export async function createRunnerGame({ scene, renderer, camera, world, baseFov }) {
  const track = world.track;
  const models = await loadModels(renderer);

  const controls = createRunnerControls({
    camera,
    domElement: renderer.domElement,
    baseFov,
  });

  const fx = createWeaponFx({ scene });
  const audio = createRunnerAudio();
  const hud = createRunnerHud({ isTouch: controls.isTouch() });

  const viewmodel = models.rifle
    ? createViewmodel({ scene, camera, model: models.rifle })
    : null;

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
    best: getStoredRunnerBest(),
    deathCause: "",
  };

  const player = {
    x: 0,
    z: STREET_CENTER_Z,
    eyeY: 0,
    floorY: RUNNER.floorY,
    speed: RUNNER.startSpeed,
    streetCenterZ: STREET_CENTER_Z,
  };
  const playerBox = new THREE.Box3();

  const drones = createDroneManager({
    scene,
    model: models.drone ?? new THREE.Mesh(new THREE.OctahedronGeometry(0.5)),
    fx,
    projectiles,
    audio,
    maxAlive: performanceProfile.runnerMaxDrones ?? 8,
    onKill: (drone) => {
      game.kills += 1;
      game.combo = Math.min(COMBO_MAX, game.combo + COMBO_STEP);
      game.comboTimer = COMBO_DECAY_DELAY;
      game.bonus += Math.round(drone.type.score * game.combo);
      hud.hitMarker(true);
      controls.shake(0.02, 0.15);
    },
    onKamikazeHit: (damage) => {
      damagePlayer(damage, "KAMIKAZE IMPACT");
      controls.shake(0.12, 0.45);
    },
  });

  const obstacles = createObstacles({
    scene,
    barrierModel: models.barrier,
    carModel: world.car ?? null,
    poolSize: 6,
  });

  const pickups = createPickups({ scene });

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
        onHit: (kind) => {
          if (kind === "drone") {
            hud.hitMarker(false);
          } else if (kind === "bolt") {
            game.bonus += 10;
            hud.hitMarker(false);
          }
        },
      })
    : null;

  controls.on("jump", () => audio.play("jump", { volume: 0.35 }));
  controls.on("land", () => audio.play("land", { volume: 0.35 }));
  controls.on("slide", () => audio.play("slide", { volume: 0.3 }));
  controls.on("lockChange", (locked) => {
    if (!locked && game.state === "running" && !controls.isTouch()) {
      pause();
    } else if (locked && game.state === "paused") {
      resume();
    }
  });

  // ── State transitions ──────────────────────────────────────────────────
  function setState(next) {
    game.state = next;
    game.stateTime = 0;
  }

  function resetRun() {
    controls.reset();
    weapon?.reset();
    drones.clear();
    projectiles.clear();
    obstacles.clear();
    pickups.clear();
    fx.clear();
    game.distance = 0;
    game.bonus = 0;
    game.score = 0;
    game.kills = 0;
    game.combo = 1;
    game.comboTimer = 0;
    game.health = RUNNER.maxHealth;
    game.shield = RUNNER.maxShield;
    game.sinceDamage = 99;
    game.nextObstacleX = controls.state.x + FIRST_OBSTACLE_DISTANCE;
    game.droneTimer = FIRST_DRONE_TIME;
    game.nextSector = SECTOR_LENGTH;
    track?.followGround(controls.state.x);
  }

  function enterMenu() {
    resetRun();
    controls.setActive(true);
    controls.setInputEnabled(false);
    hud.setVisible(false);
    hud.showScreen("start", { best: game.best });
    setState("menu");
  }

  function startCountdown() {
    audio.ensureContext();
    controls.requestPointerLock();
    hud.hideScreen();
    hud.setVisible(true);
    game.countdown = 3;
    hud.showScreen("countdown", { text: "3" });
    audio.play("countdown");
    setState("countdown");
  }

  function beginRun() {
    hud.hideScreen();
    hud.showBanner("RUN", 1.1);
    audio.play("go");
    controls.setInputEnabled(true);
    setState("running");
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
    if (!controls.isPointerLocked() && !controls.isTouch()) {
      controls.requestPointerLock();
      return;
    }
    hud.hideScreen();
    controls.setInputEnabled(true);
    setState("running");
  }

  function die(cause) {
    if (game.state !== "running") {
      return;
    }
    game.deathCause = cause;
    controls.setInputEnabled(false);
    controls.shake(0.18, 0.6);
    hud.flashDamage(1);
    audio.play("crash", { volume: 0.6 });
    setState("dying");
  }

  function showGameOver() {
    const newBest = game.score > game.best;
    if (newBest) {
      game.best = game.score;
      setStoredRunnerBest(game.best);
    }
    controls.exitPointerLock();
    hud.showScreen("gameover", {
      score: game.score,
      distance: game.distance,
      kills: game.kills,
      best: game.best,
      newBest,
      cause: game.deathCause,
    });
    setState("dead");
  }

  function restart() {
    resetRun();
    startCountdown();
  }

  hud.onStart(startCountdown);
  hud.onRestart(restart);
  hud.onResume(resume);

  document.addEventListener("keydown", (event) => {
    if (event.code !== "Enter" && event.code !== "NumpadEnter") {
      return;
    }
    if (game.state === "dead") {
      restart();
    } else if (game.state === "menu") {
      startCountdown();
    }
  });

  // ── Combat ─────────────────────────────────────────────────────────────
  function damagePlayer(amount, cause = "SHOT DOWN") {
    if (game.state !== "running") {
      return;
    }
    const absorbed = Math.min(game.shield, amount);
    game.shield -= absorbed;
    game.health -= amount - absorbed;
    game.sinceDamage = 0;
    game.combo = 1;
    hud.flashDamage(absorbed === amount ? 0.35 : 0.8);
    controls.shake(0.05, 0.25);
    audio.play("damage", { volume: 0.5 });
    if (game.health <= 0) {
      game.health = 0;
      die(cause);
    }
  }

  // ── Spawning ───────────────────────────────────────────────────────────
  function difficulty() {
    return THREE.MathUtils.clamp(game.distance / RUNNER.difficultyDistance, 0, 1);
  }

  function spawnObstacleRow(x) {
    const d = difficulty();
    const lanes = [0, 1, 2].sort(() => Math.random() - 0.5);
    let count = 1;
    if (Math.random() < 0.2 + d * 0.5) {
      count = 2;
    }
    if (d > 0.45 && Math.random() < 0.2 + (d - 0.45) * 0.4) {
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
      kinds.push(pickWeighted(options));
    }
    // Never wall off every lane with cars: keep one jump / slide answer.
    if (count === 3 && kinds.every((kind) => kind === "car")) {
      kinds[Math.floor(Math.random() * 3)] = hasBarrier ? "barrier" : "beam";
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

    // Reward line: shards through a free lane, or arcing over a barrier.
    const freeLanes = [0, 1, 2].filter((lane) => !blocked.has(lane));
    const special = Math.random() < 0.09 + d * 0.04;
    if (special) {
      const lane = freeLanes.length ? freeLanes[Math.floor(Math.random() * freeLanes.length)] : lanes[0];
      const id = pickWeighted([
        { value: "shield", weight: 1.2 },
        { value: "health", weight: game.health < RUNNER.maxHealth * 0.6 ? 1.5 : 0.4 },
        { value: "overclock", weight: 1 },
      ]);
      pickups.spawn(id, x - 8, lane, 1.1);
    } else if (freeLanes.length > 0) {
      const lane = freeLanes[Math.floor(Math.random() * freeLanes.length)];
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

  function updateObstacleSpawner() {
    const d = difficulty();
    while (game.nextObstacleX < controls.state.x + OBSTACLE_LOOKAHEAD) {
      spawnObstacleRow(game.nextObstacleX);
      const gap = THREE.MathUtils.lerp(34, 19, d) * rand(0.9, 1.3);
      game.nextObstacleX += gap;
    }
  }

  function updateDroneSpawner(delta) {
    const d = difficulty();
    game.droneTimer -= delta;
    const cap = Math.min(performanceProfile.runnerMaxDrones ?? 8, 2 + Math.floor(d * 6));
    if (game.droneTimer > 0 || drones.countAlive() >= cap) {
      return;
    }
    const options = Object.values(DRONE_TYPES)
      .filter((type) => game.distance >= type.unlockDistance)
      .map((type) => ({
        value: type.id,
        weight: type.id === "scout" ? 3 : type.id === "gunship" ? 0.8 + d : 1 + d,
      }));
    const typeId = pickWeighted(options);
    drones.spawn(typeId, player);
    game.droneTimer = THREE.MathUtils.lerp(5.5, 1.6, d) * rand(0.7, 1.3);
  }

  function spawnSectorWave() {
    const sector = Math.round(game.distance / SECTOR_LENGTH) + 1;
    hud.showBanner(`SECTOR ${sector}`, 1.8);
    const waveSize = Math.min(3, 1 + Math.floor(difficulty() * 3));
    for (let i = 0; i < waveSize; i++) {
      drones.spawn(i === 0 && game.distance > DRONE_TYPES.gunship.unlockDistance ? "gunship" : "scout", player);
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
    game.nextObstacleX += shift;
  }

  const _ndc = new THREE.Vector3();
  const threats = [];

  function collectThreats() {
    threats.length = 0;
    let nearest = Infinity;
    drones.forEachThreat((drone) => {
      const distance = drone.position.distanceTo(camera.position);
      nearest = Math.min(nearest, distance);
      _ndc.copy(drone.position).project(camera);
      const behind = _ndc.z > 1;
      const onScreen = !behind && Math.abs(_ndc.x) < 0.92 && Math.abs(_ndc.y) < 0.88;
      if (onScreen || threats.length >= 8) {
        return;
      }
      let x = _ndc.x;
      let y = -_ndc.y;
      if (behind) {
        x = -x;
        y = -y;
      }
      threats.push({
        angle: Math.atan2(y, x),
        urgent: drone.state === "dive" || drone.charge > 0 || drone.burstLeft > 0,
      });
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
      maxShield: RUNNER.maxShield,
      ammo: weapon?.state.ammo ?? 0,
      magSize: weapon?.state.magSize ?? 0,
      reloading: weapon?.state.reloading ?? false,
      reload: weapon?.getReloadProgress() ?? 0,
      overclock: weapon?.state.overclock ?? 0,
      spread: weapon?.state.spread ?? 0,
      threats: collectThreats(),
    };
  }

  function simulateWorld(delta, { running }) {
    syncPlayer();

    if (running) {
      updateObstacleSpawner();
      updateDroneSpawner(delta);
      if (game.distance >= game.nextSector) {
        spawnSectorWave();
        game.nextSector += SECTOR_LENGTH;
      }
    }

    drones.update(delta, player, { allowFire: running });
    projectiles.update(delta, {
      playerBox,
      floorY: RUNNER.floorY,
      playerX: player.x,
      onHitPlayer: (damage) => damagePlayer(damage, "SHOT DOWN"),
    });

    if (running) {
      const hit = obstacles.update(playerBox, player.x);
      if (hit) {
        die(hit.kind === "car" ? "HIT A PARKED CAR" : hit.kind === "beam" ? "CLOTHESLINED" : "TRIPPED A BARRIER");
      }
      pickups.update(delta, playerBox, player.x, (pickup) => {
        audio.play("pickup", { volume: 0.4 });
        if (pickup.id === "shard") {
          game.bonus += Math.round(pickup.type.score * game.combo);
        } else if (pickup.id === "shield") {
          game.shield = RUNNER.maxShield;
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

    weapon?.update(delta, { canFire: running });
    viewmodel?.update(delta, controls.state);
    fx.update(delta);
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
        const d = difficulty();
        const eased = 1 - Math.pow(1 - d, 1.6);
        controls.setSpeed(THREE.MathUtils.lerp(RUNNER.startSpeed, RUNNER.maxSpeed, eased));
        controls.update(delta);
        applyWrap();
        track?.followGround(controls.state.x);
        game.distance += controls.state.speed * delta;

        game.sinceDamage += delta;
        if (game.sinceDamage > RUNNER.shieldRechargeDelay) {
          game.shield = Math.min(RUNNER.maxShield, game.shield + RUNNER.shieldRechargeRate * delta);
        }
        if (game.comboTimer > 0) {
          game.comboTimer -= delta;
        } else if (game.combo > 1) {
          game.combo = Math.max(1, game.combo - delta * 0.5);
        }

        simulateWorld(delta, { running: true });
        game.score = Math.floor(game.distance) + game.bonus;
        break;
      }
      case "paused": {
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
      projectiles.setWarmupVisible(true, _warmPos);
      obstacles.setWarmupVisible(true, _warmPos);
      pickups.setWarmupVisible(true, _warmPos);
      viewmodel?.setWarmupVisible(true);
    },
    end() {
      fx.setWarmupVisible(false);
      drones.setWarmupVisible(false);
      projectiles.setWarmupVisible(false);
      obstacles.setWarmupVisible(false);
      pickups.setWarmupVisible(false);
      viewmodel?.setWarmupVisible(false);
    },
  };

  /** Dynamic runner objects never belong in the rain collision height map. */
  const collisionHideObjects = [
    drones.group,
    projectiles.group,
    pickups.group,
    ...fx.hideObjects,
    ...(viewmodel ? [viewmodel.rig] : []),
  ];

  return {
    controls,
    hud,
    weapon,
    drones,
    obstacles,
    pickups,
    fx,
    audio,
    game,
    warm,
    collisionHideObjects,
    update,
    enterMenu,
    placeAtStart,
    getState: () => game.state,
  };
}
