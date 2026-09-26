import * as THREE from "three/webgpu";
import { WEAPONS } from "./weaponTypes.js";

const SPREAD_RECOVERY = 0.09;
const SWITCH_TIME = 0.35;
const RANGE = 220;
/** Touch aim assist: auto-fire + magnetism inside this cone. */
const ASSIST_ANGLE = THREE.MathUtils.degToRad(7);

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
  /** In-run upgrade modifiers (see src/runner/upgrades.js). */
  getMods = () => null,
  /** Permanent damage multiplier from the Armory. */
  getMetaDamage = () => 1,
  isUnlocked = () => true,
  onLocked = null,
  getTracerHex = null,
}) {
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;

  const mod = (key, fallback) => getMods()?.[key] ?? fallback;
  const magOf = (w) => Math.max(1, Math.round(w.magSize * mod("mag", 1)));
  const reloadOf = (w) => w.reloadTime / mod("reload", 1);

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
    if (state.reloading || state.ammo === magOf(def) || state.overclock > 0 || state.switchTimer > 0) {
      return;
    }
    state.reloading = true;
    state.reloadTimer = reloadOf(def);
    audio?.play("reload", { volume: 0.7 });
  }

  /**
   * @param {number} index
   * @param {{ cycle?: 1 | -1 }} [options]  cycle skips locked guns; a direct
   *   pick of a locked gun is refused (onLocked).
   */
  function selectWeapon(index, { cycle = 0 } = {}) {
    let next = ((index % WEAPONS.length) + WEAPONS.length) % WEAPONS.length;
    if (cycle) {
      for (let guard = 0; guard < WEAPONS.length && !isUnlocked(next); guard++) {
        next = (((next + cycle) % WEAPONS.length) + WEAPONS.length) % WEAPONS.length;
      }
    } else if (!isUnlocked(next)) {
      onLocked?.(next);
      return;
    }
    if (next === state.index || !isUnlocked(next)) {
      return;
    }
    ammoByWeapon[state.index] = state.ammo;
    state.index = next;
    def = WEAPONS[next];
    state.weapon = def;
    state.ammo = ammoByWeapon[next];
    state.magSize = magOf(def);
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
      selectWeapon(state.index + 1, { cycle: 1 });
    } else if (value === "prev") {
      selectWeapon(state.index - 1, { cycle: -1 });
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
    fx.tracer(_muzzle, _hitPoint, state.overclock > 0 ? 0xff4f74 : getTracerHex?.() ?? def.tracer);
    fx.muzzleLight(_muzzle);
    viewmodel.kick(Math.min(2, def.recoil));
    controls.addRecoil((0.011 + Math.random() * 0.004) * def.recoil, (Math.random() - 0.5) * 0.006 * def.recoil);
    audio?.play("shot", { volume: def.sound.volume, detune: def.sound.detune + (Math.random() - 0.5) * 180 });

    if (hitKind === "drone") {
      const damage = def.damage * mod("damage", 1) * getMetaDamage();
      drones.damage(hitDrone, damage, _hitPoint);
      // Piercing rounds carry on into the next drone along the ray.
      if (mod("pierce", false)) {
        const second = drones.raycast(_hitPoint.clone().addScaledVector(_direction, 0.5), _direction, RANGE, hitDrone);
        if (second) {
          drones.damage(second.drone, damage * 0.7, _hitPoint);
          onHit?.("drone", second.drone, damage * 0.7);
        }
      }
      // Rail detonator: splash around the impact.
      if (def.id === "rail" && mod("railExplosive", false)) {
        fx.explosion(_hitPoint, { radius: 1.6 });
        const splashPoint = _hitPoint.clone();
        drones.forEachThreat((other) => {
          if (other !== hitDrone && other.position.distanceTo(splashPoint) < 4 + other.type.radius) {
            drones.damage(other, damage * 0.5, splashPoint);
          }
        });
      }
      fx.impact(_hitPoint, _direction.clone().negate(), { hex: 0xff5577, count: 6 });
      onHit?.("drone", hitDrone, damage);
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
      viewmodel.setReloadProgress(1 - Math.max(0, state.reloadTimer) / reloadOf(def));
      if (state.reloadTimer <= 0) {
        state.reloading = false;
        state.ammo = magOf(def);
        state.magSize = magOf(def);
        viewmodel.setReloadProgress(-1);
      }
    }

    if (!canFire) {
      return;
    }

    // Touch: firing is the on-screen button; aim is automatic, and shots
    // get a little magnetism toward a drone near the crosshair (also in VR,
    // where the aim ray is the right controller).
    let assistTarget = null;
    const wantsFire = controls.isTriggerHeld();
    if (wantsFire && (controls.isAimAssisted?.() ?? controls.isTouch())) {
      aimDirection(_direction);
      assistTarget = drones.findInCone(camera.position, _direction, ASSIST_ANGLE, RANGE);
    }

    if (!wantsFire || state.reloading || state.switchTimer > 0) {
      return;
    }

    const rate = (state.overclock > 0 ? def.overclockRate : def.fireRate) * mod("fireRate", 1);
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
    state.ammo = magOf(def);
    state.magSize = magOf(def);
    viewmodel.setReloadProgress(-1);
    viewmodel.setOverclock(true);
  }

  function reset() {
    WEAPONS.forEach((w, i) => {
      ammoByWeapon[i] = w.magSize;
    });
    // New runs start on the carbine (always unlocked).
    if (state.index !== 0) {
      state.index = 0;
      def = WEAPONS[0];
      state.weapon = def;
      viewmodel.setWeapon(0);
    }
    state.ammo = magOf(def);
    state.magSize = magOf(def);
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
    /** Re-apply magazine size after an upgrade. */
    refreshMods: () => {
      const mag = magOf(def);
      state.ammo = Math.min(mag, state.ammo + Math.max(0, mag - state.magSize));
      state.magSize = mag;
      WEAPONS.forEach((w, i) => {
        if (i !== state.index) {
          ammoByWeapon[i] = Math.max(ammoByWeapon[i], magOf(w));
        }
      });
    },
    getReloadProgress: () =>
      state.reloading ? 1 - Math.max(0, state.reloadTimer) / reloadOf(def) : 0,
    dispose() {
      unsubscribeReload();
      unsubscribeWeapon();
    },
  };
}
