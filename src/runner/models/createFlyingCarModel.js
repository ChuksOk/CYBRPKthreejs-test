import * as THREE from "three/webgpu";
import { color, float, oscSine, time } from "three/tsl";
import { createPartKit } from "./modelKit.js";
import { chrome, emissive, glass, gunFinish, gunmetal, rubber } from "./materials.js";

/**
 * Hover car for the Sky Run power-up: a low wedge body with a bubble
 * canopy, four swivelling thruster pods, twin nose cannons and neon trim.
 * Built along +X (nose), +Y up, ~3.4 m long; two muzzle anchors sit at the
 * cannon tips so weapon tracers leave from the car.
 */

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

export function createFlyingCarModel() {
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
