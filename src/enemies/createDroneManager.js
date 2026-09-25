import * as THREE from "three/webgpu";
import { color, float, fract, step, time, uniform, uv } from "three/tsl";
import { createDroneModel } from "../runner/models/createDroneModel.js";
import { DRONE_TYPES } from "./droneTypes.js";

const _oc = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _target = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _carrier = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _look = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _aimPoint = new THREE.Vector3();

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function expLerpFactor(delta, speed) {
  return 1 - Math.exp(-delta * speed);
}

/**
 * Procedural airframe (src/runner/models/createDroneModel.js). All drones of
 * a type share materials; hit flash, sensor glow and accent color are read
 * per mesh from `userData.fx`, so there is one pipeline per material and no
 * per-drone shader compiles.
 */
function buildDroneVisual(type, variantIndex = 0) {
  const root = new THREE.Group();
  const body = createDroneModel(type.id, variantIndex);
  body.scale.setScalar(type.scale);
  root.add(body);

  const fx = { flash: 0, glow: 2.4, color: new THREE.Color(type.glow), rim: 1.6, aim: 0 };
  body.traverse((child) => {
    if (child.isMesh) {
      child.userData.fx = fx;
    }
  });

  // Keep the old uniform-style API used by the state machine below.
  const uGlow = {
    get value() {
      return fx.glow;
    },
    set value(v) {
      fx.glow = v;
    },
  };
  const uFlash = {
    get value() {
      return fx.flash;
    },
    set value(v) {
      fx.flash = v;
    },
  };
  return { root, uGlow, uFlash, fx };
}

/**
 * Warning laser drawn from a charging drone to where it will shoot: dashed
 * scanline marching toward the player, brightening as the charge completes.
 */
function createAimMaterial() {
  const material = new THREE.MeshBasicNodeMaterial({ color: 0x000000, side: THREE.DoubleSide });
  const aimColor = uniform(new THREE.Color(0xff2d55)).onObjectUpdate(({ object }) => object.userData.fx?.color);
  const aim = uniform(0).onObjectUpdate(({ object }) => object.userData.fx?.aim ?? 0);
  const length = uniform(10).onObjectUpdate(({ object }) => object.scale.z);
  const dash = step(0.45, fract(uv().y.mul(length).mul(1.6).sub(time.mul(7))));
  const flicker = float(0.85).add(fract(time.mul(37)).mul(0.15));
  material.emissiveNode = aimColor.mul(float(2).add(aim.mul(6))).add(color(0xffffff).mul(aim.pow(3).mul(2)));
  // Fade out well before the camera so the beam never becomes a bar on screen.
  const nearFade = float(1).sub(uv().y.smoothstep(0.5, 1));
  material.opacityNode = aim.mul(float(0.35).add(dash.mul(0.65))).mul(flicker).mul(nearFade);
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.AdditiveBlending;
  material.toneMapped = false;
  return material;
}

/**
 * Drone waves: spawn ahead, hold station relative to the runner while
 * strafing, fire bolts (scout / gunship) or dive (kamikaze). Hit tests are
 * analytic ray–sphere, never BVH.
 */
export function createDroneManager({
  scene,
  fx,
  projectiles,
  audio,
  maxAlive = 8,
  onKill,
  /** Optional decoy (player's ally drone) that enemies sometimes shoot at. */
  getDecoy = null,
  onKamikazeHit,
  /** Cosmetic explosion colour (Armory). */
  getBlastHex = () => 0xff9a3c,
}) {
  const group = new THREE.Group();
  group.name = "runner-drones";
  scene.add(group);

  const drones = [];
  let lastPlayer = null;
  const aimMaterial = createAimMaterial();
  const aimGeometry = new THREE.CylinderGeometry(0.012, 0.045, 1, 6, 1, true);
  aimGeometry.rotateX(Math.PI / 2);
  aimGeometry.translate(0, 0, 0.5);
  for (const type of Object.values(DRONE_TYPES)) {
    const count = type.boss ? 1 : type.id === "gunship" ? Math.ceil(maxAlive / 3) : maxAlive;
    for (let i = 0; i < count; i++) {
      const visual = buildDroneVisual(type, i);
      visual.root.visible = false;
      group.add(visual.root);
      const aimLine = new THREE.Mesh(aimGeometry, aimMaterial);
      aimLine.userData.fx = visual.fx;
      aimLine.visible = false;
      aimLine.frustumCulled = false;
      aimLine.renderOrder = 12;
      group.add(aimLine);
      drones.push({
        type,
        ...visual,
        alive: false,
        state: "idle",
        hp: 0,
        time: 0,
        position: visual.root.position,
        velocity: new THREE.Vector3(),
        ahead: 20,
        height: 4,
        lateralCenter: 22.5,
        phase: 0,
        fireTimer: 0,
        burstLeft: 0,
        burstTimer: 0,
        charge: 0,
        flash: 0,
        repositionTimer: 0,
        spin: new THREE.Vector3(),
        aimLine,
      });
    }
  }

  function countAlive(typeId = null) {
    let count = 0;
    for (const drone of drones) {
      if (drone.alive && drone.state !== "dying" && (!typeId || drone.type.id === typeId)) {
        count++;
      }
    }
    return count;
  }

  function pickStation(drone, player) {
    const type = drone.type;
    drone.ahead = rand(type.ahead[0], type.ahead[1]);
    drone.height = rand(type.height[0], type.height[1]);
    drone.lateralCenter = player.streetCenterZ + rand(-3, 3);
    drone.repositionTimer = rand(3.5, 6);
  }

  function spawn(typeId, player, { fromBehind = false, from = null, force = false } = {}) {
    if (!force && countAlive() >= maxAlive) {
      return null;
    }
    const drone = drones.find((d) => !d.alive && d.type.id === typeId);
    if (!drone) {
      return null;
    }
    const type = drone.type;
    drone.alive = true;
    drone.state = "enter";
    drone.hp = type.hp;
    drone.time = 0;
    drone.phase = Math.random() * Math.PI * 2;
    drone.fireTimer = rand(type.fireInterval[0], type.fireInterval[1]) * 0.5 + 0.3;
    drone.burstLeft = 0;
    drone.charge = 0;
    drone.flash = 0;
    pickStation(drone, player);
    drone.open = 0;
    drone.launchTimer = type.launchInterval ?? 0;
    if (from) {
      // Launched from a carrier.
      drone.position.copy(from);
    } else if (fromBehind) {
      // Ambush: swoop in from behind the runner.
      drone.position.set(player.x - rand(10, 16), player.floorY + drone.height + rand(1, 3), player.streetCenterZ + rand(-6, 6));
    } else {
      // Enter from far ahead and high, off to one side.
      drone.position.set(
        player.x + drone.ahead + rand(35, 55),
        player.floorY + drone.height + rand(6, 12),
        player.streetCenterZ + rand(-14, 14),
      );
    }
    drone.velocity.set(0, 0, 0);
    drone.root.visible = true;
    drone.root.rotation.set(0, 0, 0);
    drone.uGlow.value = 2.4;
    drone.uFlash.value = 0;
    audio?.play("droneSpawn", { volume: 0.25 });
    return drone;
  }

  function kill(drone, player, { byPlayer = true } = {}) {
    drone.state = "dying";
    drone.time = 0;
    hideAim(drone);
    drone.velocity.set(player.speed * 0.85, rand(1, 3), rand(-2, 2));
    drone.spin.set(rand(-6, 6), rand(-8, 8), rand(-6, 6));
    drone.uGlow.value = 0.6;
    fx.emitSparks(drone.position, 18, { hex: drone.type.glow, speed: 6, life: 0.6, size: 0.07 });
    // The boom plays the instant it is destroyed (mid-air burst); the wreck
    // hitting the street later only adds a smaller thud.
    fx.explosion(drone.position, { radius: 0.8 + drone.type.scale * 0.35, velocity: _carrier.set(player.speed * 0.8, 0, 0), hex: getBlastHex() });
    audio?.play("explosion", { volume: 1.15, detune: (Math.random() - 0.5) * 250 });
    if (byPlayer) {
      onKill?.(drone);
    }
  }

  function explode(drone, { wreck = false } = {}) {
    fx.explosion(drone.position, {
      radius: 1.3 + drone.type.scale * 0.5,
      velocity: _carrier.set(drone.velocity.x * 0.6, 0, 0),
      hex: getBlastHex(),
    });
    audio?.play("explosion", wreck
      ? { volume: 0.4, detune: -700 + Math.random() * 200 }
      : { volume: 1.15, detune: (Math.random() - 0.5) * 250 });
    recycle(drone);
  }

  function recycle(drone) {
    drone.alive = false;
    drone.state = "idle";
    drone.root.visible = false;
    hideAim(drone);
  }

  function damage(drone, amount) {
    if (!drone?.alive || drone.state === "dying") {
      return false;
    }
    // Boss armor: only 20% damage unless the weak point is open.
    const armored = drone.type.boss && !isOpen(drone);
    drone.hp -= armored ? amount * 0.2 : amount;
    drone.flash = armored ? 0.03 : 0.07;
    if (armored) {
      fx.emitSparks(drone.position, 2, { hex: 0xffffff, speed: 5, life: 0.2, size: 0.04 });
    }
    audio?.play("hit", { volume: 0.18, detune: (armored ? 800 : 0) + (Math.random() - 0.5) * 400 });
    if (drone.hp <= 0 && lastPlayer) {
      kill(drone, lastPlayer);
      return true;
    }
    return false;
  }

  function isOpen(drone) {
    return drone.open > 0 || drone.charge > 0 || drone.burstLeft > 0;
  }

  /** Muzzle point (out) slightly in front of the drone toward the aim point. */
  function computeMuzzle(drone, player, out, aim) {
    const decoy = drone.decoyShot ? getDecoy?.() : null;
    if (decoy) {
      aim.copy(decoy.position);
    } else {
      aim.set(player.x, player.eyeY - 0.35, player.z);
    }
    _dir.copy(aim).sub(drone.position).normalize();
    return out.copy(drone.position).addScaledVector(_dir, drone.type.radius * 0.7);
  }

  function hideAim(drone) {
    drone.fx.aim = 0;
    drone.aimLine.visible = false;
  }

  function updateAim(drone, player, strength) {
    computeMuzzle(drone, player, _muzzle, _aimPoint);
    drone.fx.aim = strength;
    drone.aimLine.visible = strength > 0.01;
    drone.aimLine.position.copy(_muzzle);
    drone.aimLine.lookAt(_aimPoint);
    drone.aimLine.scale.set(1, 1, Math.max(0.1, _muzzle.distanceTo(_aimPoint) * 0.8));
  }

  function fireBolt(drone, player) {
    _carrier.set(player.speed, 0, 0);
    computeMuzzle(drone, player, _target, _aim);
    fx.explosions.spawn(_target, { radius: 0.28 * drone.type.scale, life: 0.09 });
    fx.emitSparks(_target, 8, { hex: drone.type.glow, speed: 4, life: 0.25, size: 0.05, gravity: 0 });
    projectiles.fire(_target, _aim, {
      speed: drone.type.boltSpeed,
      damage: drone.type.boltDamage,
      hex: drone.type.glow,
      carrierVelocity: _carrier,
      source: `${drone.type.id.toUpperCase()} ${drone.type.burst > 1 ? "BURST" : "BOLT"}`,
    });
    audio?.play("droneShot", { volume: 0.3, detune: (Math.random() - 0.5) * 200 });
  }

  /**
   * @param {number} delta
   * @param {object} player  { x, z, eyeY, floorY, speed, streetCenterZ }
   * @param {{ allowFire: boolean }} options
   */
  function update(delta, player, { allowFire = true } = {}) {
    lastPlayer = player;
    for (const drone of drones) {
      if (!drone.alive) {
        continue;
      }
      const type = drone.type;
      drone.time += delta;

      if (drone.flash > 0) {
        drone.flash = Math.max(0, drone.flash - delta);
      }
      drone.uFlash.value = drone.flash > 0 ? 1.4 : 0;

      if (drone.state === "dying") {
        drone.velocity.y -= 16 * delta;
        drone.position.addScaledVector(drone.velocity, delta);
        drone.root.rotation.x += drone.spin.x * delta;
        drone.root.rotation.y += drone.spin.y * delta;
        drone.root.rotation.z += drone.spin.z * delta;
        if (Math.random() < delta * 30) {
          fx.emitSparks(drone.position, 1, { hex: 0xffb347, speed: 1.5, life: 0.5, size: 0.09, gravity: -1 });
        }
        if (drone.position.y <= player.floorY + 0.3 || drone.time > 1.8) {
          explode(drone, { wreck: true });
        }
        continue;
      }

      if (drone.state === "dive") {
        _target.set(player.x, player.eyeY - 0.2, player.z);
        _dir.copy(_target).sub(drone.position).normalize();
        const desired = _carrier.copy(_dir).multiplyScalar(type.diveSpeed);
        desired.x += player.speed;
        drone.velocity.lerp(desired, expLerpFactor(delta, 2.2));
        drone.position.addScaledVector(drone.velocity, delta);
        drone.uGlow.value = 4 + Math.sin(drone.time * 30) * 3;
        _look.copy(drone.position).add(drone.velocity);
        drone.root.lookAt(_look);

        if (drone.position.distanceTo(_target) < type.radius + 0.5) {
          onKamikazeHit?.(type.boltDamage, drone.position);
          explode(drone);
          continue;
        }
        if (drone.position.x < player.x - 4 || drone.position.y < player.floorY + 0.2) {
          explode(drone);
        }
        continue;
      }

      // enter / attack / leave: hold a station relative to the runner.
      drone.repositionTimer -= delta;
      if (drone.repositionTimer <= 0) {
        pickStation(drone, player);
      }

      if (drone.time > type.lifetime && drone.state !== "leave") {
        drone.state = "leave";
      }

      const strafe = Math.sin(drone.time * type.strafeSpeed + drone.phase) * type.lateral;
      const bob = Math.sin(drone.time * 2.3 + drone.phase) * 0.35;
      if (drone.state === "leave") {
        _target.set(player.x + drone.ahead + 60, player.floorY + drone.height + 18, drone.position.z);
      } else {
        _target.set(
          player.x + drone.ahead,
          player.floorY + drone.height + bob,
          drone.lateralCenter + strafe,
        );
      }

      const follow = drone.state === "enter" ? 1.8 : 3.2;
      const prevX = drone.position.x;
      const prevZ = drone.position.z;
      drone.position.lerp(_target, expLerpFactor(delta, follow));
      drone.velocity.set(
        delta > 0 ? (drone.position.x - prevX) / delta : 0,
        0,
        delta > 0 ? (drone.position.z - prevZ) / delta : 0,
      );

      if (drone.state === "enter" && drone.position.distanceTo(_target) < 4) {
        drone.state = "attack";
      }
      if (drone.state === "leave" && drone.position.y > player.floorY + drone.height + 14) {
        recycle(drone);
        continue;
      }

      // Face the player; bank into strafes.
      _look.set(player.x, player.eyeY, player.z);
      drone.root.lookAt(_look);
      drone.root.rotateZ(THREE.MathUtils.clamp(-(drone.velocity.z) * 0.03, -0.4, 0.4));

      if (drone.open > 0) {
        drone.open = Math.max(0, drone.open - delta);
      }
      // Carrier: periodically opens its bay and launches scouts.
      if (type.boss && drone.state === "attack" && allowFire) {
        drone.launchTimer -= delta;
        if (drone.launchTimer <= 0) {
          drone.launchTimer = type.launchInterval;
          drone.open = 2.2;
          for (let i = 0; i < 2; i++) {
            spawn("scout", player, { from: drone.position, force: true });
          }
          fx.emitSparks(drone.position, 20, { hex: type.glow, speed: 6, life: 0.6, size: 0.08 });
          audio?.play("droneSpawn", { volume: 0.5, detune: -500 });
        }
        drone.uGlow.value = drone.open > 0 ? 6 + Math.sin(drone.time * 20) * 3 : drone.uGlow.value;
      }

      if (drone.state !== "attack" || !allowFire) {
        drone.charge = 0;
        drone.uGlow.value = 2.4;
        hideAim(drone);
        continue;
      }

      if (drone.burstLeft > 0) {
        updateAim(drone, player, 1);
        drone.burstTimer -= delta;
        if (drone.burstTimer <= 0) {
          fireBolt(drone, player);
          drone.burstLeft -= 1;
          drone.burstTimer = type.burstGap;
        }
        continue;
      }

      drone.fireTimer -= delta;
      if (drone.fireTimer <= type.chargeTime) {
        // Telegraph: glow ramps up before firing / diving.
        const t = 1 - Math.max(0, drone.fireTimer) / type.chargeTime;
        drone.charge = t;
        drone.uGlow.value = 2.4 + t * 7;
        updateAim(drone, player, 0.15 + t * 0.85);
      } else {
        drone.charge = 0;
        drone.uGlow.value = 2.4;
        hideAim(drone);
      }
      if (drone.fireTimer <= 0) {
        if (type.id === "kamikaze") {
          drone.state = "dive";
          drone.velocity.set(player.speed, 0, 0);
          audio?.play("dive", { volume: 0.4 });
        } else {
          drone.burstLeft = type.burst;
          drone.burstTimer = 0;
        }
        // Next volley may go at the player's ally drone instead.
        drone.decoyShot = Boolean(getDecoy?.()) && Math.random() < 0.4;
        drone.fireTimer = rand(type.fireInterval[0], type.fireInterval[1]);
      }
    }
  }

  function raycast(origin, direction, maxDistance, exclude = null) {
    let best = null;
    let bestDistance = maxDistance;
    for (const drone of drones) {
      if (!drone.alive || drone.state === "dying" || drone === exclude) {
        continue;
      }
      _oc.copy(drone.position).sub(origin);
      const t = _oc.dot(direction);
      if (t < 0 || t > bestDistance) {
        continue;
      }
      _closest.copy(origin).addScaledVector(direction, t);
      const r = drone.type.radius;
      const d2 = _closest.distanceToSquared(drone.position);
      if (d2 <= r * r) {
        const hitT = t - Math.sqrt(r * r - d2);
        if (hitT < bestDistance) {
          bestDistance = Math.max(0, hitT);
          best = drone;
        }
      }
    }
    return best ? { drone: best, distance: bestDistance } : null;
  }

  function findInCone(origin, direction, angle, maxDistance) {
    const cosLimit = Math.cos(angle);
    let best = null;
    let bestCos = cosLimit;
    for (const drone of drones) {
      if (!drone.alive || drone.state === "dying") {
        continue;
      }
      _oc.copy(drone.position).sub(origin);
      const distance = _oc.length();
      if (distance > maxDistance || distance < 1e-3) {
        continue;
      }
      // Widen the cone for big / close targets.
      const angular = Math.atan(drone.type.radius / distance);
      const c = _oc.dot(direction) / distance;
      const effective = Math.cos(Math.max(0, Math.acos(Math.min(1, c)) - angular));
      if (effective > bestCos) {
        bestCos = effective;
        best = drone;
      }
    }
    return best ? best.position : null;
  }

  function forEachThreat(callback) {
    for (const drone of drones) {
      if (drone.alive && drone.state !== "dying") {
        callback(drone);
      }
    }
  }

  function shiftX(dx) {
    for (const drone of drones) {
      drone.position.x += dx;
    }
  }

  function clear() {
    for (const drone of drones) {
      recycle(drone);
    }
  }

  function setWarmupVisible(visible, position) {
    const seen = new Set();
    for (const drone of drones) {
      if (seen.has(drone.type.id)) {
        continue;
      }
      seen.add(drone.type.id);
      drone.root.visible = visible;
      drone.aimLine.visible = visible;
      if (visible && position) {
        drone.aimLine.position.copy(position);
        drone.position.copy(position);
      }
    }
  }

  function getBoss() {
    return drones.find((d) => d.alive && d.type.boss && d.state !== "dying") ?? null;
  }

  return {
    group,
    getBoss,
    isOpen,
    spawn,
    kill,
    damage,
    update,
    raycast,
    findInCone,
    forEachThreat,
    countAlive,
    shiftX,
    clear,
    setWarmupVisible,
  };
}
