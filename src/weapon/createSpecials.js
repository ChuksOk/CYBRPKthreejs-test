import * as THREE from "three/webgpu";
import { createPartKit } from "../runner/models/modelKit.js";
import { cerakote, chrome, emissive, glass, gunmetal } from "../runner/models/materials.js";
import { NEON_GREEN } from "../runner/models/createGunModels.js";

/**
 * Special attacks, charged by landing shots. One type is chosen per run on
 * the start ticket:
 *  - "ally":   throw a small spherical drone that deploys beside the runner
 *              and shoots the nearest enemy until it is destroyed.
 *  - "seeker": throw a heat-seeking grenade that homes on the nearest drone
 *              and detonates (splash damage).
 */
export const SPECIALS = {
  ally: { id: "ally", name: "ALLY DRONE", short: "ALLY" },
  seeker: { id: "seeker", name: "SEEKER", short: "SEEK" },
};

const CHARGE_PER_DAMAGE = 0.035;
const CHARGE_PER_KILL = 0.05;

const ALLY_HP = 8;
const ALLY_LIFETIME = 45;
const ALLY_FIRE_INTERVAL = 0.42;
const ALLY_DAMAGE = 0.8;
const ALLY_RANGE = 48;
const ALLY_RADIUS = 0.45;

const SEEKER_SPEED = 30;
const SEEKER_TURN = 7;
const SEEKER_LIFETIME = 4;
const SEEKER_BLAST_RADIUS = 6.5;
const SEEKER_DAMAGE = 14;

const _tmp = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _desired = new THREE.Vector3();

function buildAllyModel() {
  const kit = createPartKit();
  kit.sphere("shell", 0.2, { width: 28, height: 20 });
  kit.torus("neon", 0.205, 0.012, { rotation: [Math.PI / 2, 0, 0], tubular: 40 });
  kit.torus("metal", 0.26, 0.022, { rotation: [Math.PI / 2, 0, 0], tubular: 40 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    kit.box("metal", [0.12, 0.03, 0.04], { position: [Math.cos(a) * 0.3, 0, Math.sin(a) * 0.3], rotation: [0, -a, 0], radius: 0.01 });
    kit.tube("chrome", 0.035, 0.03, "y", { position: [Math.cos(a) * 0.36, 0.01, Math.sin(a) * 0.36] });
  }
  kit.tube("glass", 0.07, 0.03, "z", { position: [0, 0, 0.18], radial: 24 });
  kit.torus("neon", 0.06, 0.008, { position: [0, 0, 0.197], tubular: 24 });
  kit.tube("metal", 0.012, 0.16, "z", { position: [0, -0.12, 0.14] });
  return kit.build({
    shell: cerakote({ tint: 0xe4e1d8, roughness: 0.4 }),
    metal: gunmetal({ tint: 0x2a2d32 }),
    chrome: chrome(),
    glass: glass({ tint: 0x061008 }),
    neon: emissive(NEON_GREEN, 4),
  }, { name: "ally-drone" });
}

function buildSeekerModel() {
  const kit = createPartKit();
  kit.cylinder("shell", 0.07, 0.07, 0.22, { rotation: [Math.PI / 2, 0, 0], radial: 18 });
  kit.cylinder("shell", 0.0, 0.07, 0.1, { position: [0, 0, 0.16], rotation: [Math.PI / 2, 0, 0], radial: 18 });
  kit.torus("neon", 0.071, 0.01, { position: [0, 0, 0.02], tubular: 24 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    kit.box("metal", [0.012, 0.09, 0.07], { position: [Math.cos(a) * 0.08, Math.sin(a) * 0.08, -0.1], rotation: [0, 0, a], radius: 0.004 });
  }
  kit.sphere("neon", 0.03, { position: [0, 0, 0.21] });
  return kit.build({
    shell: cerakote({ tint: 0xe4e1d8, roughness: 0.45 }),
    metal: gunmetal({ tint: 0x2a2d32 }),
    neon: emissive(NEON_GREEN, 5),
  }, { name: "seeker" });
}

export function createSpecials({ scene, fx, drones, audio }) {
  const group = new THREE.Group();
  group.name = "runner-specials";
  scene.add(group);

  const state = {
    type: "ally",
    charge: 0,
    ready: false,
    locked: false,
  };

  // ── Ally drone ──────────────────────────────────────────────────────────
  const ally = {
    root: buildAllyModel(),
    active: false,
    phase: "idle", // throw | fight
    hp: ALLY_HP,
    life: 0,
    fireTimer: 0,
    t: 0,
    from: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    position: null,
    side: 1,
  };
  ally.position = ally.root.position;
  ally.root.visible = false;
  group.add(ally.root);

  // ── Seeker grenade ──────────────────────────────────────────────────────
  const seeker = {
    root: buildSeekerModel(),
    active: false,
    life: 0,
    target: null,
    velocity: new THREE.Vector3(),
    position: null,
  };
  seeker.position = seeker.root.position;
  seeker.root.visible = false;
  group.add(seeker.root);

  function nearestDrone(from, maxDistance = Infinity) {
    let best = null;
    let bestDistance = maxDistance;
    drones.forEachThreat((drone) => {
      const d = drone.position.distanceTo(from);
      if (d < bestDistance) {
        bestDistance = d;
        best = drone;
      }
    });
    return best;
  }

  function setType(type) {
    if (state.locked || !SPECIALS[type]) {
      return;
    }
    state.type = type;
  }

  function addCharge(damage, killed = false) {
    if (state.ready) {
      return;
    }
    state.charge = Math.min(1, state.charge + damage * CHARGE_PER_DAMAGE + (killed ? CHARGE_PER_KILL : 0));
    if (state.charge >= 1) {
      state.ready = true;
      audio?.play("pickup", { volume: 0.5 });
    }
  }

  /**
   * @param {THREE.Vector3} origin   throw origin (muzzle)
   * @param {THREE.Vector3} forward  aim direction
   * @param {object} player          { x, z, eyeY, speed }
   */
  function activate(origin, forward, player) {
    if (!state.ready) {
      return false;
    }
    if (state.type === "ally" && ally.active) {
      return false;
    }
    if (state.type === "seeker" && seeker.active) {
      return false;
    }
    state.ready = false;
    state.charge = 0;
    audio?.play("jump", { volume: 0.5, detune: 600 });

    if (state.type === "ally") {
      ally.active = true;
      ally.phase = "throw";
      ally.hp = ALLY_HP;
      ally.life = ALLY_LIFETIME;
      ally.fireTimer = 0.6;
      ally.side = Math.random() < 0.5 ? -1 : 1;
      ally.position.copy(origin);
      ally.velocity.copy(forward).multiplyScalar(9).add(_tmp.set(player.speed, 3.5, 0));
      ally.root.visible = true;
    } else {
      seeker.active = true;
      seeker.life = SEEKER_LIFETIME;
      seeker.target = nearestDrone(origin);
      seeker.position.copy(origin);
      seeker.velocity.copy(forward).multiplyScalar(14).add(_tmp.set(player.speed, 4, 0));
      seeker.root.visible = true;
    }
    return true;
  }

  function destroyAlly() {
    if (!ally.active) {
      return;
    }
    fx.explosion(ally.position, { radius: 1.2 });
    audio?.play("explosion", { volume: 0.45, detune: 400 });
    ally.active = false;
    ally.root.visible = false;
  }

  function detonateSeeker() {
    fx.explosion(seeker.position, { radius: 3.2, hex: 0x9bff7a });
    fx.emitSparks(seeker.position, 40, { hex: NEON_GREEN, speed: 14, life: 0.7, size: 0.08, gravity: 4 });
    audio?.play("explosion", { volume: 0.7, detune: -300 });
    const blast = seeker.position.clone();
    drones.forEachThreat((drone) => {
      const d = drone.position.distanceTo(blast);
      if (d <= SEEKER_BLAST_RADIUS + drone.type.radius) {
        // drones.damage() credits the kill (score / combo) through onKill.
        drones.damage(drone, SEEKER_DAMAGE * (1 - Math.min(0.6, d / (SEEKER_BLAST_RADIUS * 2))));
      }
    });
    seeker.active = false;
    seeker.root.visible = false;
    seeker.target = null;
  }

  function updateAlly(delta, player) {
    if (!ally.active) {
      return;
    }
    ally.life -= delta;
    if (ally.life <= 0 || ally.hp <= 0) {
      destroyAlly();
      return;
    }
    // Station: ahead and to one side of the runner, above head height.
    _desired.set(player.x + 4.5, player.eyeY + 1.3 + Math.sin(performance.now() * 0.003) * 0.15, player.z + ally.side * 2.2);
    if (ally.phase === "throw") {
      ally.velocity.y -= 9 * delta;
      ally.position.addScaledVector(ally.velocity, delta);
      if (ally.velocity.y < 0 && ally.position.y <= _desired.y + 0.3) {
        ally.phase = "fight";
        fx.emitSparks(ally.position, 14, { hex: NEON_GREEN, speed: 4, life: 0.4, size: 0.05, gravity: 0 });
      }
    } else {
      ally.position.lerp(_desired, 1 - Math.exp(-delta * 4));
      ally.position.x += player.speed * delta * 0.15;
    }
    ally.root.rotation.y += delta * 2.2;

    const target = nearestDrone(ally.position, ALLY_RANGE);
    if (target) {
      ally.root.lookAt(target.position);
    }
    if (ally.phase !== "fight") {
      return;
    }
    ally.fireTimer -= delta;
    if (target && ally.fireTimer <= 0) {
      ally.fireTimer = ALLY_FIRE_INTERVAL;
      _dir.copy(target.position).sub(ally.position).normalize();
      _tmp.copy(ally.position).addScaledVector(_dir, 0.25);
      fx.tracer(_tmp, target.position, NEON_GREEN);
      fx.impact(target.position, _dir.clone().negate(), { hex: NEON_GREEN, count: 4 });
      audio?.play("shot", { volume: 0.16, detune: 900 });
      drones.damage(target, ALLY_DAMAGE);
    }
  }

  function updateSeeker(delta) {
    if (!seeker.active) {
      return;
    }
    seeker.life -= delta;
    if (!seeker.target?.alive || seeker.target.state === "dying") {
      seeker.target = nearestDrone(seeker.position);
    }
    if (seeker.target) {
      _desired.copy(seeker.target.position).sub(seeker.position).normalize().multiplyScalar(SEEKER_SPEED);
      seeker.velocity.lerp(_desired, 1 - Math.exp(-delta * SEEKER_TURN));
    } else {
      seeker.velocity.y -= 4 * delta;
    }
    seeker.position.addScaledVector(seeker.velocity, delta);
    _tmp.copy(seeker.position).add(seeker.velocity);
    seeker.root.lookAt(_tmp);
    if (Math.random() < delta * 60) {
      fx.emitSparks(seeker.position, 1, { hex: NEON_GREEN, speed: 1, life: 0.35, size: 0.06, gravity: 0 });
    }
    const hit = seeker.target && seeker.position.distanceTo(seeker.target.position) < seeker.target.type.radius + 0.3;
    if (hit || seeker.life <= 0 || seeker.position.y < -5.3) {
      detonateSeeker();
    }
  }

  function update(delta, player) {
    updateAlly(delta, player);
    updateSeeker(delta);
  }

  /** For enemy targeting / bolt hits. */
  function getAllyTarget() {
    return ally.active && ally.phase === "fight" ? { position: ally.position, radius: ALLY_RADIUS } : null;
  }

  function damageAlly(amount) {
    if (!ally.active) {
      return;
    }
    ally.hp -= amount / 6;
    fx.emitSparks(ally.position, 6, { hex: 0xffffff, speed: 4, life: 0.3, size: 0.04 });
    if (ally.hp <= 0) {
      destroyAlly();
    }
  }

  function shiftX(dx) {
    ally.position.x += dx;
    seeker.position.x += dx;
  }

  function reset() {
    state.charge = 0;
    state.ready = false;
    ally.active = false;
    ally.root.visible = false;
    seeker.active = false;
    seeker.root.visible = false;
  }

  function setWarmupVisible(visible, position) {
    for (const item of [ally, seeker]) {
      item.root.visible = visible || item.active;
      if (visible && position) {
        item.position.copy(position);
      }
    }
  }

  return {
    state,
    group,
    setType,
    lock: (locked) => {
      state.locked = locked;
    },
    addCharge,
    activate,
    update,
    getAllyTarget,
    damageAlly,
    isAllyActive: () => ally.active,
    getAllyHp: () => (ally.active ? ally.hp / ALLY_HP : 0),
    shiftX,
    reset,
    setWarmupVisible,
  };
}
