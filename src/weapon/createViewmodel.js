import * as THREE from "three/webgpu";
import { createGunModel } from "../runner/models/createGunModels.js";
import { WEAPONS } from "./weaponTypes.js";
import { VIEWMODEL_LAYER } from "../runner/runnerConfig.js";
import { createMuzzleFlash } from "./createWeaponFx.js";

/** Grip sits bottom-right; the procedural carbine is modelled in meters. */
const BASE_OFFSET = new THREE.Vector3(0.19, -0.2, -0.31);

function expLerpFactor(delta, speed) {
  return 1 - Math.exp(-delta * speed);
}

/**
 * First-person rifle. The post pipeline renders cloned cameras, so instead of
 * parenting to the camera the rig lives in the scene and copies the camera
 * pose every frame. It sits on VIEWMODEL_LAYER, which the AO pre-pass, ground
 * mirror and rain height cameras never see.
 */
export function createViewmodel({ scene, camera }) {
  const rig = new THREE.Group();
  rig.name = "runner-viewmodel";
  const sway = new THREE.Group();
  const pivot = new THREE.Group();
  rig.add(sway);
  sway.add(pivot);
  pivot.position.copy(BASE_OFFSET);

  // All VX guns are built up front (shared materials) and toggled on switch.
  const guns = WEAPONS.map((weapon) => {
    const model = createGunModel(weapon.id);
    // Slight cant toward the screen center reads better than a dead-straight gun.
    model.root.rotation.set(0.015, 0.03, -0.035);
    model.root.visible = false;
    pivot.add(model.root);
    return model;
  });
  let current = 0;
  let pending = 0;
  let switchT = 1; // 0 → 1; lowers the old gun, raises the new one
  guns[0].root.visible = true;
  let muzzle = guns[0].muzzle;

  const flash = createMuzzleFlash();
  flash.mesh.visible = false;
  muzzle.add(flash.mesh);

  function setWeapon(index) {
    pending = index;
    switchT = 0;
  }

  rig.traverse((object) => {
    object.layers.set(VIEWMODEL_LAYER);
    object.frustumCulled = false;
  });
  camera.layers.enable(VIEWMODEL_LAYER);
  scene.add(rig);

  const swayOffset = new THREE.Vector2();
  const lastLook = new THREE.Vector2();
  let recoil = 0;
  let recoilVelocity = 0;
  let reloadT = -1;
  let visible = true;
  const _muzzleWorld = new THREE.Vector3();

  function kick(strength = 1) {
    recoilVelocity += 3.2 * strength;
    flash.trigger();
  }

  function setReloadProgress(t) {
    reloadT = t;
  }

  function setVisible(value) {
    visible = value;
    rig.visible = value;
  }

  /**
   * @param {number} delta
   * @param {object} motion  runner state (yaw, pitch, bobPhase, grounded, laneVelocity, slideTime)
   */
  function update(delta, motion) {
    flash.update(delta);
    let switchDip = 0;
    if (switchT < 1) {
      switchT = Math.min(1, switchT + delta / 0.35);
      if (switchT >= 0.5 && current !== pending) {
        guns[current].root.visible = false;
        current = pending;
        guns[current].root.visible = true;
        muzzle = guns[current].muzzle;
        muzzle.add(flash.mesh);
      }
      switchDip = -0.22 * Math.sin(Math.PI * switchT);
    }
    if (!visible) {
      return;
    }

    // Sway lags behind look deltas.
    const lookX = motion.yaw;
    const lookY = motion.pitch;
    const dx = delta > 0 ? (lookX - lastLook.x) / delta : 0;
    const dy = delta > 0 ? (lookY - lastLook.y) / delta : 0;
    lastLook.set(lookX, lookY);
    const swayBlend = expLerpFactor(delta, 10);
    swayOffset.x += (THREE.MathUtils.clamp(dx * 0.012, -0.05, 0.05) - swayOffset.x) * swayBlend;
    swayOffset.y += (THREE.MathUtils.clamp(-dy * 0.012, -0.05, 0.05) - swayOffset.y) * swayBlend;

    // Recoil spring.
    recoilVelocity += (-recoil * 180 - recoilVelocity * 18) * delta;
    recoil += recoilVelocity * delta;

    const bobActive = motion.grounded && motion.slideTime <= 0 ? 1 : 0;
    const phase = motion.bobPhase * Math.PI;
    const bobX = Math.sin(phase) * 0.012 * bobActive;
    const bobY = -Math.abs(Math.cos(phase)) * 0.01 * bobActive;
    const airLift = motion.grounded ? 0 : -0.025;
    const slideDip = motion.slideTime > 0 ? -0.03 : 0;

    let reloadDip = 0;
    let reloadRoll = 0;
    if (reloadT >= 0) {
      const s = Math.sin(Math.PI * reloadT);
      reloadDip = -0.12 * s;
      reloadRoll = 0.9 * s;
    }

    pivot.position.set(
      BASE_OFFSET.x + swayOffset.x + bobX,
      BASE_OFFSET.y + swayOffset.y + bobY + airLift + slideDip + reloadDip + switchDip,
      BASE_OFFSET.z + recoil * 0.05,
    );
    pivot.rotation.set(
      recoil * 0.12 - reloadRoll * 0.4 + switchDip * 1.5,
      swayOffset.x * 1.5,
      THREE.MathUtils.clamp(-motion.laneVelocity * 0.02, -0.25, 0.25) + reloadRoll * 0.6,
    );

    rig.position.copy(camera.position);
    rig.quaternion.copy(camera.quaternion);
    rig.updateMatrixWorld(true);
  }

  function getMuzzleWorldPosition(target = _muzzleWorld) {
    rig.updateMatrixWorld(true);
    return muzzle.getWorldPosition(target);
  }

  return {
    rig,
    setWeapon,
    getWeaponIndex: () => current,
    kick,
    update,
    setReloadProgress,
    setVisible,
    setOverclock: () => {},
    /** Live ammo counter on the receiver screen. */
    setAmmoDisplay: (ammo, mag, overclock, reloading) => guns[current].drawAmmo(ammo, mag, overclock, reloading),
    getMuzzleWorldPosition,
    setWarmupVisible(value) {
      flash.mesh.visible = value;
      guns.forEach((gun, index) => {
        gun.root.visible = value || index === current;
      });
    },
  };
}
