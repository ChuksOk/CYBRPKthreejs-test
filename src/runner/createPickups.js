import * as THREE from "three/webgpu";
import { color, float, oscSine, time } from "three/tsl";
import { RUNNER } from "./runnerConfig.js";
import { createPartKit } from "./models/modelKit.js";
import { chrome } from "./models/materials.js";

/** Palette follows the ticket HUD: acid / cobalt / paper / pink. */
export const PICKUP_TYPES = {
  shard: { hex: 0xd9ff3b, score: 25, core: () => new THREE.OctahedronGeometry(0.14), cage: 0.2 },
  shield: { hex: 0x5d87f6, core: () => new THREE.IcosahedronGeometry(0.2, 1), cage: 0.3 },
  health: { hex: 0xe9ebee, core: () => new THREE.BoxGeometry(0.2, 0.2, 0.2), cage: 0.3 },
  overclock: { hex: 0xff4f74, core: () => new THREE.TorusGeometry(0.14, 0.05, 10, 24), cage: 0.3 },
};

/** Glowing core inside a chrome gimbal cage (two crossed rings + cap nubs). */
function buildPickupTemplate(type) {
  const kit = createPartKit();
  kit.add("core", type.core());
  const r = type.cage;
  kit.torus("cage", r, 0.012, { rotation: [Math.PI / 2, 0, 0], tubular: 40 });
  kit.torus("cage", r, 0.012, { rotation: [0, 0, 0], tubular: 40 });
  for (const y of [-r, r]) {
    kit.tube("cage", 0.025, 0.03, "y", { position: [0, y, 0], radial: 12 });
  }
  return kit.build({
    core: (() => {
      const material = new THREE.MeshStandardNodeMaterial({ color: 0x050608, metalness: 0.4, roughness: 0.2 });
      material.emissiveNode = color(type.hex).mul(oscSine(time.mul(0.9)).mul(1.4).add(float(3)));
      return material;
    })(),
    cage: chrome({ tint: 0x9aa0a8 }),
  }, { name: "pickup" });
}

const COLLECT_RADIUS = 1.05;
const _center = new THREE.Vector3();

/**
 * Floating neon collectibles. Pulsing emissive is driven by the TSL timer so
 * nothing but position is touched per frame.
 */
export function createPickups({ scene, poolSize = { shard: 30, shield: 3, health: 3, overclock: 3 } }) {
  const group = new THREE.Group();
  group.name = "runner-pickups";
  scene.add(group);

  const pool = [];
  for (const [id, type] of Object.entries(PICKUP_TYPES)) {
    const template = buildPickupTemplate(type);
    for (let i = 0; i < (poolSize[id] ?? 2); i++) {
      const mesh = template.clone(true);
      mesh.visible = false;
      group.add(mesh);
      pool.push({ id, type, mesh, active: false, baseY: 0, phase: Math.random() * 6 });
    }
  }

  function spawn(id, x, lane, height = 1.0) {
    const pickup = pool.find((p) => !p.active && p.id === id);
    if (!pickup) {
      return null;
    }
    pickup.active = true;
    pickup.baseY = RUNNER.floorY + height;
    pickup.mesh.position.set(x, pickup.baseY, RUNNER.laneZ[lane]);
    pickup.mesh.visible = true;
    return pickup;
  }

  /**
   * Shard magnet: `reach` extra metres of pickup radius (Armory tier) and
   * `allLanes` pulls every shard within 16 m ahead toward the player.
   */
  const attract = { reach: 0, allLanes: false };
  function setMagnet(reach, allLanes) {
    attract.reach = reach;
    attract.allLanes = allLanes;
  }

  function update(delta, playerBox, playerX, onCollect) {
    playerBox.getCenter(_center);
    for (const pickup of pool) {
      if (!pickup.active) {
        continue;
      }
      pickup.phase += delta;
      pickup.mesh.rotation.y += delta * 2.4;
      pickup.mesh.rotation.x = Math.sin(pickup.phase * 1.3) * 0.4;
      pickup.mesh.position.y = pickup.baseY + Math.sin(pickup.phase * 3) * 0.12;

      if (pickup.mesh.position.x < playerX - 8) {
        despawn(pickup);
        continue;
      }
      if (pickup.id === "shard" && (attract.reach > 0 || attract.allLanes)) {
        const ahead = pickup.mesh.position.x - _center.x;
        const side = Math.abs(pickup.mesh.position.z - _center.z);
        const range = attract.allLanes ? 16 : 1.5 + attract.reach * 2;
        const lateral = attract.allLanes ? 9 : 0.8 + attract.reach;
        if (ahead > -1 && ahead < range && side < lateral) {
          const pull = Math.min(1, delta * (attract.allLanes ? 7 : 5));
          pickup.mesh.position.z += (_center.z - pickup.mesh.position.z) * pull;
          pickup.baseY += (_center.y - pickup.baseY) * pull * 0.6;
          pickup.mesh.position.x += (_center.x - pickup.mesh.position.x) * pull * 0.5;
        }
      }
      const dx = pickup.mesh.position.x - _center.x;
      const dy = pickup.mesh.position.y - _center.y;
      const dz = pickup.mesh.position.z - _center.z;
      if (dx * dx + dy * dy * 0.5 + dz * dz < COLLECT_RADIUS * COLLECT_RADIUS) {
        despawn(pickup);
        onCollect?.(pickup);
      }
    }
  }

  function despawn(pickup) {
    pickup.active = false;
    pickup.mesh.visible = false;
  }

  function shiftX(dx) {
    for (const pickup of pool) {
      pickup.mesh.position.x += dx;
    }
  }

  function clear() {
    for (const pickup of pool) {
      despawn(pickup);
    }
  }

  function setWarmupVisible(visible, position) {
    const seen = new Set();
    for (const pickup of pool) {
      if (seen.has(pickup.id)) {
        continue;
      }
      seen.add(pickup.id);
      pickup.mesh.visible = visible;
      if (visible && position) {
        pickup.mesh.position.copy(position);
      }
    }
  }

  return { group, spawn, update, shiftX, clear, setWarmupVisible, setMagnet };
}
