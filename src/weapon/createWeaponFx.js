import * as THREE from "three/webgpu";
import {
  color,
  diffuseColor,
  float,
  mix,
  mx_noise_float,
  positionLocal,
  time,
  uniform,
  uv,
  vec2,
} from "three/tsl";
import { performanceProfile } from "../platform/performanceProfile.js";

const _matrix = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _color = new THREE.Color();

function emissiveBasic(hex, strength = 4, { additive = true } = {}) {
  const material = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
  material.emissiveNode = color(hex).mul(strength);
  material.transparent = true;
  material.depthWrite = false;
  if (additive) {
    material.blending = THREE.AdditiveBlending;
  }
  material.toneMapped = false;
  return material;
}

/**
 * CPU spark particles in one InstancedMesh (impacts, drone debris, embers).
 * Per-instance color feeds both diffuse and emissive so sparks bloom.
 */
function createSparks(scene, capacity) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicNodeMaterial({ color: 0xffffff });
  material.emissiveNode = diffuseColor.rgb.mul(3.5);
  material.toneMapped = false;

  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = "runner-sparks";
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.count = 0;
  for (let i = 0; i < capacity; i++) {
    mesh.setColorAt(i, _color.set(0xffffff));
  }
  scene.add(mesh);

  const particles = Array.from({ length: capacity }, () => ({
    life: 0,
    maxLife: 1,
    size: 0.05,
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    color: new THREE.Color(),
    gravity: 9,
  }));
  let cursor = 0;
  let alive = 0;

  function emit(origin, count, { hex = 0xffc36b, speed = 6, spread = 1, up = 1.5, life = 0.45, size = 0.05, gravity = 9, normal = null, baseVelocity = null } = {}) {
    for (let i = 0; i < count; i++) {
      const p = particles[cursor];
      cursor = (cursor + 1) % capacity;
      p.life = life * (0.6 + Math.random() * 0.6);
      p.maxLife = p.life;
      p.size = size * (0.6 + Math.random() * 0.8);
      p.gravity = gravity;
      p.position.copy(origin);
      p.velocity.set(
        (Math.random() - 0.5) * 2 * spread,
        Math.random() * up,
        (Math.random() - 0.5) * 2 * spread,
      );
      if (normal) {
        p.velocity.addScaledVector(normal, 0.8 + Math.random());
      }
      p.velocity.normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      if (baseVelocity) {
        p.velocity.add(baseVelocity);
      }
      p.color.set(hex).offsetHSL((Math.random() - 0.5) * 0.04, 0, (Math.random() - 0.5) * 0.15);
    }
  }

  function update(delta) {
    let index = 0;
    for (const p of particles) {
      if (p.life <= 0) {
        continue;
      }
      p.life -= delta;
      if (p.life <= 0) {
        continue;
      }
      p.velocity.y -= p.gravity * delta;
      p.position.addScaledVector(p.velocity, delta);
      const t = p.life / p.maxLife;
      const stretch = Math.min(4, 1 + p.velocity.length() * 0.05);
      _scale.set(p.size * t, p.size * t, p.size * t * stretch);
      _pos.copy(p.position).add(p.velocity);
      _matrix.lookAt(p.position, _pos, THREE.Object3D.DEFAULT_UP);
      _quat.setFromRotationMatrix(_matrix);
      _matrix.compose(p.position, _quat, _scale);
      mesh.setMatrixAt(index, _matrix);
      mesh.setColorAt(index, p.color);
      index++;
    }
    alive = index;
    mesh.count = index;
    if (index > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    }
  }

  function shiftX(dx) {
    for (const p of particles) {
      p.position.x += dx;
    }
  }

  function clear() {
    for (const p of particles) {
      p.life = 0;
    }
    mesh.count = 0;
  }

  return { mesh, emit, update, shiftX, clear, getAlive: () => alive };
}

function createTracers(scene, capacity) {
  const geometry = new THREE.BoxGeometry(0.018, 0.018, 1);
  geometry.translate(0, 0, 0.5);
  const tracers = [];
  const group = new THREE.Group();
  group.name = "runner-tracers";
  scene.add(group);

  for (let i = 0; i < capacity; i++) {
    const material = emissiveBasic(0x7df9ff, 6);
    const uOpacity = uniform(0);
    const uColor = uniform(new THREE.Color(0x7df9ff));
    material.emissiveNode = uColor.mul(6);
    material.opacityNode = uOpacity;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    group.add(mesh);
    tracers.push({ mesh, uOpacity, uColor, life: 0 });
  }
  let cursor = 0;

  function spawn(from, to, hex = 0x7df9ff) {
    const tracer = tracers[cursor];
    cursor = (cursor + 1) % capacity;
    tracer.life = 0.07;
    tracer.mesh.visible = true;
    tracer.mesh.position.copy(from);
    tracer.mesh.lookAt(to);
    tracer.mesh.scale.set(1, 1, Math.max(0.01, from.distanceTo(to)));
    tracer.uColor.value.set(hex);
    tracer.uOpacity.value = 1;
  }

  function update(delta) {
    for (const tracer of tracers) {
      if (tracer.life <= 0) {
        continue;
      }
      tracer.life -= delta;
      tracer.uOpacity.value = Math.max(0, tracer.life / 0.07);
      if (tracer.life <= 0) {
        tracer.mesh.visible = false;
      }
    }
  }

  function shiftX(dx) {
    for (const tracer of tracers) {
      tracer.mesh.position.x += dx;
    }
  }

  function clear() {
    for (const tracer of tracers) {
      tracer.life = 0;
      tracer.mesh.visible = false;
    }
  }

  return { group, spawn, update, shiftX, clear };
}

function createExplosions(scene, capacity) {
  const geometry = new THREE.SphereGeometry(1, 20, 14);
  const group = new THREE.Group();
  group.name = "runner-explosions";
  scene.add(group);

  const pool = [];
  for (let i = 0; i < capacity; i++) {
    const uHeat = uniform(1);
    const uSeed = uniform(Math.random() * 10);
    const noise = mx_noise_float(positionLocal.mul(2.6).add(vec2(time.mul(1.5), uSeed).xyx)).mul(0.5).add(0.5);
    const fire = mix(color(0xff3a00), color(0xffe08a), noise.mul(uHeat));
    const material = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
    material.emissiveNode = fire.mul(uHeat.mul(5));
    material.opacityNode = noise.mul(uHeat).add(uHeat.mul(0.35)).clamp(0, 1);
    material.transparent = true;
    material.depthWrite = false;
    material.blending = THREE.AdditiveBlending;
    material.toneMapped = false;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    mesh.castShadow = false;
    group.add(mesh);
    pool.push({ mesh, uHeat, life: 0, maxLife: 0.6, radius: 1, velocity: new THREE.Vector3() });
  }
  let cursor = 0;

  function spawn(position, { radius = 1.6, life = 0.55, velocity = null } = {}) {
    const explosion = pool[cursor];
    cursor = (cursor + 1) % capacity;
    explosion.life = life;
    explosion.maxLife = life;
    explosion.radius = radius;
    explosion.velocity.copy(velocity ?? _pos.set(0, 0, 0));
    explosion.mesh.position.copy(position);
    explosion.mesh.rotation.set(Math.random() * 6, Math.random() * 6, 0);
    explosion.mesh.visible = true;
    explosion.mesh.scale.setScalar(radius * 0.2);
  }

  function update(delta) {
    for (const explosion of pool) {
      if (explosion.life <= 0) {
        continue;
      }
      explosion.life -= delta;
      if (explosion.life <= 0) {
        explosion.mesh.visible = false;
        continue;
      }
      const t = 1 - explosion.life / explosion.maxLife;
      const grow = 1 - Math.pow(1 - t, 3);
      explosion.mesh.scale.setScalar(explosion.radius * (0.25 + grow * 0.9));
      explosion.mesh.position.addScaledVector(explosion.velocity, delta);
      explosion.velocity.multiplyScalar(Math.exp(-delta * 3));
      explosion.uHeat.value = Math.pow(1 - t, 1.4);
    }
  }

  function shiftX(dx) {
    for (const explosion of pool) {
      explosion.mesh.position.x += dx;
    }
  }

  function clear() {
    for (const explosion of pool) {
      explosion.life = 0;
      explosion.mesh.visible = false;
    }
  }

  return { group, spawn, update, shiftX, clear };
}

/**
 * Muzzle flash billboard parented to the viewmodel muzzle — procedural star
 * in TSL, no texture.
 */
export function createMuzzleFlash() {
  const uFlash = uniform(0);
  const uRotation = uniform(0);
  const centered = uv().sub(0.5);
  const angle = centered.y.atan(centered.x).add(uRotation);
  const radius = centered.length().mul(2);
  const spikes = angle.mul(5).sin().abs().pow(6).mul(0.55).add(0.25);
  const star = float(1).sub(radius.div(spikes)).clamp(0, 1).pow(1.4);
  const core = float(1).sub(radius.mul(3.2)).clamp(0, 1);
  const shape = star.add(core).clamp(0, 1);

  const material = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
  material.emissiveNode = mix(color(0x6ef3ff), color(0xffffff), core).mul(shape).mul(uFlash).mul(6);
  material.opacityNode = shape.mul(uFlash);
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.AdditiveBlending;
  material.toneMapped = false;
  material.side = THREE.DoubleSide;

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), material);
  mesh.name = "runner-muzzle-flash";
  mesh.frustumCulled = false;
  mesh.renderOrder = 20;
  let life = 0;

  return {
    mesh,
    trigger() {
      life = 0.05;
      uRotation.value = Math.random() * Math.PI;
      mesh.scale.setScalar(0.8 + Math.random() * 0.5);
    },
    update(delta) {
      life = Math.max(0, life - delta);
      uFlash.value = life > 0 ? 1 : 0;
      mesh.visible = life > 0;
    },
  };
}

/**
 * All transient combat effects. Everything is pooled and allocated up front
 * so warmup compiles every pipeline before the first shot.
 */
export function createWeaponFx({ scene }) {
  const sparks = createSparks(scene, performanceProfile.runnerSparkCount ?? 256);
  const tracers = createTracers(scene, performanceProfile.runnerTracerCount ?? 24);
  const explosions = createExplosions(scene, 8);

  const flashLight = performanceProfile.runnerWeaponLight
    ? new THREE.PointLight(0x7df9ff, 0, 7, 2)
    : null;
  const blastLight = performanceProfile.runnerWeaponLight
    ? new THREE.PointLight(0xff7a2a, 0, 16, 2)
    : null;
  let flashLightLife = 0;
  let blastLightLife = 0;
  if (flashLight) {
    flashLight.castShadow = false;
    scene.add(flashLight);
  }
  if (blastLight) {
    blastLight.castShadow = false;
    scene.add(blastLight);
  }

  function muzzleLight(position) {
    if (!flashLight) {
      return;
    }
    flashLight.position.copy(position);
    flashLightLife = 0.045;
  }

  function impact(point, normal, { hex = 0xffc36b, count = 8 } = {}) {
    sparks.emit(point, count, { hex, speed: 5, normal, life: 0.35, size: 0.045 });
  }

  function explosion(position, { radius = 1.8, velocity = null, hex = 0xff9a3c } = {}) {
    explosions.spawn(position, { radius, velocity });
    sparks.emit(position, 34, { hex, speed: 11, spread: 1, up: 1.2, life: 0.9, size: 0.08, gravity: 7, baseVelocity: velocity });
    sparks.emit(position, 12, { hex: 0xfff2c0, speed: 4, life: 0.5, size: 0.12, gravity: 2 });
    if (blastLight) {
      blastLight.position.copy(position);
      blastLightLife = 0.35;
    }
  }

  function update(delta) {
    sparks.update(delta);
    tracers.update(delta);
    explosions.update(delta);
    if (flashLight) {
      flashLightLife = Math.max(0, flashLightLife - delta);
      flashLight.intensity = flashLightLife > 0 ? 18 : 0;
    }
    if (blastLight) {
      blastLightLife = Math.max(0, blastLightLife - delta);
      blastLight.intensity = 140 * Math.pow(blastLightLife / 0.35, 2);
    }
  }

  function shiftX(dx) {
    sparks.shiftX(dx);
    tracers.shiftX(dx);
    explosions.shiftX(dx);
    if (flashLight) {
      flashLight.position.x += dx;
    }
    if (blastLight) {
      blastLight.position.x += dx;
    }
  }

  function clear() {
    sparks.clear();
    tracers.clear();
    explosions.clear();
    flashLightLife = 0;
    blastLightLife = 0;
  }

  /** Make every pooled effect visible once so compileAsync builds its pipeline. */
  function setWarmupVisible(visible, position) {
    for (const group of [tracers.group, explosions.group]) {
      for (const child of group.children) {
        child.visible = visible;
        if (visible && position) {
          child.position.copy(position);
        }
      }
    }
    sparks.mesh.count = visible ? 1 : 0;
    if (visible && position) {
      sparks.mesh.setMatrixAt(0, _matrix.makeTranslation(position.x, position.y, position.z));
      sparks.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  return {
    sparks,
    tracers,
    explosions,
    muzzleLight,
    impact,
    explosion,
    tracer: tracers.spawn,
    emitSparks: sparks.emit,
    update,
    shiftX,
    clear,
    setWarmupVisible,
    /** Objects to keep out of the rain height pass. */
    hideObjects: [sparks.mesh, tracers.group, explosions.group],
  };
}
