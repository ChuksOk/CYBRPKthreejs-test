import * as THREE from "three/webgpu";
import { color, float, texture, uv } from "three/tsl";
import { createPartKit } from "./modelKit.js";
import { cerakote, chrome, emissive, glass, gunmetal, polymer, rubber } from "./materials.js";

/**
 * Procedural carbine in real-world meters (≈0.95 m overall). Built in a
 * local frame with +X toward the muzzle, then turned so the barrel points
 * down -Z (camera forward). The -Z side (local) faces the player's view.
 */

function holoReticleMaterial() {
  const material = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
  const centered = uv().sub(0.5);
  const r = centered.length();
  const ring = float(1).sub(r.sub(0.3).abs().mul(40)).clamp(0, 1);
  const dot = float(1).sub(r.mul(26)).clamp(0, 1);
  const shape = ring.add(dot).clamp(0, 1);
  material.emissiveNode = color(0xff4f74).mul(shape).mul(6);
  material.opacityNode = shape;
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.AdditiveBlending;
  material.toneMapped = false;
  material.side = THREE.DoubleSide;
  return material;
}

function createAmmoScreen() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;

  const material = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
  material.emissiveNode = texture(map).rgb.mul(2.2);
  material.toneMapped = false;

  let last = "";
  function draw(ammo, mag, overclock, reloading) {
    const key = `${ammo}|${mag}|${overclock}|${reloading}`;
    if (key === last) {
      return;
    }
    last = key;
    ctx.fillStyle = "#07090d";
    ctx.fillRect(0, 0, 128, 64);
    const accent = overclock ? "#ff4f74" : "#d9ff3b";
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, 6, 64);
    ctx.font = "800 44px 'Barlow Condensed', 'Arial Narrow', sans-serif";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(overclock ? "∞" : reloading ? "--" : String(ammo).padStart(2, "0"), 14, 48);
    ctx.font = "700 11px 'JetBrains Mono', monospace";
    ctx.fillStyle = "#e9ebee";
    ctx.fillText(overclock ? "OVRCLK" : reloading ? "RELOAD" : `/${mag}`, 70, 22);
    // Round ticks.
    const filled = overclock ? mag : reloading ? 0 : ammo;
    for (let i = 0; i < 16; i++) {
      ctx.fillStyle = i < Math.round((filled / mag) * 16) ? accent : "#262b34";
      ctx.fillRect(70 + (i % 8) * 7, 32 + Math.floor(i / 8) * 12, 5, 9);
    }
    map.needsUpdate = true;
  }
  draw(32, 32, false, false);
  return { material, draw };
}

export function createRifleModel() {
  const kit = createPartKit();

  // ── Upper receiver ──────────────────────────────────────────────────────
  kit.profile("receiver", [
    [-0.13, -0.004], [-0.13, 0.028], [-0.116, 0.038], [0.17, 0.038], [0.182, 0.028], [0.182, -0.004],
  ], 0.05);
  // Ejection port cover + forward assist (right side, catches light).
  kit.box("metal", [0.07, 0.022, 0.004], { position: [0.02, 0.016, 0.026], radius: 0.001 });
  kit.tube("metal", 0.008, 0.03, "z", { position: [-0.06, 0.024, 0.03] });
  // Charging handle.
  kit.box("metal", [0.03, 0.01, 0.06], { position: [-0.128, 0.034, 0], radius: 0.003 });

  // ── Lower receiver + mag well ───────────────────────────────────────────
  kit.profile("receiver2", [
    [-0.125, -0.004], [0.105, -0.004], [0.108, -0.046], [0.098, -0.054], [0.028, -0.054],
    [0.012, -0.034], [-0.125, -0.03],
  ], 0.046);
  kit.box("metal", [0.012, 0.012, 0.05], { position: [0.02, -0.018, 0], radius: 0.002 }); // bolt catch / pins
  kit.tube("chrome", 0.0035, 0.052, "z", { position: [0.07, -0.02, 0] });
  kit.tube("chrome", 0.0035, 0.052, "z", { position: [-0.095, -0.012, 0] });

  // Trigger guard + trigger.
  kit.box("polymer", [0.075, 0.006, 0.014], { position: [-0.005, -0.063, 0], radius: 0.002 });
  kit.box("polymer", [0.006, 0.03, 0.014], { position: [0.03, -0.05, 0], radius: 0.002 });
  kit.box("chrome", [0.006, 0.022, 0.006], { position: [-0.008, -0.045, 0], rotation: [0, 0, -0.25], radius: 0.002 });

  // Pistol grip (stippled polymer).
  kit.profile("polymer", [
    [-0.03, -0.028], [0.004, -0.028], [-0.022, -0.14], [-0.052, -0.146], [-0.066, -0.132], [-0.05, -0.05],
  ], 0.034, { position: [-0.022, 0, 0] });

  // ── Curved magazine ─────────────────────────────────────────────────────
  const magPoints = [];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    magPoints.push([0.098 + t * 0.03 + t * t * 0.012, -0.05 - t * 0.155]);
  }
  for (let i = steps; i >= 0; i--) {
    const t = i / steps;
    magPoints.push([0.038 + t * 0.03 + t * t * 0.012, -0.05 - t * 0.16]);
  }
  kit.profile("mag", magPoints, 0.026);
  kit.box("polymer", [0.075, 0.014, 0.032], { position: [0.1, -0.215, 0], rotation: [0, 0, 0.18], radius: 0.004 });
  for (let i = 0; i < 3; i++) {
    kit.box("mag", [0.004, 0.09, 0.029], { position: [0.058 + i * 0.016 + 0.01, -0.12 - i * 0.004, 0], rotation: [0, 0, 0.2], radius: 0.0015 });
  }
  kit.box("led", [0.006, 0.07, 0.002], { position: [0.075, -0.115, -0.0142], rotation: [0, 0, 0.2], radius: 0.0008 });

  // ── Octagonal handguard with M-LOK slots ────────────────────────────────
  kit.tube("receiver", 0.037, 0.34, "x", { position: [0.35, 0.006, 0], rotation: [Math.PI / 8, 0, Math.PI / 2], radial: 8 });
  for (let i = 0; i < 5; i++) {
    const x = 0.225 + i * 0.058;
    for (const z of [-0.0345, 0.0345]) {
      kit.box("slot", [0.034, 0.009, 0.006], { position: [x, 0.002, z], radius: 0.003 });
    }
    kit.box("slot", [0.034, 0.006, 0.01], { position: [x, -0.031, 0], radius: 0.003 });
  }
  kit.box("led", [0.22, 0.0035, 0.0025], { position: [0.36, -0.017, -0.0355], radius: 0.001 });
  kit.box("ledPink", [0.012, 0.004, 0.0025], { position: [0.487, -0.017, -0.0355], radius: 0.001 });
  // End cap ring.
  kit.tube("metal", 0.034, 0.012, "x", { position: [0.522, 0.006, 0], radial: 24 });

  // ── Picatinny rail ──────────────────────────────────────────────────────
  kit.box("metal", [0.64, 0.008, 0.024], { position: [0.2, 0.043, 0], radius: 0.002 });
  for (let i = 0; i < 30; i++) {
    kit.box("metal", [0.01, 0.006, 0.026], { position: [-0.1 + i * 0.021, 0.05, 0], radius: 0.0015, segments: 1 });
  }

  // ── Barrel + muzzle brake ───────────────────────────────────────────────
  kit.tube("metal", 0.0095, 0.13, "x", { position: [0.59, 0.006, 0], radial: 18 });
  kit.tube("metal", 0.017, 0.07, "x", { position: [0.675, 0.006, 0], radial: 20 });
  for (let i = 0; i < 3; i++) {
    for (const z of [-0.016, 0.016]) {
      kit.box("slot", [0.01, 0.018, 0.006], { position: [0.655 + i * 0.016, 0.006, z], radius: 0.002 });
    }
  }
  kit.torus("chrome", 0.0125, 0.0035, { position: [0.711, 0.006, 0], rotation: [0, Math.PI / 2, 0], tubular: 24 });

  // ── Holographic sight (forward on the rail so it doesn't fill the view) ─
  const sx = 0.13;
  kit.box("receiver", [0.075, 0.012, 0.032], { position: [sx, 0.058, 0], radius: 0.004 });
  for (const z of [-0.017, 0.017]) {
    kit.box("receiver", [0.06, 0.04, 0.005], { position: [sx + 0.004, 0.084, z], radius: 0.002 });
  }
  kit.box("receiver", [0.06, 0.007, 0.039], { position: [sx + 0.004, 0.106, 0], radius: 0.003 });
  kit.box("metal", [0.018, 0.01, 0.01], { position: [sx - 0.02, 0.064, 0.022], radius: 0.003 }); // brightness knob
  kit.plane("glass", 0.029, 0.035, { position: [sx + 0.033, 0.085, 0], rotation: [0, Math.PI / 2, 0] });
  kit.plane("reticle", 0.024, 0.024, { position: [sx + 0.01, 0.085, 0], rotation: [0, Math.PI / 2, 0] });
  // Flip-up rear sight.
  kit.box("metal", [0.012, 0.026, 0.02], { position: [-0.09, 0.062, 0], radius: 0.003 });

  // ── Laser / light module ────────────────────────────────────────────────
  kit.box("polymer", [0.075, 0.024, 0.03], { position: [0.44, -0.044, 0], radius: 0.005 });
  kit.tube("glass", 0.008, 0.004, "x", { position: [0.479, -0.044, 0.006] });
  kit.tube("ledPink", 0.003, 0.003, "x", { position: [0.48, -0.044, -0.008] });

  // ── Stock ───────────────────────────────────────────────────────────────
  kit.tube("metal", 0.016, 0.2, "x", { position: [-0.22, 0.012, 0], radial: 18 });
  kit.profile("polymer", [
    [-0.2, 0.03], [-0.35, 0.03], [-0.36, -0.052], [-0.33, -0.06], [-0.27, -0.012], [-0.2, -0.006],
  ], 0.036);
  kit.box("rubber", [0.016, 0.092, 0.038], { position: [-0.362, -0.012, 0], rotation: [0, 0, 0.05], radius: 0.006 });

  const ammoScreen = createAmmoScreen();
  kit.plane("screen", 0.05, 0.025, { position: [-0.06, 0.013, -0.0262], rotation: [0, Math.PI, 0] });

  const inner = kit.build({
    receiver: cerakote({ tint: 0x23262b, roughness: 0.46 }),
    receiver2: cerakote({ tint: 0x34373d, roughness: 0.5 }),
    metal: gunmetal({ tint: 0x25282d, roughness: 0.3 }),
    chrome: chrome(),
    polymer: polymer(),
    mag: cerakote({ tint: 0x1d2024, roughness: 0.58 }),
    rubber: rubber(),
    slot: rubber(),
    glass: glass({ tint: 0x0a1418 }),
    reticle: holoReticleMaterial(),
    led: emissive(0xd9ff3b, 3.2),
    ledPink: emissive(0xff4f74, 4),
    screen: ammoScreen.material,
  }, { name: "rifle" });
  inner.rotation.y = Math.PI / 2;

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0.715, 0.006, 0);
  // Muzzle-flash billboard faces down the barrel.
  muzzle.rotation.y = Math.PI / 2;
  inner.add(muzzle);

  const root = new THREE.Group();
  root.name = "procedural-rifle";
  root.add(inner);

  return { root, muzzle, drawAmmo: ammoScreen.draw };
}
