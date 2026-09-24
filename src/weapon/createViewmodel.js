import * as THREE from "three/webgpu";
import { color, float, max, min, texture, uniform } from "three/tsl";
import { VIEWMODEL_LAYER } from "../runner/runnerConfig.js";
import { createMuzzleFlash } from "./createWeaponFx.js";

const BASE_OFFSET = new THREE.Vector3(0.16, -0.16, -0.3);
const MODEL_SCALE = 0.17;
/** Barrel tip in model space (Kenney blaster-repeater points its barrels along +Z). */
const MUZZLE_LOCAL = new THREE.Vector3(0, 0.3, 1.28);

function expLerpFactor(delta, speed) {
  return 1 - Math.exp(-delta * speed);
}

/**
 * Restyle the low-poly CC0 blaster to the scene: gunmetal PBR over the Kenney
 * colormap, saturated palette cells turned into a cyan neon glow.
 */
function restyle(root, uGlow) {
  root.traverse((child) => {
    if (!child.isMesh) {
      return;
    }
    const map = child.material?.map ?? null;
    const material = new THREE.MeshStandardNodeMaterial({
      color: 0x5c6273,
      metalness: 0.7,
      roughness: 0.32,
      map,
    });
    if (map) {
      const sample = texture(map).rgb;
      const saturation = max(sample.r, max(sample.g, sample.b)).sub(min(sample.r, min(sample.g, sample.b)));
      material.emissiveNode = color(0x22d3ee).mul(saturation.smoothstep(0.3, 0.5)).mul(uGlow);
    }
    child.material = material;
    child.castShadow = false;
    child.receiveShadow = false;
  });
}

/**
 * First-person rifle. The post pipeline renders cloned cameras, so instead of
 * parenting to the camera the rig lives in the scene and copies the camera
 * pose every frame. It sits on VIEWMODEL_LAYER, which the AO pre-pass, ground
 * mirror and rain height cameras never see.
 */
export function createViewmodel({ scene, camera, model }) {
  const rig = new THREE.Group();
  rig.name = "runner-viewmodel";
  const sway = new THREE.Group();
  const pivot = new THREE.Group();
  rig.add(sway);
  sway.add(pivot);
  pivot.position.copy(BASE_OFFSET);

  const uGlow = uniform(2.2);
  const gun = model;
  gun.scale.setScalar(MODEL_SCALE);
  gun.rotation.y = Math.PI;
  restyle(gun, uGlow);
  pivot.add(gun);

  // Neon rail strip along the receiver.
  const railMaterial = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
  railMaterial.emissiveNode = color(0xe040fb).mul(float(3).mul(uGlow.div(2.2)));
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.009, 0.009, 0.15), railMaterial);
  rail.position.set(0.072, 0.1, -0.015);
  pivot.add(rail);

  const muzzle = new THREE.Object3D();
  muzzle.position.copy(MUZZLE_LOCAL);
  gun.add(muzzle);

  const flash = createMuzzleFlash();
  flash.mesh.visible = false;
  muzzle.add(flash.mesh);

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
      BASE_OFFSET.y + swayOffset.y + bobY + airLift + slideDip + reloadDip,
      BASE_OFFSET.z + recoil * 0.05,
    );
    pivot.rotation.set(
      recoil * 0.12 - reloadRoll * 0.4,
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
    muzzle,
    kick,
    update,
    setReloadProgress,
    setVisible,
    setOverclock: (active) => {
      uGlow.value = active ? 5 : 2.2;
    },
    getMuzzleWorldPosition,
    setWarmupVisible(value) {
      flash.mesh.visible = value;
    },
  };
}
