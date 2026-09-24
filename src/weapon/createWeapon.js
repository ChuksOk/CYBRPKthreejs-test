import * as THREE from "three/webgpu";

const FIRE_RATE = 11;
const OVERCLOCK_FIRE_RATE = 19;
const MAG_SIZE = 32;
const RELOAD_TIME = 1.25;
const BASE_SPREAD = 0.003;
const SPREAD_PER_SHOT = 0.0028;
const MAX_SPREAD = 0.028;
const SPREAD_RECOVERY = 0.09;
const RANGE = 220;
const DAMAGE = 1;
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

  const state = {
    ammo: MAG_SIZE,
    magSize: MAG_SIZE,
    reloading: false,
    reloadTimer: 0,
    cooldown: 0,
    spread: BASE_SPREAD,
    overclock: 0,
    shotsFired: 0,
  };

  function startReload() {
    if (state.reloading || state.ammo === MAG_SIZE || state.overclock > 0) {
      return;
    }
    state.reloading = true;
    state.reloadTimer = RELOAD_TIME;
    audio?.play("reload", { volume: 0.7 });
  }

  const unsubscribeReload = controls.on("reload", startReload);

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
    fx.tracer(_muzzle, _hitPoint, state.overclock > 0 ? 0xfff27a : 0x7df9ff);
    fx.muzzleLight(_muzzle);
    viewmodel.kick(1);
    controls.addRecoil(0.011 + Math.random() * 0.004, (Math.random() - 0.5) * 0.006);
    audio?.play("shot", { volume: 0.32, detune: (Math.random() - 0.5) * 180 });

    if (hitKind === "drone") {
      drones.damage(hitDrone, DAMAGE, _hitPoint);
      fx.impact(_hitPoint, _direction.clone().negate(), { hex: 0xff5577, count: 6 });
      onHit?.("drone", hitDrone);
    } else if (hitKind === "bolt") {
      projectiles.destroy(hitBolt, true);
      onHit?.("bolt", hitBolt);
    } else if (hitKind === "world") {
      fx.impact(_hitPoint, _normal, { hex: 0xffc36b, count: 7 });
    }

    state.spread = Math.min(MAX_SPREAD, state.spread + SPREAD_PER_SHOT);
    state.shotsFired += 1;
    onShot?.();
  }

  /**
   * @param {number} delta
   * @param {{ canFire: boolean }} options
   */
  function update(delta, { canFire }) {
    state.cooldown = Math.max(-0.05, state.cooldown - delta);
    state.spread = Math.max(BASE_SPREAD, state.spread - SPREAD_RECOVERY * delta);

    if (state.overclock > 0) {
      state.overclock = Math.max(0, state.overclock - delta);
      viewmodel.setOverclock(state.overclock > 0);
    }

    if (state.reloading) {
      state.reloadTimer -= delta;
      viewmodel.setReloadProgress(1 - Math.max(0, state.reloadTimer) / RELOAD_TIME);
      if (state.reloadTimer <= 0) {
        state.reloading = false;
        state.ammo = MAG_SIZE;
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

    if (!wantsFire || state.reloading) {
      return;
    }

    const rate = state.overclock > 0 ? OVERCLOCK_FIRE_RATE : FIRE_RATE;
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
    state.ammo = MAG_SIZE;
    viewmodel.setReloadProgress(-1);
    viewmodel.setOverclock(true);
  }

  function reset() {
    state.ammo = MAG_SIZE;
    state.reloading = false;
    state.reloadTimer = 0;
    state.cooldown = 0;
    state.spread = BASE_SPREAD;
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
    getReloadProgress: () =>
      state.reloading ? 1 - Math.max(0, state.reloadTimer) / RELOAD_TIME : 0,
    dispose() {
      unsubscribeReload();
    },
  };
}
