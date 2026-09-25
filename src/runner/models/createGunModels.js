import * as THREE from "three/webgpu";
import { texture } from "three/tsl";
import { createPartKit } from "./modelKit.js";
import { chrome, decal, emissive, glass, gunFinish, gunmetal, polymer, rubber } from "./materials.js";

/**
 * VX-series guns after the concept sheet: slab-sided upper shroud with
 * bolted side panels, a low top rail, an open ejection port showing the
 * bolt carrier and a chambered round, angular integrated stock with a
 * lattice butt pad and sling loop, D-loop foregrip, ribbed windowed
 * magazine, long under-rod with a recessed channel and painted stencils.
 * Finish: two-tone graphite with handling wear (materials.gunFinish); neon
 * is kept to status LEDs and the ammo screen.
 *
 * Built in meters with +X toward the muzzle, then turned so the barrel
 * points down -Z. Local -Z is the side the player sees.
 */

export const NEON_GREEN = 0x5dff3a;
const UPPER = 0x7a7b7c;
const LOWER = 0x434547;

const SPECS = {
  carbine: { code: "06", length: 0.62, stock: "block", grip: "loop", mag: "box", vents: false, pistol: false },
  smg: { code: "09", length: 0.42, stock: "skeleton", grip: "loop", mag: "box", vents: false, pistol: true },
  rail: { code: "12", length: 0.95, stock: "block", grip: "none", mag: "cell", vents: true, pistol: true },
  heavy: { code: "14", length: 0.78, stock: "block", grip: "loop", mag: "long", vents: true, pistol: false },
};

function canvasTexture(width, height, draw) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext("2d"));
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  return map;
}

/** Big stencilled model number (dark paint on the stock, like the sheet). */
function codeMaterial(code) {
  const map = canvasTexture(256, 128, (ctx) => {
    ctx.font = "800 116px 'Barlow Condensed', 'Arial Narrow', sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(code, 10, 70);
  });
  return decal(map, { tint: 0x26282c, roughness: 0.8 });
}

/** Small light-grey markings: serial text, "//" slashes, arrows. */
function markingsMaterial(code) {
  const map = canvasTexture(256, 64, (ctx) => {
    ctx.fillStyle = "#ffffff";
    ctx.font = "700 15px 'JetBrains Mono', monospace";
    ctx.fillText(`VX-${code} // CAL 6.8 CL`, 6, 20);
    ctx.font = "700 11px 'JetBrains Mono', monospace";
    ctx.fillText("SER 0" + code + "-4471-K", 6, 38);
    ctx.fillText("SAFE ▸ SEMI ▸ AUTO", 6, 54);
    ctx.save();
    ctx.translate(200, 8);
    ctx.transform(1, 0, -0.45, 1, 0, 0);
    ctx.fillRect(10, 0, 7, 48);
    ctx.fillRect(26, 0, 7, 48);
    ctx.restore();
  });
  return decal(map, { tint: 0xc9cbc8, roughness: 0.7 });
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

/**
 * Hand pose = palm position + hand basis (finger dir, back-of-hand normal)
 * in gun-local space, plus how tightly the fingers curl for that grip.
 */
function handAnchor(parent, { position, fingers, back, curl = 1, index = null }) {
  const anchor = new THREE.Object3D();
  const y = new THREE.Vector3(...fingers).normalize();
  const z = new THREE.Vector3(...back).normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  z.crossVectors(x, y).normalize();
  anchor.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  anchor.position.set(...position);
  anchor.userData.curl = curl;
  anchor.userData.index = index;
  parent.add(anchor);
  return anchor;
}

// Right hand: palm on the right (+Z) of the grip, fingers wrap forward and
// round to the player side; index finger rests on the trigger.
const RIGHT_PISTOL = { position: [-0.085, -0.085, 0.034], fingers: [0.92, -0.4, 0], back: [0, 0, 1], curl: 1, index: 0.55 };
const RIGHT_STOCK = { position: [-0.19, -0.075, 0.042], fingers: [0.8, -0.6, 0], back: [0, 0, 1], curl: 0.95, index: 0.5 };
// Left hand: back of the hand faces the player (−Z).
const leftLoop = (gx) => ({ position: [gx - 0.07, -0.075, -0.036], fingers: [0.98, 0.2, 0], back: [0, 0, -1], curl: 1 });
// Rail: hand hangs under the rod like on a handstop.
const leftRail = (L) => ({ position: [Math.min(0.36, L * 0.38), -0.07, -0.036], fingers: [0.98, 0.2, 0], back: [0, 0, -1], curl: 0.95 });
const magBox = (mx, h) => ({ position: [mx - 0.01, -0.06 - h * 0.7, -0.036], fingers: [0.95, 0.3, 0], back: [0, 0, -1], curl: 0.85 });
const MAG_CELL = { position: [0.08, -0.045, -0.045], fingers: [1, 0.1, 0], back: [0, 0, -1], curl: 0.8 };

export function getSharedMaterials() {
  if (!sharedMaterials) {
    sharedMaterials = {
      body: gunFinish({ tint: UPPER, roughness: 0.5, metalness: 0.5 }),
      body2: gunFinish({ tint: LOWER, roughness: 0.58, metalness: 0.4, wear: 0.8 }),
      dark: gunFinish({ tint: 0x1e2023, roughness: 0.62, metalness: 0.3, wear: 0.5, bare: 0x5a5d62 }),
      metal: gunmetal({ tint: 0x2c2f34, roughness: 0.3 }),
      chrome: chrome({ tint: 0x9aa0a8 }),
      brass: chrome({ tint: 0xc9a049 }),
      copper: chrome({ tint: 0xb8734a }),
      grip: polymer({ tint: 0x25272b }),
      rubber: rubber(),
      glass: glass({ tint: 0x0b1210 }),
      neon: emissive(NEON_GREEN, 3.4),
      warn: emissive(0xff3b3b, 2.2),
      paint: gunFinish({ tint: 0xd9d7d0, roughness: 0.6, metalness: 0.1, wear: 0.6 }),
    };
  }
  return sharedMaterials;
}

function buildGun(specId) {
  const spec = SPECS[specId];
  const kit = createPartKit();
  const L = spec.length;
  const skeleton = spec.stock === "skeleton";
  const PS = -0.0292; // player-side skin (z) of the 56 mm upper
  const screw = (x, y, z = PS - 0.0008) => {
    kit.tube("metal", 0.0026, 0.002, "z", { position: [x, y, z], radial: 10 });
    kit.box("dark", [0.0034, 0.0006, 0.0008], { position: [x, y, z - 0.0011], rotation: [0, 0, 0.6], radius: 0.0002, segments: 1 });
  };

  // ── Upper shroud: long slab, flat top, chamfered nose ─────────────────
  kit.profile("body", [
    [-0.14, -0.004], [-0.14, 0.05], [-0.1, 0.07], [L - 0.03, 0.07], [L, 0.052], [L, -0.004],
  ], 0.056, { bevel: 0.003 });
  // Raised top deck + low rail (teeth) over the receiver.
  kit.box("body", [L - 0.06, 0.006, 0.042], { position: [(L - 0.1) / 2 - 0.02, 0.073, 0], radius: 0.002, segments: 2 });
  const railStart = -0.09;
  const railEnd = Math.min(0.2, L * 0.4);
  kit.box("dark", [railEnd - railStart, 0.004, 0.026], { position: [(railStart + railEnd) / 2, 0.078, 0], radius: 0.0012, segments: 1 });
  for (let x = railStart + 0.006; x < railEnd - 0.004; x += 0.01) {
    kit.box("dark", [0.005, 0.004, 0.03], { position: [x, 0.082, 0], radius: 0.001, segments: 1 });
  }
  // Bolted side panels (both sides) with a recessed seam under them.
  const panelStart = 0.14;
  const panelEnd = L - 0.05;
  if (panelEnd - panelStart > 0.06) {
    for (const side of [-1, 1]) {
      kit.box("body", [panelEnd - panelStart, 0.036, 0.003], {
        position: [(panelStart + panelEnd) / 2, 0.036, side * 0.0288],
        radius: 0.0012,
        segments: 2,
      });
    }
    screw(panelStart + 0.012, 0.047);
    screw(panelStart + 0.012, 0.025);
    screw(panelEnd - 0.012, 0.047);
    screw(panelEnd - 0.012, 0.025);
  }
  kit.box("dark", [L + 0.1, 0.0022, 0.058], { position: [(L - 0.12) / 2, 0.011, 0], radius: 0.0008, segments: 1 });
  kit.box("dark", [0.0022, 0.05, 0.0012], { position: [0.132, 0.036, PS - 0.0003], radius: 0.0005, segments: 1 });
  // Nose: recessed muzzle face, crowned barrel, bore, warning tag, slashes.
  kit.box("dark", [0.008, 0.046, 0.046], { position: [L + 0.001, 0.028, 0], radius: 0.005 });
  kit.tube("metal", 0.0125, 0.018, "x", { position: [L + 0.004, 0.03, 0], radial: 20 });
  kit.torus("metal", 0.011, 0.0022, { position: [L + 0.013, 0.03, 0], rotation: [0, Math.PI / 2, 0], radial: 8, tubular: 24 });
  kit.tube("rubber", 0.0068, 0.004, "x", { position: [L + 0.0125, 0.03, 0], radial: 16 });
  kit.box("paint", [0.018, 0.012, 0.002], { position: [L - 0.03, 0.058, PS - 0.0012], radius: 0.0008, segments: 1 });
  kit.box("warn", [0.006, 0.008, 0.001], { position: [L - 0.034, 0.058, PS - 0.0026], radius: 0.0004, segments: 1 });
  kit.plane("marks", 0.064, 0.016, { position: [Math.max(0.2, L - 0.14), 0.05, PS - 0.0028], rotation: [0, Math.PI, 0] });

  // Heavy / rail: vent cut-outs along the shroud (dark recesses + fins).
  if (spec.vents) {
    const count = Math.floor((L - 0.34) / 0.07);
    for (let i = 0; i < count; i++) {
      const x = 0.26 + i * 0.07;
      kit.box("dark", [0.05, 0.009, 0.0022], { position: [x, 0.058, PS - 0.001], radius: 0.001, segments: 1 });
      kit.box("dark", [0.05, 0.009, 0.0022], { position: [x, 0.058, -PS + 0.001], radius: 0.001, segments: 1 });
      kit.box("metal", [0.046, 0.0015, 0.002], { position: [x, 0.058, PS - 0.0016], radius: 0.0004, segments: 1 });
    }
  }

  // ── Ejection port: bolt carrier, chambered round, dust cover, handle ───
  kit.box("dark", [0.13, 0.032, 0.006], { position: [0.02, 0.03, -0.027], radius: 0.0025 });
  kit.box("chrome", [0.09, 0.015, 0.006], { position: [0.012, 0.035, -0.0285], radius: 0.0025 });
  for (let i = 0; i < 4; i++) {
    kit.box("metal", [0.0025, 0.016, 0.0065], { position: [-0.02 + i * 0.012, 0.035, -0.0288], radius: 0.0006, segments: 1 });
  }
  kit.box("metal", [0.012, 0.006, 0.004], { position: [0.052, 0.042, -0.0298], radius: 0.001, segments: 1 }); // extractor
  kit.tube("brass", 0.0052, 0.024, "x", { position: [0.068, 0.023, -0.029], radial: 14 });
  kit.cylinder("copper", 0.0012, 0.0052, 0.012, { position: [0.086, 0.023, -0.029], rotation: [0, 0, -Math.PI / 2], radial: 14 });
  kit.tube("metal", 0.0018, 0.13, "x", { position: [0.02, 0.0125, -0.0305], radial: 8 }); // dust-cover hinge
  kit.box("body2", [0.13, 0.004, 0.004], { position: [0.02, 0.0095, -0.031], radius: 0.001, segments: 1 });
  kit.box("metal", [0.014, 0.01, 0.012], { position: [-0.052, 0.036, -0.031], radius: 0.003 }); // charging handle
  kit.tube("grip", 0.005, 0.012, "z", { position: [-0.052, 0.036, -0.041], radial: 14 });
  // Status LEDs + ammo screen bezel.
  kit.box("neon", [0.004, 0.004, 0.002], { position: [0.1, 0.055, PS - 0.001], radius: 0.001, segments: 1 });
  kit.box("warn", [0.004, 0.004, 0.002], { position: [0.108, 0.055, PS - 0.001], radius: 0.001, segments: 1 });
  kit.box("dark", [0.058, 0.032, 0.003], { position: [-0.08, 0.022, PS + 0.0006], radius: 0.002, segments: 1 });

  // ── Lower receiver ─────────────────────────────────────────────────────
  kit.profile("body2", [
    [-0.15, -0.004], [0.13, -0.004], [0.13, -0.03], [0.08, -0.055], [-0.02, -0.055], [-0.06, -0.035], [-0.15, -0.035],
  ], 0.05, { bevel: 0.003 });
  // Takedown pins, selector, mag release, markings.
  for (const x of [-0.12, 0.11]) {
    kit.tube("metal", 0.0038, 0.054, "z", { position: [x, -0.016, 0], radial: 12 });
  }
  kit.tube("metal", 0.006, 0.004, "z", { position: [-0.1, -0.02, -0.027], radial: 14 });
  kit.box("dark", [0.02, 0.005, 0.003], { position: [-0.092, -0.017, -0.0295], rotation: [0, 0, 0.35], radius: 0.0012, segments: 1 });
  kit.tube("dark", 0.0045, 0.004, "z", { position: [0.036, -0.03, -0.0265], radial: 12 });
  kit.plane("marks", 0.07, 0.0175, { position: [-0.03, -0.018, -0.0262], rotation: [0, Math.PI, 0] });
  // Trigger guard (extruded loop) + curved trigger.
  const guard = new THREE.Shape();
  guard.moveTo(-0.074, -0.032);
  guard.lineTo(-0.074, -0.068);
  guard.quadraticCurveTo(-0.074, -0.078, -0.064, -0.078);
  guard.lineTo(0.008, -0.078);
  guard.quadraticCurveTo(0.014, -0.078, 0.014, -0.07);
  guard.lineTo(0.014, -0.03);
  const guardHole = new THREE.Path();
  guardHole.moveTo(-0.066, -0.034);
  guardHole.lineTo(0.006, -0.034);
  guardHole.lineTo(0.006, -0.068);
  guardHole.quadraticCurveTo(0.006, -0.071, 0.002, -0.071);
  guardHole.lineTo(-0.062, -0.071);
  guardHole.quadraticCurveTo(-0.066, -0.071, -0.066, -0.066);
  guardHole.lineTo(-0.066, -0.034);
  guard.holes.push(guardHole);
  kit.shape("body2", guard, 0.016, { bevel: 0.002 });
  kit.box("chrome", [0.005, 0.016, 0.005], { position: [-0.03, -0.047, 0], rotation: [0, 0, -0.2], radius: 0.0018 });
  kit.box("chrome", [0.005, 0.01, 0.005], { position: [-0.027, -0.058, 0], rotation: [0, 0, 0.25], radius: 0.0018 });

  // Pistol grip (SMG / rail): polymer with a stippled rubber panel.
  if (spec.pistol) {
    kit.profile("grip", [
      [-0.06, -0.03], [-0.03, -0.03], [-0.05, -0.14], [-0.08, -0.146], [-0.092, -0.132], [-0.074, -0.05],
    ], 0.032, { bevel: 0.004 });
    kit.box("rubber", [0.026, 0.07, 0.003], { position: [-0.063, -0.09, -0.016], rotation: [0, 0, -0.22], radius: 0.0015 });
    kit.box("dark", [0.036, 0.008, 0.034], { position: [-0.084, -0.14, 0], rotation: [0, 0, -0.18], radius: 0.003 });
  }

  // ── Stock ──────────────────────────────────────────────────────────────
  if (spec.stock === "block") {
    kit.profile("body2", [
      [-0.15, 0.05], [-0.4, 0.045], [-0.42, 0.02], [-0.42, -0.1], [-0.3, -0.105], [-0.2, -0.06], [-0.15, -0.035],
    ], 0.052, { bevel: 0.003 });
    // Cheek riser + seam, thumb cut-out, code stencil.
    kit.profile("body", [[-0.16, 0.046], [-0.36, 0.042], [-0.37, 0.058], [-0.17, 0.064]], 0.046, { bevel: 0.003 });
    kit.box("dark", [0.2, 0.0018, 0.054], { position: [-0.26, 0.043, 0], radius: 0.0006, segments: 1 });
    kit.box("dark", [0.07, 0.028, 0.004], { position: [-0.195, -0.038, -0.025], radius: 0.01, segments: 3 });
    kit.plane("code", 0.09, 0.045, { position: [-0.31, -0.03, -0.0273], rotation: [0, Math.PI, 0] });
    screw(-0.2, 0.02, -0.0272);
    screw(-0.38, 0.02, -0.0272);
    // Lattice butt pad: frame + 9 × 5 bar grid.
    kit.box("dark", [0.016, 0.152, 0.054], { position: [-0.428, -0.028, 0], radius: 0.004 });
    for (let i = 0; i < 9; i++) {
      kit.box("rubber", [0.012, 0.0035, 0.054], { position: [-0.44, -0.1 + i * 0.018, 0], radius: 0.001, segments: 1 });
    }
    for (let i = 0; i < 5; i++) {
      kit.box("rubber", [0.012, 0.152, 0.0035], { position: [-0.44, -0.028, -0.024 + i * 0.012], radius: 0.001, segments: 1 });
    }
    // Sling loop.
    kit.torus("metal", 0.009, 0.0022, { position: [-0.37, -0.11, 0], rotation: [0, 0, 0], radial: 8, tubular: 20 });
  } else {
    // Skeleton folding stock (SMG): two struts, hinge, rubber pad.
    kit.box("body2", [0.26, 0.016, 0.022], { position: [-0.27, 0.035, 0], radius: 0.005 });
    kit.box("body2", [0.3, 0.015, 0.02], { position: [-0.27, -0.04, 0], rotation: [0, 0, 0.26], radius: 0.005 });
    kit.box("dark", [0.2, 0.004, 0.024], { position: [-0.27, 0.035, 0], radius: 0.0012, segments: 1 });
    kit.box("body", [0.03, 0.14, 0.04], { position: [-0.405, -0.02, 0], radius: 0.008 });
    kit.box("rubber", [0.01, 0.13, 0.042], { position: [-0.422, -0.02, 0], radius: 0.004 });
    kit.tube("metal", 0.009, 0.034, "z", { position: [-0.15, 0.035, 0], radial: 16 });
    kit.tube("dark", 0.004, 0.036, "z", { position: [-0.15, 0.035, 0], radial: 10 });
    kit.plane("code", 0.07, 0.035, { position: [0.3, 0.034, -0.031], rotation: [0, Math.PI, 0] });
  }

  // ── Magazine / power cell ──────────────────────────────────────────────
  if (spec.mag === "box" || spec.mag === "long") {
    const h = spec.mag === "long" ? 0.2 : 0.14;
    const mx = skeleton ? 0.07 : 0.08;
    const tilt = { rotation: [0, 0, 0.1] };
    // X of a point on the tilted mag at height y (tilt pivots on the mag centre).
    const yc = -0.04 - h / 2;
    const magX = (y, dx = 0) => mx + dx - (y - yc) * 0.1;
    // Magwell flare.
    kit.box("body2", [0.064, 0.022, 0.04], { position: [mx - 0.002, -0.05, 0], radius: 0.004 });
    kit.box("grip", [0.05, h, 0.03], { position: [mx, -0.04 - h / 2, 0], ...tilt, radius: 0.005 });
    // Side ribs on the lower half, witness window with the round stack.
    for (let i = 0; i < 4; i++) {
      const y = -0.04 - h * 0.66 - i * 0.012;
      kit.box("dark", [0.052, 0.005, 0.032], { position: [magX(y), y, 0], ...tilt, radius: 0.0015, segments: 1 });
    }
    const windowY = -0.04 - h * 0.3;
    kit.box("dark", [0.024, h * 0.46, 0.002], { position: [magX(windowY, 0.004), windowY, -0.0152], ...tilt, radius: 0.002, segments: 1 });
    kit.box("glass", [0.018, h * 0.42, 0.002], { position: [magX(windowY, 0.004), windowY, -0.0162], ...tilt, radius: 0.001, segments: 1 });
    for (let i = 0; i < 5; i++) {
      const y = -0.04 - h * 0.12 - i * h * 0.084;
      kit.tube("brass", 0.0034, 0.014, "x", {
        position: [magX(y, 0.004), y, -0.0156],
        rotation: [0, 0, 0.1 + Math.PI / 2],
        radial: 10,
      });
    }
    kit.box("body2", [0.06, 0.012, 0.036], { position: [magX(-0.045 - h, -0.004), -0.045 - h, 0], ...tilt, radius: 0.004 });
  } else if (spec.mag === "cell") {
    // Rail: energy cell in the lower, glowing through three windows.
    kit.box("dark", [0.09, 0.04, 0.04], { position: [0.08, -0.03, 0], radius: 0.008 });
    kit.box("metal", [0.094, 0.006, 0.042], { position: [0.08, -0.012, 0], radius: 0.002 });
    for (let i = 0; i < 3; i++) {
      kit.box("neon", [0.016, 0.018, 0.002], { position: [0.053 + i * 0.026, -0.032, -0.0205], radius: 0.002 });
    }
  }

  // ── D-loop foregrip ────────────────────────────────────────────────────
  if (spec.grip === "loop") {
    const gx = skeleton ? 0.2 : 0.24;
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
    kit.shape("body2", loop, 0.034, { bevel: 0.004, curveSegments: 16 });
    kit.box("rubber", [0.012, 0.07, 0.037], { position: [gx - 0.036, -0.07, 0], rotation: [0, 0, -0.2], radius: 0.005 });
    screw(gx + 0.05, -0.02, -0.0182);
  }

  // ── Under-rod: long housing with a recessed channel ────────────────────
  const rodStart = spec.grip === "loop" ? (skeleton ? 0.3 : 0.36) : 0.16;
  if (L - 0.02 > rodStart + 0.05) {
    const rodLength = L - 0.02 - rodStart;
    const cx = rodStart + rodLength / 2;
    kit.box("body2", [rodLength, 0.032, 0.044], { position: [cx, -0.02, 0], radius: 0.004 });
    kit.box("dark", [rodLength - 0.03, 0.012, 0.004], { position: [cx, -0.02, -0.0212], radius: 0.0015, segments: 1 });
    kit.box("metal", [rodLength - 0.034, 0.003, 0.004], { position: [cx, -0.02, -0.0222], radius: 0.0008, segments: 1 });
    kit.box("dark", [0.006, 0.03, 0.046], { position: [L - 0.022, -0.02, 0], radius: 0.002, segments: 1 });
    kit.box("neon", [0.012, 0.003, 0.002], { position: [L - 0.04, -0.02, -0.0236], radius: 0.001, segments: 1 });
  }

  const ammoScreen = createAmmoScreen();
  kit.plane("screen", 0.05, 0.025, { position: [-0.08, 0.022, PS - 0.0014], rotation: [0, Math.PI, 0] });

  const inner = kit.build({
    ...getSharedMaterials(),
    code: codeMaterial(spec.code),
    marks: markingsMaterial(spec.code),
    screen: ammoScreen.material,
  }, { name: `vx-${spec.code}` });
  inner.rotation.y = Math.PI / 2;

  const muzzle = new THREE.Object3D();
  muzzle.position.set(L + 0.01, 0.03, 0);
  muzzle.rotation.y = Math.PI / 2;
  inner.add(muzzle);

  // ── Hand anchors (gun-local: +X muzzle, +Y up, −Z player side) ─────────
  // Each anchor is the palm-centre frame of a hand: local +Y = finger
  // direction, +Z = back of the hand, curl wraps toward −Z.
  const anchors = {
    right: handAnchor(inner, spec.pistol ? RIGHT_PISTOL : RIGHT_STOCK),
    left: handAnchor(inner, spec.grip === "loop" ? leftLoop(spec.stock === "skeleton" ? 0.2 : 0.24) : leftRail(L)),
    mag: handAnchor(inner, spec.mag === "cell" ? MAG_CELL : magBox(spec.stock === "skeleton" ? 0.07 : 0.08, spec.mag === "long" ? 0.2 : 0.14)),
  };

  const root = new THREE.Group();
  root.name = `gun-${specId}`;
  root.add(inner);
  return { root, muzzle, drawAmmo: ammoScreen.draw, length: L, anchors };
}

/** @param {"carbine"|"smg"|"rail"|"heavy"} id */
export function createGunModel(id) {
  return buildGun(id);
}
