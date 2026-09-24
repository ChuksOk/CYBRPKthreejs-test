import * as THREE from "three/webgpu";
import { color, uniform } from "three/tsl";

const MAX_LIFE = 4;
const HIT_RADIUS = 0.42;
const _box = new THREE.Box3();
const _closest = new THREE.Vector3();
const _look = new THREE.Vector3();
const _oc = new THREE.Vector3();

/**
 * Enemy plasma bolts. Velocity = player run velocity + aim vector, so in the
 * player's frame each bolt travels in a straight line toward where the player
 * was when it fired — dodgeable by switching lane, jumping or sliding.
 */
export function createEnemyProjectiles({ scene, fx, capacity = 40 }) {
  const group = new THREE.Group();
  group.name = "runner-enemy-bolts";
  scene.add(group);

  const geometry = new THREE.SphereGeometry(0.15, 10, 8);
  geometry.scale(1, 1, 3.2);
  const pool = [];

  for (let i = 0; i < capacity; i++) {
    const uColor = uniform(new THREE.Color(0xff2d55));
    const material = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
    material.emissiveNode = uColor.mul(7).add(color(0xffffff).mul(0.6));
    material.toneMapped = false;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    mesh.castShadow = false;
    group.add(mesh);
    pool.push({
      mesh,
      uColor,
      alive: false,
      life: 0,
      damage: 0,
      position: mesh.position,
      velocity: new THREE.Vector3(),
    });
  }
  let cursor = 0;

  function fire(from, target, { speed, damage, hex, carrierVelocity }) {
    let bolt = null;
    for (let i = 0; i < capacity; i++) {
      const candidate = pool[(cursor + i) % capacity];
      if (!candidate.alive) {
        bolt = candidate;
        cursor = (cursor + i + 1) % capacity;
        break;
      }
    }
    if (!bolt) {
      return null;
    }
    bolt.alive = true;
    bolt.life = MAX_LIFE;
    bolt.damage = damage;
    bolt.position.copy(from);
    bolt.velocity.copy(target).sub(from).normalize().multiplyScalar(speed);
    if (carrierVelocity) {
      bolt.velocity.add(carrierVelocity);
    }
    bolt.uColor.value.set(hex);
    bolt.mesh.visible = true;
    return bolt;
  }

  function destroy(bolt, byPlayer = false) {
    if (!bolt?.alive) {
      return;
    }
    bolt.alive = false;
    bolt.mesh.visible = false;
    fx.emitSparks(bolt.position, byPlayer ? 14 : 6, {
      hex: bolt.uColor.value.getHex(),
      speed: byPlayer ? 7 : 4,
      life: 0.4,
      size: 0.06,
    });
  }

  /**
   * @param {number} delta
   * @param {{ playerBox: THREE.Box3, floorY: number, onHitPlayer: Function }} ctx
   */
  function update(delta, { playerBox, floorY, playerX, onHitPlayer }) {
    _box.copy(playerBox).expandByScalar(0.18);
    for (const bolt of pool) {
      if (!bolt.alive) {
        continue;
      }
      bolt.life -= delta;
      bolt.position.addScaledVector(bolt.velocity, delta);
      _look.copy(bolt.position).add(bolt.velocity);
      bolt.mesh.lookAt(_look);

      if (_box.containsPoint(bolt.position) || _box.distanceToPoint(bolt.position) < 0.12) {
        destroy(bolt);
        onHitPlayer?.(bolt.damage, bolt.position);
        continue;
      }
      if (bolt.life <= 0 || bolt.position.y < floorY + 0.05 || bolt.position.x < playerX - 30) {
        destroy(bolt);
      }
    }
  }

  function raycast(origin, direction, maxDistance) {
    let best = null;
    let bestDistance = maxDistance;
    for (const bolt of pool) {
      if (!bolt.alive) {
        continue;
      }
      _oc.copy(bolt.position).sub(origin);
      const t = _oc.dot(direction);
      if (t < 0 || t > bestDistance) {
        continue;
      }
      _closest.copy(origin).addScaledVector(direction, t);
      if (_closest.distanceToSquared(bolt.position) <= HIT_RADIUS * HIT_RADIUS) {
        bestDistance = t;
        best = bolt;
      }
    }
    return best ? { bolt: best, distance: bestDistance } : null;
  }

  function shiftX(dx) {
    for (const bolt of pool) {
      bolt.position.x += dx;
    }
  }

  function clear() {
    for (const bolt of pool) {
      bolt.alive = false;
      bolt.mesh.visible = false;
    }
  }

  function setWarmupVisible(visible, position) {
    const bolt = pool[0];
    bolt.mesh.visible = visible;
    if (visible && position) {
      bolt.position.copy(position);
    }
  }

  return { group, fire, destroy, update, raycast, shiftX, clear, setWarmupVisible };
}
