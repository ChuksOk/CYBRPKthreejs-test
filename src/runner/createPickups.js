import * as THREE from "three/webgpu";
import { color, float, oscSine, time } from "three/tsl";
import { RUNNER } from "./runnerConfig.js";

export const PICKUP_TYPES = {
  shard: { hex: 0x22d3ee, score: 25, geometry: () => new THREE.OctahedronGeometry(0.22) },
  shield: { hex: 0xe040fb, geometry: () => new THREE.IcosahedronGeometry(0.34) },
  health: { hex: 0x3dff8a, geometry: () => new THREE.BoxGeometry(0.42, 0.42, 0.42) },
  overclock: { hex: 0xffe14a, geometry: () => new THREE.TorusGeometry(0.28, 0.08, 8, 20) },
};

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
    const geometry = type.geometry();
    const material = new THREE.MeshStandardNodeMaterial({
      color: 0x0a0a10,
      metalness: 0.2,
      roughness: 0.3,
    });
    material.emissiveNode = color(type.hex).mul(oscSine(time.mul(0.9)).mul(1.5).add(float(2.6)));
    for (let i = 0; i < (poolSize[id] ?? 2); i++) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.castShadow = false;
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

  return { group, spawn, update, shiftX, clear, setWarmupVisible };
}
