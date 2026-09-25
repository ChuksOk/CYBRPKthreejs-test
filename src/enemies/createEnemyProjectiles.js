import * as THREE from "three/webgpu";
import { float, mix, normalView, positionViewDirection, uniform, uv, vec3 } from "three/tsl";

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
const BOLT_LENGTH = 2.2;

/** Per-bolt color without per-bolt materials (read from mesh.userData.bolt). */
function boltColor() {
  return uniform(new THREE.Color(0xff2d55)).onObjectUpdate(({ object }) => object.userData.bolt?.color);
}

function additive(material) {
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.AdditiveBlending;
  material.toneMapped = false;
  return material;
}

/**
 * Laser bolt = white-hot core + colored glow sleeve, both tapering into a
 * tail behind the head (uv.y = 1 at the head), plus a bright head flare.
 */
function createBoltMaterials() {
  const fade = uv().y;
  const core = additive(new THREE.MeshBasicNodeMaterial({ color: 0x000000, side: THREE.DoubleSide }));
  core.emissiveNode = mix(boltColor().mul(5), vec3(1, 1, 1).mul(7), fade.pow(2));
  core.opacityNode = fade.pow(1.5);

  const facing = normalView.dot(positionViewDirection).abs();
  const glow = additive(new THREE.MeshBasicNodeMaterial({ color: 0x000000, side: THREE.DoubleSide }));
  glow.emissiveNode = boltColor().mul(3.2);
  glow.opacityNode = fade.pow(1.2).mul(facing.pow(2)).mul(0.75);

  const head = additive(new THREE.MeshBasicNodeMaterial({ color: 0x000000 }));
  head.emissiveNode = mix(boltColor().mul(4), vec3(1, 1, 1).mul(8), float(0.6));
  head.opacityNode = normalView.dot(positionViewDirection).abs().pow(1.5);
  return { core, glow, head };
}

function tailGeometry(radius, radial) {
  const geometry = new THREE.CylinderGeometry(radius, radius * 0.35, 1, radial, 1, true);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0, -0.5);
  return geometry;
}

/**
 * Enemy laser bolts. Velocity = player run velocity + aim vector, so in the
 * player's frame each bolt travels in a straight line toward where the player
 * was when it fired — dodgeable by switching lane, jumping or sliding.
 */
export function createEnemyProjectiles({ scene, fx, capacity = 40 }) {
  const group = new THREE.Group();
  group.name = "runner-enemy-bolts";
  scene.add(group);

  const materials = createBoltMaterials();
  const coreGeometry = tailGeometry(0.035, 8);
  const glowGeometry = tailGeometry(0.16, 12);
  const headGeometry = new THREE.SphereGeometry(0.11, 12, 8);
  const pool = [];

  for (let i = 0; i < capacity; i++) {
    const data = { color: new THREE.Color(0xff2d55) };
    const mesh = new THREE.Group();
    const glowMesh = new THREE.Mesh(glowGeometry, materials.glow);
    const coreMesh = new THREE.Mesh(coreGeometry, materials.core);
    const headMesh = new THREE.Mesh(headGeometry, materials.head);
    for (const part of [glowMesh, coreMesh, headMesh]) {
      part.userData.bolt = data;
      part.frustumCulled = false;
      part.castShadow = false;
      mesh.add(part);
    }
    glowMesh.renderOrder = 13;
    coreMesh.renderOrder = 14;
    headMesh.renderOrder = 15;
    mesh.visible = false;
    group.add(mesh);
    pool.push({
      mesh,
      tails: [glowMesh, coreMesh],
      data,
      uColor: { value: data.color },
      alive: false,
      life: 0,
      age: 0,
      damage: 0,
      position: mesh.position,
      velocity: new THREE.Vector3(),
      carrier: new THREE.Vector3(),
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
    bolt.carrier.set(0, 0, 0);
    if (carrierVelocity) {
      bolt.velocity.add(carrierVelocity);
      bolt.carrier.copy(carrierVelocity);
    }
    bolt.data.color.set(hex);
    bolt.age = 0;
    for (const tail of bolt.tails) {
      tail.scale.z = 0.01;
    }
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
      hex: bolt.data.color.getHex(),
      speed: byPlayer ? 7 : 4,
      life: 0.4,
      size: 0.06,
    });
  }

  /**
   * @param {number} delta
   * @param {{ playerBox: THREE.Box3, floorY: number, onHitPlayer: Function }} ctx
   */
  function update(delta, { playerBox, floorY, playerX, onHitPlayer, ally = null, onHitAlly }) {
    _box.copy(playerBox).expandByScalar(0.18);
    for (const bolt of pool) {
      if (!bolt.alive) {
        continue;
      }
      bolt.life -= delta;
      bolt.position.addScaledVector(bolt.velocity, delta);
      // Tail grows out of the muzzle, then stretches with speed relative to the player.
      bolt.age += delta;
      const tailLength = Math.min(BOLT_LENGTH, bolt.age * 14);
      for (const tail of bolt.tails) {
        tail.scale.z = tailLength;
      }
      _look.copy(bolt.position).add(bolt.velocity).sub(bolt.carrier);
      bolt.mesh.lookAt(_look);

      if (ally && bolt.position.distanceTo(ally.position) < ally.radius + 0.15) {
        destroy(bolt);
        onHitAlly?.(bolt.damage);
        continue;
      }
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
