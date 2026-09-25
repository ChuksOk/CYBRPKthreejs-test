import * as THREE from "three/webgpu";
import { texture } from "three/tsl";
import { createPartKit } from "./modelKit.js";
import { cerakote, chrome, emissive, glass, gunmetal, polymer, rubber } from "./materials.js";

/**
 * VX-series guns after the concept sheet: slab-sided upper shroud, open
 * ejection window with a chambered round, angular integrated stock with a
 * lattice butt pad, D-loop foregrip, windowed magazine, stencilled code.
 * Finish: off-white with neon green accents.
 *
 * Built in meters with +X toward the muzzle, then turned so the barrel
 * points down -Z. Local -Z is the side the player sees.
 */

export const NEON_GREEN = 0x5dff3a;
const OFF_WHITE = 0xe4e1d8;

const SPECS = {
  carbine: { code: "06", length: 0.62, stock: "block", grip: "loop", mag: "box", vents: false, pistol: false },
  smg: { code: "09", length: 0.42, stock: "skeleton", grip: "loop", mag: "box", vents: false, pistol: true },
  rail: { code: "12", length: 0.95, stock: "block", grip: "none", mag: "cell", vents: false, pistol: true },
  heavy: { code: "14", length: 0.78, stock: "block", grip: "loop", mag: "long", vents: true, pistol: false },
};

function codeMaterial(code) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.font = "800 58px 'Barlow Condensed', 'Arial Narrow', sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#5dff3a";
  ctx.fillText(code, 8, 34);
  ctx.fillRect(74, 18, 44, 5);
  ctx.fillRect(74, 30, 30, 5);
  ctx.fillRect(74, 42, 38, 5);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
  const sample = texture(map);
  material.emissiveNode = sample.rgb.mul(2.4);
  material.opacityNode = sample.a;
  material.transparent = true;
  material.depthWrite = false;
  material.toneMapped = false;
  return material;
}

function createAmmoScreen() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
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
    const accent = overclock ? "#ff4f74" : "#5dff3a";
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, 6, 64);
    ctx.font = "800 44px 'Barlow Condensed', 'Arial Narrow', sans-serif";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(overclock ? "∞" : reloading ? "--" : String(ammo).padStart(2, "0"), 14, 48);
    ctx.font = "700 11px 'JetBrains Mono', monospace";
    ctx.fillStyle = "#e9ebee";
    ctx.fillText(overclock ? "OVRCLK" : reloading ? "RELOAD" : `/${mag}`, 70, 22);
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

let sharedMaterials = null;

function getSharedMaterials() {
  if (!sharedMaterials) {
    sharedMaterials = {
      body: cerakote({ tint: OFF_WHITE, roughness: 0.52 }),
      body2: cerakote({ tint: 0xcfccc3, roughness: 0.6 }),
      dark: cerakote({ tint: 0x26282c, roughness: 0.55 }),
      metal: gunmetal({ tint: 0x303338, roughness: 0.32 }),
      chrome: chrome(),
      brass: chrome({ tint: 0xc9a049 }),
      grip: polymer({ tint: 0x1e2024 }),
      rubber: rubber(),
      glass: glass({ tint: 0x0a1410 }),
      neon: emissive(NEON_GREEN, 3.4),
    };
  }
  return sharedMaterials;
}

function buildGun(specId) {
  const spec = SPECS[specId];
  const kit = createPartKit();
  const L = spec.length;

  // ── Upper shroud: long slab, flat top, chamfered nose ─────────────────
  kit.profile("body", [
    [-0.14, -0.004], [-0.14, 0.05], [-0.1, 0.07], [L - 0.02, 0.07], [L, 0.058], [L, -0.004],
  ], 0.056, { bevel: 0.004 });
  // Top spine + side seam line.
  kit.box("dark", [L - 0.02, 0.006, 0.03], { position: [(L - 0.12) / 2, 0.072, 0], radius: 0.002, segments: 1 });
  kit.box("neon", [L * 0.62, 0.0035, 0.002], { position: [L * 0.42, 0.045, -0.0292], radius: 0.001, segments: 1 });
  kit.box("dark", [L * 0.9, 0.004, 0.002], { position: [L * 0.46, 0.012, -0.0292], radius: 0.001, segments: 1 });
  // Front face: dark bore recess + neon ring.
  kit.box("dark", [0.006, 0.05, 0.044], { position: [L + 0.001, 0.03, 0], radius: 0.004 });
  kit.tube("metal", 0.012, 0.02, "x", { position: [L + 0.004, 0.03, 0], radial: 16 });
  kit.torus("neon", 0.016, 0.0025, { position: [L + 0.006, 0.03, 0], rotation: [0, Math.PI / 2, 0], tubular: 24 });

  // Heavy: vent slots along the top.
  if (spec.vents) {
    for (let i = 0; i < 6; i++) {
      kit.box("dark", [0.045, 0.01, 0.034], { position: [0.24 + i * 0.075, 0.068, 0], radius: 0.003 });
    }
    kit.box("neon", [0.006, 0.02, 0.002], { position: [L - 0.06, 0.048, -0.0292], radius: 0.001 });
    kit.box("neon", [0.006, 0.02, 0.002], { position: [L - 0.075, 0.048, -0.0292], radius: 0.001 });
  }

  // ── Ejection window with visible bolt + chambered round (player side) ─
  kit.box("dark", [0.13, 0.03, 0.006], { position: [0.02, 0.03, -0.027], radius: 0.003 });
  kit.box("chrome", [0.08, 0.012, 0.006], { position: [0.02, 0.034, -0.0285], radius: 0.002 });
  kit.tube("brass", 0.005, 0.03, "x", { position: [0.06, 0.024, -0.0288], radial: 12 });
  kit.box("metal", [0.014, 0.01, 0.01], { position: [-0.05, 0.034, -0.03], radius: 0.003 }); // charging handle
  // Small status lights + stencil.
  kit.box("neon", [0.004, 0.004, 0.002], { position: [0.1, 0.052, -0.0292], radius: 0.001, segments: 1 });
  kit.box("neon", [0.004, 0.004, 0.002], { position: [0.108, 0.052, -0.0292], radius: 0.001, segments: 1 });

  // ── Lower receiver ─────────────────────────────────────────────────────
  kit.profile("body2", [
    [-0.15, -0.004], [0.13, -0.004], [0.13, -0.03], [0.08, -0.055], [-0.02, -0.055], [-0.06, -0.035], [-0.15, -0.035],
  ], 0.05);
  // Trigger guard + trigger.
  kit.box("dark", [0.07, 0.007, 0.016], { position: [-0.03, -0.07, 0], radius: 0.002 });
  kit.box("dark", [0.007, 0.02, 0.016], { position: [0.004, -0.062, 0], radius: 0.002 });
  kit.box("chrome", [0.006, 0.02, 0.006], { position: [-0.03, -0.055, 0], rotation: [0, 0, -0.25], radius: 0.002 });

  // Pistol grip (SMG / rail).
  if (spec.pistol) {
    kit.profile("grip", [
      [-0.06, -0.03], [-0.03, -0.03], [-0.05, -0.14], [-0.08, -0.146], [-0.092, -0.132], [-0.074, -0.05],
    ], 0.032);
  }

  // ── Stock ──────────────────────────────────────────────────────────────
  if (spec.stock === "block") {
    kit.profile("body", [
      [-0.15, 0.05], [-0.4, 0.045], [-0.42, 0.02], [-0.42, -0.1], [-0.3, -0.105], [-0.2, -0.06], [-0.15, -0.035],
    ], 0.052, { bevel: 0.004 });
    // Grip cut-out shadow (thumbhole feel) + code stencil on the player side.
    kit.box("dark", [0.08, 0.035, 0.004], { position: [-0.19, -0.04, -0.026], radius: 0.006 });
    kit.plane("code", 0.07, 0.035, { position: [-0.31, -0.02, -0.0272], rotation: [0, Math.PI, 0] });
    // Lattice butt pad.
    kit.box("dark", [0.02, 0.15, 0.05], { position: [-0.428, -0.028, 0], radius: 0.004 });
    for (let i = 0; i < 6; i++) {
      kit.box("rubber", [0.012, 0.004, 0.052], { position: [-0.44, -0.09 + i * 0.024, 0], radius: 0.001, segments: 1 });
    }
    for (let i = 0; i < 3; i++) {
      kit.box("rubber", [0.012, 0.15, 0.004], { position: [-0.44, -0.028, -0.018 + i * 0.018], radius: 0.001, segments: 1 });
    }
    kit.box("neon", [0.003, 0.05, 0.002], { position: [-0.36, 0.0, -0.0272], radius: 0.001, segments: 1 });
  } else {
    // Skeleton folding stock (SMG).
    kit.box("dark", [0.26, 0.018, 0.024], { position: [-0.27, 0.035, 0], radius: 0.005 });
    kit.box("dark", [0.3, 0.016, 0.022], { position: [-0.27, -0.04, 0], rotation: [0, 0, 0.26], radius: 0.005 });
    kit.box("body", [0.03, 0.14, 0.04], { position: [-0.405, -0.02, 0], radius: 0.008 });
    kit.box("rubber", [0.01, 0.13, 0.042], { position: [-0.422, -0.02, 0], radius: 0.004 });
    kit.tube("metal", 0.008, 0.03, "z", { position: [-0.15, 0.035, 0] });
    kit.plane("code", 0.06, 0.03, { position: [0.07, -0.018, -0.0252], rotation: [0, Math.PI, 0] });
  }

  // ── Magazine / power cell ──────────────────────────────────────────────
  if (spec.mag === "box" || spec.mag === "long") {
    const h = spec.mag === "long" ? 0.2 : 0.14;
    const mx = spec.stock === "skeleton" ? 0.07 : 0.08;
    kit.box("dark", [0.05, h, 0.03], { position: [mx, -0.04 - h / 2, 0], rotation: [0, 0, 0.1], radius: 0.006 });
    kit.box("glass", [0.018, h * 0.6, 0.002], { position: [mx + 0.004, -0.045 - h / 2, -0.0158], rotation: [0, 0, 0.1], radius: 0.001, segments: 1 });
    for (let i = 0; i < 6; i++) {
      kit.tube("brass", 0.0045, 0.018, "x", {
        position: [mx + 0.004 - (i * h * 0.1) * 0.1, -0.02 - h * 0.25 - i * h * 0.1, -0.0162],
        rotation: [0, 0, 0.1 + Math.PI / 2],
        radial: 10,
      });
    }
    kit.box("body", [0.06, 0.012, 0.036], { position: [mx - 0.013, -0.045 - h, 0], rotation: [0, 0, 0.1], radius: 0.004 });
  } else if (spec.mag === "cell") {
    // Rail: energy cell in the lower + coil glow along the rod.
    kit.box("dark", [0.09, 0.04, 0.04], { position: [0.08, -0.03, 0], radius: 0.008 });
    for (let i = 0; i < 3; i++) {
      kit.box("neon", [0.018, 0.024, 0.002], { position: [0.05 + i * 0.026, -0.03, -0.0205], radius: 0.002 });
    }
  }

  // ── D-loop foregrip ────────────────────────────────────────────────────
  if (spec.grip === "loop") {
    const gx = spec.stock === "skeleton" ? 0.2 : 0.24;
    const loop = new THREE.Shape();
    loop.moveTo(gx - 0.05, -0.004);
    loop.lineTo(gx + 0.08, -0.004);
    loop.quadraticCurveTo(gx + 0.1, -0.1, gx + 0.03, -0.12);
    loop.lineTo(gx - 0.02, -0.12);
    loop.quadraticCurveTo(gx - 0.06, -0.1, gx - 0.05, -0.004);
    const hole = new THREE.Path();
    hole.moveTo(gx - 0.025, -0.035);
    hole.lineTo(gx + 0.055, -0.035);
    hole.quadraticCurveTo(gx + 0.065, -0.09, gx + 0.02, -0.095);
    hole.lineTo(gx - 0.01, -0.095);
    hole.quadraticCurveTo(gx - 0.035, -0.085, gx - 0.025, -0.035);
    loop.holes.push(hole);
    kit.shape("body", loop, 0.034, { bevel: 0.005 });
    kit.box("grip", [0.012, 0.07, 0.036], { position: [gx - 0.036, -0.07, 0], rotation: [0, 0, -0.2], radius: 0.005 });
  }

  // ── Under-rod / lower rail ─────────────────────────────────────────────
  const rodStart = spec.grip === "loop" ? (spec.stock === "skeleton" ? 0.3 : 0.36) : 0.16;
  if (L - 0.02 > rodStart + 0.05) {
    const rodLength = L - 0.02 - rodStart;
    kit.box("dark", [rodLength, 0.03, 0.04], { position: [rodStart + rodLength / 2, -0.02, 0], radius: 0.006 });
    const slits = Math.max(1, Math.floor(rodLength / 0.08));
    for (let i = 0; i < slits; i++) {
      kit.box("neon", [0.03, 0.003, 0.002], { position: [rodStart + 0.04 + i * 0.08, -0.02, -0.0212], radius: 0.001, segments: 1 });
    }
  }

  const ammoScreen = createAmmoScreen();
  kit.plane("screen", 0.05, 0.025, { position: [-0.08, 0.022, -0.0292], rotation: [0, Math.PI, 0] });

  const inner = kit.build({
    ...getSharedMaterials(),
    code: codeMaterial(spec.code),
    screen: ammoScreen.material,
  }, { name: `vx-${spec.code}` });
  inner.rotation.y = Math.PI / 2;

  const muzzle = new THREE.Object3D();
  muzzle.position.set(L + 0.01, 0.03, 0);
  muzzle.rotation.y = Math.PI / 2;
  inner.add(muzzle);

  const root = new THREE.Group();
  root.name = `gun-${specId}`;
  root.add(inner);
  return { root, muzzle, drawAmmo: ammoScreen.draw, length: L };
}

/** @param {"carbine"|"smg"|"rail"|"heavy"} id */
export function createGunModel(id) {
  return buildGun(id);
}
