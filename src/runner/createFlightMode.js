import * as THREE from "three/webgpu";
import { RUNNER } from "./runnerConfig.js";
import { createFlyingCarModel } from "./models/createFlyingCarModel.js";
import { createPartKit } from "./models/modelKit.js";
import { emissive, gunFinish, gunmetal, paint } from "./models/materials.js";
import { rr, rrPick, rrRange } from "./rng.js";

/**
 * Sky Run: the flying-car power-up turns the runner into a Star Fox-style
 * rail shooter through the street canyon.
 *
 * - The car (createFlyingCarModel) follows controls.state (lanes × altitude
 *   tiers), banks into lane changes and pitches with climbs.
 * - Hull points replace the runner's shield / health while flying; when the
 *   hull hits zero the car explodes, tumbles away as a wreck and the runner
 *   drops back to the street (createRunnerGame handles the hand-off).
 * - Sky hazards: neon billboards spanning an altitude tier (change height),
 *   antenna pylons spanning a lane (change lane) and lane-gates leaving one
 *   open cell. Shard lines are threaded through the air lanes.
 * - Tracers leave from the car's twin cannons (alternating).
 */

const HAZARD_POOL = 14;
const HAZARD_DAMAGE = { sign: 34, pylon: 30, gate: 38 };

let hazardMaterials = null;
function getHazardMaterials() {
  if (!hazardMaterials) {
    hazardMaterials = {
      frame: gunFinish({ tint: 0x2a2d33, roughness: 0.55, metalness: 0.5, wear: 0.6 }),
      panel: paint({ tint: 0x16131e, roughness: 0.4, wear: 0.3 }),
      metal: gunmetal({ tint: 0x33363c }),
      pink: emissive(0xff2f8a, 3.2),
      cyan: emissive(0x2ff0ff, 3),
      warn: emissive(0xffb300, 3.4, { blink: { rate: 1.6, duty: 0.5 } }),
    };
  }
  return hazardMaterials;
}

/** Billboard spanning every lane at one altitude (tier height ±1.4 m). */
function buildSign() {
  const kit = createPartKit();
  const width = 22;
  kit.box("frame", [0.5, 2.8, width], { radius: 0.08 });
  kit.box("panel", [0.56, 2.3, width - 0.8], { radius: 0.05 });
  // Neon border + stripes.
  for (const y of [-1.18, 1.18]) {
    kit.box("pink", [0.6, 0.08, width - 0.6], { position: [0, y, 0], radius: 0.02, segments: 1 });
  }
  for (let i = 0; i < 7; i++) {
    kit.box(i % 2 ? "cyan" : "pink", [0.6, 1.2, 0.25], { position: [0, 0, -width / 2 + 2 + i * 3], radius: 0.03, segments: 1 });
  }
  // Support cables up out of shot.
  for (const z of [-width / 2 + 1, width / 2 - 1]) {
    kit.box("metal", [0.08, 12, 0.08], { position: [0, 7.4, z], radius: 0.02, segments: 1 });
  }
  return { mesh: kit.build(getHazardMaterials(), { name: "sky-sign" }), half: new THREE.Vector3(0.3, 1.4, width / 2) };
}

/** Antenna pylon spanning every altitude in one lane. */
function buildPylon() {
  const kit = createPartKit();
  const height = 18;
  kit.box("frame", [0.8, height, 1.6], { position: [0, height / 2 - 1, 0], radius: 0.08 });
  for (let i = 0; i < 6; i++) {
    kit.box("metal", [0.9, 0.12, 1.9], { position: [0, i * 3, 0], radius: 0.03 });
    kit.box("warn", [0.92, 0.2, 0.2], { position: [0, i * 3 + 1.5, 0.8], radius: 0.04, segments: 1 });
  }
  kit.box("cyan", [0.84, height - 2, 0.06], { position: [0, height / 2 - 1, -0.82], radius: 0.02, segments: 1 });
  return { mesh: kit.build(getHazardMaterials(), { name: "sky-pylon" }), half: new THREE.Vector3(0.45, height / 2, 1) };
}

export function createFlightMode({ scene, fx, pickups, carModel = null }) {
  const group = new THREE.Group();
  group.name = "sky-run";
  scene.add(group);

  const car = createFlyingCarModel({ carModel });
  car.root.visible = false;
  group.add(car.root);

  // ── Hazard pool ─────────────────────────────────────────────────────────
  const hazards = [];
  for (let i = 0; i < HAZARD_POOL; i++) {
    const kind = i % 2 === 0 ? "sign" : "pylon";
    const built = kind === "sign" ? buildSign() : buildPylon();
    built.mesh.visible = false;
    group.add(built.mesh);
    hazards.push({ kind, mesh: built.mesh, half: built.half, active: false, hit: false, box: new THREE.Box3(), damageKind: kind });
  }

  const state = {
    active: false,
    hull: RUNNER.flightHull,
    maxHull: RUNNER.flightHull,
    time: 0,
    nextHazardX: 0,
    wreck: null,
    muzzleIndex: 0,
  };
  const _pos = new THREE.Vector3();
  // Smoothed car attitude (radians) so the visual never snaps.
  const attitude = { bank: 0, heading: 0, pitch: 0 };

  function hazardY(tier) {
    return RUNNER.floorY + RUNNER.flightAltitudes[tier];
  }

  /** Pylons (18 m tall) span every flight tier: base 4 m under the lowest. */
  function pylonBase() {
    return hazardY(0) - 4;
  }

  function takeHazard(kind) {
    return hazards.find((h) => !h.active && h.kind === kind) ?? null;
  }

  function placeHazard(hazard, x, y, z, damageKind = hazard.kind) {
    hazard.active = true;
    hazard.hit = false;
    hazard.damageKind = damageKind;
    hazard.mesh.visible = true;
    hazard.mesh.position.set(x, y, z);
    hazard.mesh.updateMatrixWorld(true);
    // Pylon geometry is built from its base; its box is centred on height/2 - 1.
    const cy = hazard.kind === "pylon" ? y + hazard.half.y - 1 : y;
    hazard.box.min.set(x - hazard.half.x, cy - hazard.half.y, z - hazard.half.z);
    hazard.box.max.set(x + hazard.half.x, cy + hazard.half.y, z + hazard.half.z);
  }

  /** Shards threaded through a cell (or a climbing arc between tiers). */
  function spawnShardLine(x, lane, tierFrom, tierTo = tierFrom) {
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      const y = THREE.MathUtils.lerp(hazardY(tierFrom), hazardY(tierTo), THREE.MathUtils.smoothstep(t, 0, 1));
      pickups.spawnAt("shard", x + i * 3, y, RUNNER.flightLaneZ[lane]);
    }
  }

  /** One hazard pattern around x; difficulty 0..1 grows with flight time. */
  function spawnPattern(x, difficulty) {
    const lanes = [0, 1, 2];
    const tiers = [0, 1, 2];
    const roll = rr();
    const gateChance = 0.15 + difficulty * 0.3;
    if (roll < gateChance) {
      // Gate: two signs + one pylon leave a single open cell.
      const openTier = rrPick(tiers);
      const openLane = rrPick(lanes);
      for (const tier of tiers) {
        if (tier !== openTier) {
          const sign = takeHazard("sign");
          if (sign) placeHazard(sign, x, hazardY(tier), RUNNER.flightLaneZ[1], "gate");
        }
      }
      for (const lane of lanes) {
        if (lane !== openLane && rr() < 0.5 + difficulty * 0.4) {
          const pylon = takeHazard("pylon");
          if (pylon) placeHazard(pylon, x + 1.5, pylonBase(), RUNNER.flightLaneZ[lane], "gate");
          break;
        }
      }
      spawnShardLine(x - 14, openLane, openTier);
    } else if (roll < gateChance + 0.42) {
      // Billboard across one tier: fly over or under it.
      const tier = rrPick(tiers);
      const sign = takeHazard("sign");
      if (sign) placeHazard(sign, x, hazardY(tier), RUNNER.flightLaneZ[1]);
      const freeTier = tier === 1 ? rrPick([0, 2]) : 1;
      spawnShardLine(x - 12, rrPick(lanes), freeTier);
    } else {
      // Pylons: one or two lanes blocked.
      const blocked = rr() < 0.35 + difficulty * 0.4 ? 2 : 1;
      const order = [...lanes].sort(() => rr() - 0.5);
      for (let i = 0; i < blocked; i++) {
        const pylon = takeHazard("pylon");
        if (pylon) placeHazard(pylon, x + i * 0.2, pylonBase(), RUNNER.flightLaneZ[order[i]]);
      }
      const free = order[blocked];
      const from = rrPick(tiers);
      spawnShardLine(x - 12, free, from, rrPick(tiers));
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────
  /** @param {{ maxHull?: number }} [options]  hull after Armory upgrades */
  function enter(playerX, { maxHull = RUNNER.flightHull } = {}) {
    state.active = true;
    state.maxHull = maxHull;
    state.hull = state.maxHull;
    state.time = 0;
    state.nextHazardX = playerX + 70;
    state.wreck = null;
    car.root.visible = true;
    car.root.rotation.set(0, 0, 0);
    attitude.bank = 0;
    attitude.heading = 0;
    attitude.pitch = 0;
  }

  /** Hull hit; returns true when the car is destroyed. */
  function damage(amount) {
    if (!state.active) {
      return false;
    }
    state.hull = Math.max(0, state.hull - amount);
    return state.hull <= 0;
  }

  function repair(amount) {
    state.hull = Math.min(state.maxHull, state.hull + amount);
  }

  /** Blow the car up and let the wreck tumble away. */
  function destroy(speed) {
    if (!state.active) {
      return;
    }
    state.active = false;
    car.root.getWorldPosition(_pos);
    fx.explosion(_pos, { radius: 3.2, velocity: new THREE.Vector3(speed * 0.6, 0, 0), hex: 0xff6a2a });
    state.wreck = {
      velocity: new THREE.Vector3(speed * 0.55, 3.5, (Math.random() - 0.5) * 4),
      spin: new THREE.Vector3(Math.random() * 3 + 2, Math.random() * 2, Math.random() * 4 + 3),
      time: 0,
    };
    clearHazards();
  }

  /** Graceful end (run reset / menu): no explosion. */
  function reset() {
    state.active = false;
    state.wreck = null;
    car.root.visible = false;
    clearHazards();
  }

  function clearHazards() {
    for (const hazard of hazards) {
      hazard.active = false;
      hazard.mesh.visible = false;
    }
  }

  /**
   * @param {number} delta
   * @param {object} controlsState  runner controls state
   * @param {THREE.Box3} carBox     current car hull box
   * @param {(hazard:object, damage:number) => void} onCrash
   * @param {number} difficulty     0..1 overall run difficulty
   */
  function update(delta, controlsState, carBox, onCrash, difficulty = 0) {
    const s = controlsState;

    if (state.wreck) {
      const w = state.wreck;
      w.time += delta;
      w.velocity.y -= 16 * delta;
      car.root.position.addScaledVector(w.velocity, delta);
      car.root.rotation.x += w.spin.x * delta;
      car.root.rotation.y += w.spin.y * delta;
      car.root.rotation.z += w.spin.z * delta;
      if (w.time > 0.25 && Math.random() < delta * 30) {
        fx.impact?.(car.root.position, new THREE.Vector3(0, 1, 0), { hex: 0xff8a3a, count: 3 });
      }
      if (car.root.position.y <= RUNNER.floorY + 0.4 || w.time > 2.5) {
        car.root.getWorldPosition(_pos);
        fx.explosion(_pos, { radius: 2, hex: 0xff4f1a });
        car.root.visible = false;
        state.wreck = null;
      }
      return;
    }
    if (!state.active) {
      return;
    }
    state.time += delta;

    // Car pose: follows the controls, banks with lateral speed, pitches with
    // climbs, noses slightly toward the aim.
    // Hover float: two detuned sines so it never looks like a loop.
    const bob = Math.sin(state.time * 2.3) * 0.06 + Math.sin(state.time * 3.7 + 1.3) * 0.025;
    // Lift-off: the car swoops in ahead of and below the runner while the
    // camera pulls back to the chase position (never inside the hull).
    const arrive = 1 - THREE.MathUtils.smootherstep(s.flightBlend, 0, 1);
    car.root.position.set(s.x + arrive * 9, s.flightY + bob - arrive * 2.4, s.z);

    // Attitude targets. +Z is screen-right: moving right dips the right
    // side (positive roll about the nose). Acceleration leads the bank so
    // the car leans in as the move starts and counter-leans as it settles.
    const speed = Math.max(4, s.speed);
    const bankTarget = THREE.MathUtils.clamp(s.flightVz * 0.055 + s.flightAz * 0.008, -0.7, 0.7);
    const headingTarget = -Math.atan2(s.flightVz, speed) * 1.1 + THREE.MathUtils.clamp(s.yaw * 0.18, -0.2, 0.2);
    const pitchTarget = THREE.MathUtils.clamp(Math.atan2(s.flightVy, speed) * 1.2 + s.flightAy * 0.004, -0.4, 0.4);
    const k = 1 - Math.exp(-delta * 11);
    attitude.bank += (bankTarget - attitude.bank) * k;
    attitude.heading += (headingTarget - attitude.heading) * k;
    attitude.pitch += (pitchTarget - attitude.pitch) * k;

    // Barrel roll: a full turn with ease-in-out, plus a little hop.
    let roll = 0;
    let hop = 0;
    if (s.rollTime > 0) {
      const t = 1 - s.rollTime / RUNNER.flightRollDuration;
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      roll = s.rollDir * eased * Math.PI * 2;
      hop = Math.sin(t * Math.PI) * 0.35;
    }
    car.root.position.y += hop;
    // Heading (Y) → pitch (Z, nose up) → bank (X, about the nose).
    car.root.rotation.set(attitude.bank + roll, attitude.heading, attitude.pitch, "YZX");
    car.root.visible = true;

    // Spawner: patterns ahead, faster as the flight goes on.
    const flightDifficulty = Math.min(1, difficulty * 0.6 + state.time / 60);
    while (state.nextHazardX < s.x + 120) {
      spawnPattern(state.nextHazardX, flightDifficulty);
      state.nextHazardX += THREE.MathUtils.lerp(38, 24, flightDifficulty) * rrRange(0.9, 1.25);
    }

    for (const hazard of hazards) {
      if (!hazard.active) {
        continue;
      }
      if (hazard.box.max.x < s.x - 12) {
        hazard.active = false;
        hazard.mesh.visible = false;
        continue;
      }
      if (!hazard.hit && hazard.box.intersectsBox(carBox)) {
        hazard.hit = true;
        onCrash?.(hazard, HAZARD_DAMAGE[hazard.damageKind] ?? 30);
      }
    }
  }

  /** Alternating cannon muzzles (weapon tracer origin while flying). */
  function getMuzzle(target) {
    state.muzzleIndex = (state.muzzleIndex + 1) % car.muzzles.length;
    car.root.updateMatrixWorld(true);
    return car.muzzles[state.muzzleIndex].getWorldPosition(target);
  }

  function getCarPosition(target) {
    return car.root.getWorldPosition(target);
  }

  function shiftX(dx) {
    car.root.position.x += dx;
    state.nextHazardX += dx;
    for (const hazard of hazards) {
      hazard.mesh.position.x += dx;
      hazard.box.min.x += dx;
      hazard.box.max.x += dx;
    }
  }

  function setWarmupVisible(visible, position) {
    car.root.visible = visible || state.active || Boolean(state.wreck);
    for (const kind of ["sign", "pylon"]) {
      const hazard = hazards.find((h) => h.kind === kind && !h.active);
      if (hazard) {
        hazard.mesh.visible = visible;
        if (visible && position) {
          hazard.mesh.position.copy(position);
        }
      }
    }
    if (visible && position && !state.active) {
      car.root.position.copy(position);
    }
  }

  return {
    group,
    state,
    enter,
    damage,
    repair,
    destroy,
    reset,
    update,
    getMuzzle,
    getCarPosition,
    shiftX,
    setWarmupVisible,
    isActive: () => state.active,
    getHullFraction: () => state.hull / state.maxHull,
  };
}
