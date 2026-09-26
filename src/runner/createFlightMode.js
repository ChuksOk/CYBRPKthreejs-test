import * as THREE from "three/webgpu";
import { RUNNER } from "./runnerConfig.js";
import { createFlyingCarModel } from "./models/createFlyingCarModel.js";
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
 * - The sky lanes are obstacle-free: drones are the only threat. Shard
 *   lines are threaded through the air lanes.
 * - Tracers leave from the car's twin cannons (alternating).
 */

export function createFlightMode({ scene, fx, pickups, carModel = null }) {
  const group = new THREE.Group();
  group.name = "sky-run";
  scene.add(group);

  const car = createFlyingCarModel({ carModel });
  car.root.visible = false;
  group.add(car.root);

  const state = {
    active: false,
    hull: RUNNER.flightHull,
    maxHull: RUNNER.flightHull,
    time: 0,
    nextShardX: 0,
    wreck: null,
    muzzleIndex: 0,
  };
  const _pos = new THREE.Vector3();
  // Smoothed car attitude (radians) so the visual never snaps.
  const attitude = { bank: 0, heading: 0, pitch: 0 };

  function tierY(tier) {
    return RUNNER.floorY + RUNNER.flightAltitudes[tier];
  }

  /** Shards threaded through a cell (or a climbing arc between tiers). */
  function spawnShardLine(x, lane, tierFrom, tierTo = tierFrom) {
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      const y = THREE.MathUtils.lerp(tierY(tierFrom), tierY(tierTo), THREE.MathUtils.smoothstep(t, 0, 1));
      pickups.spawnAt("shard", x + i * 3, y, RUNNER.flightLaneZ[lane]);
    }
  }

  /** Shard lines ahead: a straight run in one cell or a climbing arc. */
  function spawnShards(x) {
    const from = rrPick([0, 1, 2]);
    const to = rr() < 0.4 ? rrPick([0, 1, 2]) : from;
    spawnShardLine(x, rrPick([0, 1, 2]), from, to);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────
  /** @param {{ maxHull?: number }} [options]  hull after Armory upgrades */
  function enter(playerX, { maxHull = RUNNER.flightHull } = {}) {
    state.active = true;
    state.maxHull = maxHull;
    state.hull = state.maxHull;
    state.time = 0;
    state.nextShardX = playerX + 70;
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
  }

  /** Graceful end (run reset / menu): no explosion. */
  function reset() {
    state.active = false;
    state.wreck = null;
    car.root.visible = false;
  }

  /**
   * @param {number} delta
   * @param {object} controlsState  runner controls state
   */
  function update(delta, controlsState) {
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

    // Shard lines ahead.
    while (state.nextShardX < s.x + 120) {
      spawnShards(state.nextShardX);
      state.nextShardX += 30 * rrRange(0.9, 1.3);
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
    state.nextShardX += dx;
  }

  function setWarmupVisible(visible, position) {
    car.root.visible = visible || state.active || Boolean(state.wreck);
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
