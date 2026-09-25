import * as THREE from "three/webgpu";
import { WEAPONS } from "./weaponTypes.js";

const SPREAD_RECOVERY = 0.09;
const SWITCH_TIME = 0.35;
const RANGE = 220;
/** Touch aim assist: auto-fire + magnetism inside this cone. */
const ASSIST_ANGLE = THREE.MathUtils.degToRad(4.5);

const _origin = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _toTarget = new THREE.Vector3();

/**
 * Hitscan rifle: one ray per shot tested against drone / bolt spheres (cheap
 * math) and a single first-hit BVH ray into the tiled city for impacts.
 */
export function createWeapon({
  camera,
  controls,
  viewmodel,
  fx,
  drones,
  projectiles,
  getWorldColliders,
  audio,
  onShot,
  onHit,
}) {
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;

  // Ammo is tracked per gun so switching never refills a magazine.
  const ammoByWeapon = WEAPONS.map((w) => w.magSize);
  let def = WEAPONS[0];

  const state = {
    index: 0,
    weapon: def,
    ammo: def.magSize,
    magSize: def.magSize,
    reloading: false,
    reloadTimer: 0,
    cooldown: 0,
    spread: def.baseSpread,
    overclock: 0,
    shotsFired: 0,
    switchTimer: 0,
  };

  function startReload() {
    if (state.reloading || state.ammo === def.magSize || state.overclock > 0 || state.switchTimer > 0) {
      return;
    }
    state.reloading = true;
    state.reloadTimer = def.reloadTime;
    audio?.play("reload", { volume: 0.7 });
  }

  function selectWeapon(index) {
    const next = ((index % WEAPONS.length) + WEAPONS.length) % WEAPONS.length;
    if (next === state.index) {
      return;
    }
    ammoByWeapon[state.index] = state.ammo;
    state.index = next;
    def = WEAPONS[next];
    state.weapon = def;
    state.ammo = ammoByWeapon[next];
    state.magSize = def.magSize;
    state.reloading = false;
    state.reloadTimer = 0;
    state.spread = def.baseSpread;
    state.cooldown = Math.max(state.cooldown, 0);
    state.switchTimer = SWITCH_TIME;
    viewmodel.setReloadProgress(-1);
    viewmodel.setWeapon(next);
    audio?.play("reload", { volume: 0.45, detune: 500 });
  }

  const unsubscribeReload = controls.on("reload", startReload);
  const unsubscribeWeapon = controls.on("weapon", (value) => {
    if (value === "next") {
      selectWeapon(state.index + 1);
    } else if (value === "prev") {
      selectWeapon(state.index - 1);
    } else {
      selectWeapon(value);
    }
  });

  function aimDirection(target) {
    camera.getWorldDirection(target);
    return target;
  }

  function fireShot(assistTarget) {
    _origin.copy(camera.position);
    aimDirection(_direction);

    if (assistTarget) {
      _toTarget.copy(assistTarget).sub(_origin).normalize();
      _direction.lerp(_toTarget, 0.65).normalize();
    }

    // Random cone spread.
    _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * state.spread;
    _direction
      .addScaledVector(_right, Math.cos(angle) * radius)
      .addScaledVector(_up, Math.sin(angle) * radius)
      .normalize();

    let nearest = RANGE;
    let hitKind = null;
    let hitDrone = null;
    let hitBolt = null;

    const droneHit = drones.raycast(_origin, _direction, nearest);
    if (droneHit) {
      nearest = droneHit.distance;
      hitKind = "drone";
      hitDrone = droneHit.drone;
    }

    const boltHit = projectiles.raycast(_origin, _direction, nearest);
    if (boltHit) {
      nearest = boltHit.distance;
      hitKind = "bolt";
      hitBolt = boltHit.bolt;
    }

    raycaster.set(_origin, _direction);
    raycaster.far = nearest;
    raycaster.layers.set(0);
    const colliders = getWorldColliders();
    const worldHits = colliders.length ? raycaster.intersectObjects(colliders, true) : [];
    if (worldHits.length > 0 && worldHits[0].distance < nearest) {
      nearest = worldHits[0].distance;
      hitKind = "world";
      const face = worldHits[0].face;
      if (face) {
        _normal.copy(face.normal).transformDirection(worldHits[0].object.matrixWorld);
      } else {
        _normal.copy(_direction).negate();
      }
    }

    _hitPoint.copy(_origin).addScaledVector(_direction, nearest);

    viewmodel.getMuzzleWorldPosition(_muzzle);
    fx.tracer(_muzzle, _hitPoint, state.overclock > 0 ? 0xff4f74 : def.tracer);
    fx.muzzleLight(_muzzle);
    viewmodel.kick(Math.min(2, def.recoil));
    controls.addRecoil((0.011 + Math.random() * 0.004) * def.recoil, (Math.random() - 0.5) * 0.006 * def.recoil);
    audio?.play("shot", { volume: def.sound.volume, detune: def.sound.detune + (Math.random() - 0.5) * 180 });

    if (hitKind === "drone") {
      drones.damage(hitDrone, def.damage, _hitPoint);
      fx.impact(_hitPoint, _direction.clone().negate(), { hex: 0xff5577, count: 6 });
      onHit?.("drone", hitDrone);
    } else if (hitKind === "bolt") {
      projectiles.destroy(hitBolt, true);
      onHit?.("bolt", hitBolt);
    } else if (hitKind === "world") {
      fx.impact(_hitPoint, _normal, { hex: 0xffc36b, count: 7 });
    }

    state.spread = Math.min(def.maxSpread, state.spread + def.spreadPerShot);
    state.shotsFired += 1;
    onShot?.();
  }

  /**
   * @param {number} delta
   * @param {{ canFire: boolean }} options
   */
  function update(delta, { canFire }) {
    state.cooldown = Math.max(-0.05, state.cooldown - delta);
    state.spread = Math.max(def.baseSpread, state.spread - SPREAD_RECOVERY * delta);
    state.switchTimer = Math.max(0, state.switchTimer - delta);

    if (state.overclock > 0) {
      state.overclock = Math.max(0, state.overclock - delta);
      viewmodel.setOverclock(state.overclock > 0);
    }

    if (state.reloading) {
      state.reloadTimer -= delta;
      viewmodel.setReloadProgress(1 - Math.max(0, state.reloadTimer) / def.reloadTime);
      if (state.reloadTimer <= 0) {
        state.reloading = false;
        state.ammo = def.magSize;
        viewmodel.setReloadProgress(-1);
      }
    }

    if (!canFire) {
      return;
    }

    let assistTarget = null;
    let wantsFire = controls.isTriggerHeld();
    if (controls.isTouch()) {
      aimDirection(_direction);
      assistTarget = drones.findInCone(camera.position, _direction, ASSIST_ANGLE, RANGE);
      wantsFire = wantsFire || Boolean(assistTarget);
    }

    if (!wantsFire || state.reloading || state.switchTimer > 0) {
      return;
    }

    const rate = state.overclock > 0 ? def.overclockRate : def.fireRate;
    while (state.cooldown <= 0) {
      if (state.ammo <= 0 && state.overclock <= 0) {
        startReload();
        break;
      }
      fireShot(assistTarget);
      if (state.overclock <= 0) {
        state.ammo -= 1;
      }
      state.cooldown += 1 / rate;
    }

    if (state.ammo <= 0 && state.overclock <= 0) {
      startReload();
    }
  }

  function addOverclock(seconds) {
    state.overclock = Math.max(state.overclock, seconds);
    state.reloading = false;
    state.ammo = def.magSize;
    viewmodel.setReloadProgress(-1);
    viewmodel.setOverclock(true);
  }

  function reset() {
    WEAPONS.forEach((w, i) => {
      ammoByWeapon[i] = w.magSize;
    });
    state.ammo = def.magSize;
    state.switchTimer = 0;
    state.reloading = false;
    state.reloadTimer = 0;
    state.cooldown = 0;
    state.spread = def.baseSpread;
    state.overclock = 0;
    state.shotsFired = 0;
    viewmodel.setReloadProgress(-1);
    viewmodel.setOverclock(false);
  }

  return {
    state,
    update,
    reset,
    startReload,
    addOverclock,
    selectWeapon,
    getReloadProgress: () =>
      state.reloading ? 1 - Math.max(0, state.reloadTimer) / def.reloadTime : 0,
    dispose() {
      unsubscribeReload();
      unsubscribeWeapon();
    },
  };
}
