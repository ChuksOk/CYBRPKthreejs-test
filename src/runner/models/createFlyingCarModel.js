import * as THREE from "three/webgpu";
import { color, float, oscSine, time } from "three/tsl";
import { createPartKit } from "./modelKit.js";
import { chrome, emissive, glass, gunFinish, gunmetal, rubber } from "./materials.js";

/**
 * Hover car for the Sky Run power-up. Uses the project's Quadra (world.car,
 * the same model as the alley hero car and the parked-car obstacles) fitted
 * with flight hardware: hover pads under the wheel wells, twin rear jets and
 * side cannon pods whose tips are the tracer muzzles. Without the Quadra
 * (car feature off) a procedural wedge car stands in.
 * Nose points +X, +Y up; `inner` is centred on the car so banking /
 * barrel rolls pivot around its middle.
 */

/** Quadra: GLB long axis is model +Z (headlights at +Z). */
const QUADRA_YAW = Math.PI / 2;

function cloneMovable(source) {
  // The scene car has frozen static transforms: clones must update again.
  const copy = source.clone(true);
  copy.traverse((child) => {
    child.matrixAutoUpdate = true;
  });
  return copy;
}

function buildQuadraCar(carModel) {
  const m = getMaterials();
  const inner = new THREE.Group();
  inner.name = "sky-car";
  const quadra = cloneMovable(carModel);
  quadra.position.set(0, 0, 0);
  quadra.rotation.set(0, QUADRA_YAW, 0);
  quadra.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(quadra, true);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  quadra.position.sub(center);
  inner.add(quadra);

  const halfL = size.x / 2;
  const halfW = size.z / 2;
  const bottom = -size.y / 2;
  const kit = createPartKit();
  // Hover pads where the wheels meet the road: dark ring + downward glow.
  for (const x of [halfL * 0.62, -halfL * 0.62]) {
    for (const side of [-1, 1]) {
      const z = side * (halfW - 0.28);
      kit.tube("dark", 0.36, 0.08, "y", { position: [x, bottom + 0.1, z], radial: 24 });
      kit.torus("chrome", 0.34, 0.025, { position: [x, bottom + 0.06, z], rotation: [Math.PI / 2, 0, 0], tubular: 28 });
      kit.circle("thrust", 0.3, { position: [x, bottom + 0.05, z], rotation: [Math.PI / 2, 0, 0], segments: 28 });
    }
  }
  // Twin rear jets under the bumper.
  for (const side of [-1, 1]) {
    const z = side * halfW * 0.45;
    kit.tube("metal", 0.16, 0.34, "x", { position: [-halfL + 0.05, bottom + 0.32, z], radial: 20 });
    kit.torus("chrome", 0.16, 0.022, { position: [-halfL - 0.12, bottom + 0.32, z], rotation: [0, Math.PI / 2, 0], tubular: 24 });
    kit.circle("thrust", 0.13, { position: [-halfL - 0.13, bottom + 0.32, z], rotation: [0, -Math.PI / 2, 0], segments: 24 });
  }
  // Side cannon pods low on the flanks.
  const podY = bottom + 0.42;
  const podZ = halfW + 0.12;
  for (const side of [-1, 1]) {
    kit.box("metal", [1.2, 0.16, 0.16], { position: [halfL * 0.35, podY, side * podZ], radius: 0.05 });
    kit.box("dark", [0.3, 0.12, 0.22], { position: [halfL * 0.1, podY, side * (podZ - 0.1)], radius: 0.04 });
    kit.tube("metal", 0.05, 0.6, "x", { position: [halfL * 0.35 + 0.85, podY, side * podZ], radial: 12 });
    kit.tube("chrome", 0.062, 0.1, "x", { position: [halfL * 0.35 + 1.18, podY, side * podZ], radial: 12 });
    kit.box("neon", [0.9, 0.025, 0.02], { position: [halfL * 0.35, podY + 0.09, side * (podZ + 0.08)], radius: 0.008, segments: 1 });
  }
  const hardware = kit.build(m, { name: "sky-car-hardware" });
  inner.add(hardware);

  const muzzles = [-1, 1].map((side) => {
    const muzzle = new THREE.Object3D();
    muzzle.position.set(halfL * 0.35 + 1.24, podY, side * podZ);
    inner.add(muzzle);
    return muzzle;
  });

  const root = new THREE.Group();
  root.name = "sky-car-root";
  root.add(inner);
  return { root, inner, muzzles, length: size.x };
}

const BODY = 0xd8dde3;
const ACCENT = 0xff2f8a;
const THRUST = 0x2ff0ff;

let materials = null;
function getMaterials() {
  if (!materials) {
    const thrust = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
    // Flickering jet glow (TSL timer, nothing per frame on the CPU).
    thrust.emissiveNode = color(THRUST).mul(oscSine(time.mul(9)).mul(0.6).add(float(3.2)));
    thrust.toneMapped = false;
    materials = {
      body: gunFinish({ tint: BODY, roughness: 0.32, metalness: 0.55, wear: 0.4 }),
      dark: gunFinish({ tint: 0x1c1f24, roughness: 0.5, metalness: 0.4, wear: 0.3 }),
      metal: gunmetal({ tint: 0x2d3036, roughness: 0.28 }),
      chrome: chrome({ tint: 0xb0b6be }),
      glass: glass({ tint: 0x0b1626 }),
      rubber: rubber(),
      neon: emissive(ACCENT, 3.6),
      thrust,
    };
  }
  return materials;
}

/** @param {{ carModel?: THREE.Object3D|null }} [options] */
export function createFlyingCarModel({ carModel = null } = {}) {
  if (carModel) {
    return buildQuadraCar(carModel);
  }
  return buildProceduralCar();
}

function buildProceduralCar() {
  const kit = createPartKit();
  const L = 3.4;

  // Hull: wedge side profile, extruded to the car's width.
  kit.profile("body", [
    [-1.7, 0.05], [-1.75, 0.42], [-1.1, 0.62], [0.6, 0.6], [1.5, 0.34], [1.72, 0.14], [1.6, 0.0], [-1.5, -0.02],
  ], 1.5, { bevel: 0.06 });
  // Belly pan + side skirts.
  kit.box("dark", [3.1, 0.12, 1.3], { position: [0, -0.04, 0], radius: 0.04 });
  for (const side of [-1, 1]) {
    kit.box("dark", [2.6, 0.16, 0.08], { position: [-0.05, 0.12, side * 0.77], radius: 0.03 });
    // Neon side stripe + tail light.
    kit.box("neon", [2.2, 0.03, 0.02], { position: [0.05, 0.3, side * 0.76], radius: 0.01, segments: 1 });
    kit.box("neon", [0.05, 0.1, 0.4], { position: [-1.76, 0.36, side * 0.45], radius: 0.015, segments: 1 });
  }
  // Canopy + frame.
  kit.sphere("glass", 0.55, { position: [-0.15, 0.62, 0], scale: [1.45, 0.62, 0.95], width: 28, height: 16 });
  kit.box("metal", [1.9, 0.05, 0.08], { position: [-0.15, 0.93, 0], radius: 0.02 });
  // Nose intake + headlights.
  kit.box("dark", [0.1, 0.12, 1.1], { position: [1.62, 0.2, 0], radius: 0.03 });
  for (const side of [-1, 1]) {
    kit.box("thrust", [0.04, 0.05, 0.3], { position: [1.64, 0.3, side * 0.45], radius: 0.015, segments: 1 });
  }
  // Rear spoiler.
  kit.box("body", [0.35, 0.05, 1.5], { position: [-1.55, 0.78, 0], rotation: [0, 0, 0.12], radius: 0.02 });
  for (const side of [-1, 1]) {
    kit.box("dark", [0.08, 0.22, 0.05], { position: [-1.5, 0.66, side * 0.6], radius: 0.015 });
  }

  // Rear: dark diffuser, full-width tail-light bar, main thruster + twin
  // exhausts (what the chase camera mostly sees).
  kit.box("dark", [0.08, 0.36, 1.36], { position: [-1.76, 0.2, 0], radius: 0.03 });
  kit.box("neon", [0.04, 0.07, 1.3], { position: [-1.8, 0.44, 0], radius: 0.015, segments: 1 });
  kit.box("dark", [0.6, 0.05, 0.5], { position: [-0.4, 0.93, 0], radius: 0.02 });
  kit.tube("metal", 0.24, 0.3, "x", { position: [-1.86, 0.18, 0], radial: 24 });
  kit.torus("chrome", 0.24, 0.03, { position: [-2.0, 0.18, 0], rotation: [0, Math.PI / 2, 0], tubular: 28 });
  kit.circle("thrust", 0.2, { position: [-2.02, 0.18, 0], rotation: [0, -Math.PI / 2, 0], segments: 28 });
  for (const side of [-1, 1]) {
    kit.tube("metal", 0.09, 0.2, "x", { position: [-1.84, 0.06, side * 0.42], radial: 16 });
    kit.circle("thrust", 0.07, { position: [-1.95, 0.06, side * 0.42], rotation: [0, -Math.PI / 2, 0], segments: 18 });
  }

  // Four thruster pods on short pylons (front / rear, both sides).
  const pods = [];
  for (const px of [0.95, -1.15]) {
    for (const side of [-1, 1]) {
      kit.box("metal", [0.3, 0.08, 0.3], { position: [px, 0.2, side * 0.88], radius: 0.03 });
      kit.tube("body", 0.23, 0.46, "x", { position: [px, 0.12, side * 1.12], radial: 20 });
      kit.torus("chrome", 0.23, 0.025, { position: [px + 0.23, 0.12, side * 1.12], rotation: [0, Math.PI / 2, 0], tubular: 24 });
      kit.tube("dark", 0.17, 0.05, "x", { position: [px - 0.24, 0.12, side * 1.12], radial: 18 });
      // Jet glow disc (rear) + downward lift glow.
      kit.circle("thrust", 0.15, { position: [px - 0.27, 0.12, side * 1.12], rotation: [0, -Math.PI / 2, 0], segments: 24 });
      kit.circle("thrust", 0.14, { position: [px, -0.12, side * 1.12], rotation: [Math.PI / 2, 0, 0], segments: 24 });
      pods.push([px, side]);
    }
  }

  // Twin nose cannons under the chin.
  for (const side of [-1, 1]) {
    kit.box("metal", [0.5, 0.1, 0.12], { position: [1.2, -0.08, side * 0.42], radius: 0.03 });
    kit.tube("metal", 0.045, 0.7, "x", { position: [1.6, -0.08, side * 0.42], radial: 12 });
    kit.tube("chrome", 0.055, 0.08, "x", { position: [1.96, -0.08, side * 0.42], radial: 12 });
    kit.box("neon", [0.3, 0.02, 0.02], { position: [1.3, -0.02, side * 0.42], radius: 0.008, segments: 1 });
  }

  const inner = kit.build(getMaterials(), { name: "sky-car", castShadow: false });
  const root = new THREE.Group();
  root.name = "sky-car-root";
  root.add(inner);

  const muzzles = [-1, 1].map((side) => {
    const muzzle = new THREE.Object3D();
    muzzle.position.set(2.02, -0.08, side * 0.42);
    inner.add(muzzle);
    return muzzle;
  });

  return { root, inner, muzzles, length: L };
}
