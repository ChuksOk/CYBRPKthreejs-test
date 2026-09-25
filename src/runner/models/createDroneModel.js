import * as THREE from "three/webgpu";
import { color, float, fract, texture, time, uv } from "three/tsl";
import { createPartKit, ringShape, roundedPolygon } from "./modelKit.js";
import { carbon, chrome, emissive, gunmetal, paint, rubber } from "./materials.js";

/**
 * "GIGI" drone family, after the concept sheet: chunky glossy shells with
 * thick rounded-hexagon or round ducts, dark inner rims, chrome frames and
 * the GIGI logo. Front = +Z, up = +Y, meters.
 *
 * Variants per archetype (see DRONE_VARIANTS):
 *   gold  — hex bi-copter, chrome inner frames          (kamikaze)
 *   blue  — bi-copter with canted hex ducts + fins      (kamikaze)
 *   red   — spider quad with dark round ducts           (gunship)
 *   teal  — disc quad with recessed rotors + claw pod   (scout)
 *   white — twin-duct lifter with a robotic arm         (scout)
 *
 * Materials are shared per variant; hit flash / sensor glow / accent color
 * are per mesh via userData.fx (onObjectUpdate uniforms).
 */

export const DRONE_VARIANTS = {
  scout: ["teal", "white"],
  gunship: ["red"],
  kamikaze: ["gold", "blue"],
};

const SHELL = {
  gold: { tint: 0xf2a516, logo: "dark" },
  blue: { tint: 0x239ae6, logo: "gold" },
  red: { tint: 0xd41c4a, logo: "green" },
  teal: { tint: 0x17a596, logo: "dark" },
  white: { tint: 0xd8dce1, logo: "dark" },
};

const LOGO_COLORS = { dark: "#15171b", green: "#3ddc6a", gold: "#ffc21a" };
const logoTextures = new Map();

function logoTexture(style) {
  if (logoTextures.has(style)) {
    return logoTextures.get(style);
  }
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, 256, 96);
  ctx.save();
  ctx.transform(1, 0, -0.22, 1, 18, 0);
  ctx.font = "800 78px 'Barlow Condensed', 'Arial Black', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 8;
  ctx.strokeStyle = style === "dark" ? "rgba(255,255,255,0.35)" : "#0d0f12";
  ctx.strokeText("GIGI", 128, 52);
  ctx.fillStyle = LOGO_COLORS[style];
  ctx.fillText("GIGI", 128, 52);
  ctx.restore();
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  logoTextures.set(style, map);
  return map;
}

function logoMaterial(style) {
  const map = logoTexture(style);
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0.1, roughness: 0.35 });
  const sample = texture(map);
  material.colorNode = sample.rgb;
  material.opacityNode = sample.a;
  material.emissiveNode = sample.rgb.mul(style === "dark" ? 0 : 0.8);
  material.transparent = true;
  material.alphaTest = 0.2;
  material.depthWrite = false;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  return material;
}

function rotorMaterial() {
  const material = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
  const centered = uv().sub(0.5);
  const radius = centered.length().mul(2);
  const angle = centered.y.atan(centered.x).div(Math.PI * 2).add(0.5);
  const blades = fract(angle.mul(3).add(time.mul(9)));
  const blade = blades.smoothstep(0.0, 0.08).mul(float(1).sub(blades.smoothstep(0.1, 0.42)));
  const disc = float(1).sub(radius.smoothstep(0.9, 1));
  const hubMask = radius.smoothstep(0.12, 0.2);
  material.colorNode = color(0x2a2d33);
  material.emissiveNode = color(0x9aa3b0).mul(blade).mul(0.08).mul(disc);
  material.opacityNode = blade.mul(0.55).add(0.08).mul(disc).mul(hubMask);
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  return material;
}

const materialCache = new Map();

function getMaterials(variant) {
  if (materialCache.has(variant)) {
    return materialCache.get(variant);
  }
  const shell = SHELL[variant];
  const materials = {
    // Glossy candy shell, like the concept renders.
    shell: paint({ tint: shell.tint, roughness: 0.2, flashKey: "flash", wear: 0.15 }),
    rim: paint({ tint: 0x17191d, roughness: 0.28, flashKey: "flash", wear: 0.1 }),
    chrome: chrome({ tint: 0xb8bec6 }),
    metal: gunmetal({ tint: 0x2c2f35, roughness: 0.3 }),
    brass: chrome({ tint: 0xc8a14a }),
    carbon: carbon(),
    rubber: rubber(),
    rotor: rotorMaterial(),
    logo: logoMaterial(shell.logo),
    visor: emissive(0xff2d55, 1.25, { gainKey: "glow", colorKey: "color" }),
    navRed: emissive(0xff1a2e, 5, { blink: { rate: 1.1, duty: 0.55, phase: 0 } }),
    navGreen: emissive(0x1aff6a, 5, { blink: { rate: 1.1, duty: 0.55, phase: 0.5 } }),
  };
  materialCache.set(variant, materials);
  return materials;
}

const FLAT = [-Math.PI / 2, 0, 0];

/** Thick duct (hex or round) laid flat at (x, y, z) with tilt, plus rotor. */
function duct(kit, { x = 0, y = 0, z = 0, outer, inner, depth, sides = 6, tiltZ = 0, tiltX = 0, shellKey = "shell", frame = false }) {
  const rotation = [FLAT[0] + tiltX, 0, tiltZ];
  // Thick colored outer shell + dark inner lip slightly deeper.
  kit.shape(shellKey, ringShape(outer, inner, sides, outer * 0.22), depth, { position: [x, y, z], rotation, bevel: depth * 0.28 });
  kit.shape("rim", ringShape(inner + 0.004, inner * 0.9, sides, inner * 0.2), depth * 1.12, { position: [x, y, z], rotation, bevel: 0.006 });
  if (frame) {
    // Chrome inner frame (gold drone): second hex ring + cross struts.
    kit.shape("chrome", ringShape(inner * 0.86, inner * 0.74, sides, inner * 0.16), depth * 0.5, { position: [x, y + 0.004, z], rotation, bevel: 0.004 });
  }
  const up = new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(tiltX, 0, tiltZ));
  kit.box("chrome", [inner * 1.7, 0.012, 0.018], { position: [x, y, z], rotation: [tiltX, 0.6, tiltZ], radius: 0.004 });
  kit.tube("metal", 0.03, 0.05, "y", { position: [x, y, z], rotation: [tiltX, 0, tiltZ] });
  kit.circle("rotor", inner * 0.86, {
    position: [x + up.x * depth * 0.2, y + up.y * depth * 0.2, z + up.z * depth * 0.2],
    rotation: [-Math.PI / 2 + tiltX, 0, tiltZ],
    segments: 40,
  });
}

function logo(kit, position, rotation, size = [0.2, 0.075]) {
  kit.plane("logo", size[0], size[1], { position, rotation });
}

function eye(kit, position, radius = 0.028) {
  kit.sphere("metal", radius * 1.5, { position });
  kit.tube("visor", radius, 0.012, "z", { position: [position[0], position[1], position[2] + radius * 1.2], radial: 20 });
}

function buildGold(kit, { blue = false, kamikaze = true } = {}) {
  // Two hex ducts side by side (blue variant cants them outward).
  const tilt = blue ? 0.38 : 0;
  for (const side of [-1, 1]) {
    duct(kit, {
      x: side * (blue ? 0.36 : 0.32),
      y: blue ? 0.04 : 0,
      outer: 0.3,
      inner: 0.21,
      depth: 0.1,
      sides: 6,
      tiltZ: -side * tilt,
      frame: !blue,
    });
  }
  // Center spine / body.
  if (blue) {
    // Wedge body: extruded side profile + tail fins.
    kit.profile("shell", [[-0.2, -0.05], [0.24, -0.02], [0.26, 0.04], [-0.12, 0.09], [-0.22, 0.05]], 0.2, {
      rotation: [0, -Math.PI / 2, 0],
      bevel: 0.02,
    });
    for (const side of [-1, 1]) {
      kit.box("rim", [0.012, 0.14, 0.1], { position: [side * 0.07, 0.13, -0.15], rotation: [0.35, 0, side * 0.15], radius: 0.004 });
    }
    kit.box("rim", [0.16, 0.05, 0.08], { position: [0, -0.07, 0.02], radius: 0.02 });
    logo(kit, [0, 0.078, 0.03], [-Math.PI / 2 + 0.25, 0, 0], [0.22, 0.08]);
  } else {
    kit.box("rim", [0.18, 0.11, 0.26], { position: [0, 0, 0], radius: 0.04 });
    kit.box("chrome", [0.5, 0.03, 0.05], { position: [0, 0.03, 0], radius: 0.012 });
    kit.tube("chrome", 0.02, 0.14, "y", { position: [0, 0.1, -0.04] });
    kit.box("rim", [0.04, 0.08, 0.04], { position: [0, 0.16, -0.04], radius: 0.01 });
    logo(kit, [0.32, 0.052, 0.2], [-Math.PI / 2, 0, 0], [0.3, 0.11]);
  }
  eye(kit, [0, -0.02, blue ? 0.25 : 0.14], 0.026);
  if (kamikaze) {
    // Payload canister slung underneath.
    kit.cylinder("metal", 0.05, 0.05, 0.22, { position: [0, -0.1, 0.02], rotation: [Math.PI / 2, 0, 0], radial: 18 });
    kit.sphere("visor", 0.012, { position: [0, -0.1, 0.135], width: 10, height: 8 });
  }
  kit.sphere("navRed", 0.013, { position: [-0.58, 0.02, 0], width: 10, height: 8 });
  kit.sphere("navGreen", 0.013, { position: [0.58, 0.02, 0], width: 10, height: 8 });
}

function buildRed(kit) {
  // Dark core with a red spider exoframe.
  kit.sphere("rim", 0.17, { position: [0, 0, 0], scale: [1, 0.62, 1.15] });
  const armAngles = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
  for (const a of armAngles) {
    const x = Math.sin(a) * 0.46;
    const z = Math.cos(a) * 0.4;
    // Curved red arm: two segments rising then dropping to the duct.
    kit.box("shell", [0.07, 0.06, 0.3], { position: [x * 0.4, 0.08, z * 0.4], rotation: [0.35 * Math.sign(z), a, 0], radius: 0.025 });
    kit.box("shell", [0.06, 0.05, 0.2], { position: [x * 0.78, 0.07, z * 0.78], rotation: [-0.3 * Math.sign(z), a, 0], radius: 0.02 });
    duct(kit, { x, y: 0.02, z, outer: 0.19, inner: 0.15, depth: 0.075, sides: 32, shellKey: "rim" });
    kit.shape("brass", ringShape(0.152, 0.138, 32), 0.03, { position: [x, 0.05, z], rotation: FLAT, bevel: 0.003 });
    logo(kit, [x, 0.061, z], [-Math.PI / 2, 0, x < 0 ? 0.3 : -0.3], [0.26, 0.095]);
  }
  // Red top ribs (the "spider" silhouette).
  for (const side of [-1, 1]) {
    kit.box("shell", [0.05, 0.08, 0.34], { position: [side * 0.09, 0.12, 0], rotation: [0, 0, side * -0.25], radius: 0.02 });
    kit.box("shell", [0.2, 0.05, 0.05], { position: [side * 0.12, 0.08, 0.2], rotation: [0, side * 0.5, 0], radius: 0.02 });
  }
  kit.box("shell", [0.12, 0.04, 0.26], { position: [0, 0.14, -0.02], radius: 0.018 });
  eye(kit, [0, -0.01, 0.18], 0.03);
  // Twin underslung cannons.
  for (const side of [-1, 1]) {
    kit.box("metal", [0.05, 0.05, 0.1], { position: [side * 0.08, -0.1, 0.1], radius: 0.012 });
    kit.tube("metal", 0.012, 0.22, "z", { position: [side * 0.08, -0.1, 0.24], radial: 12 });
    kit.torus("visor", 0.014, 0.003, { position: [side * 0.08, -0.1, 0.352], tubular: 18 });
  }
  kit.sphere("navRed", 0.013, { position: [-0.55, 0.02, 0.35], width: 10, height: 8 });
  kit.sphere("navGreen", 0.013, { position: [0.55, 0.02, 0.35], width: 10, height: 8 });
}

function buildTeal(kit) {
  // One disc shell with four recessed rotor wells.
  const disc = roundedPolygon(new THREE.Shape(), 0.52, 4, 0.2, Math.PI / 4);
  const wells = [[-0.2, -0.17], [0.2, -0.17], [-0.2, 0.17], [0.2, 0.17]];
  for (const [x, y] of wells) {
    const hole = new THREE.Path();
    hole.absarc(x, y, 0.13, 0, Math.PI * 2, true);
    disc.holes.push(hole);
  }
  kit.shape("shell", disc, 0.1, { rotation: FLAT, scale: [1.12, 1, 1], bevel: 0.03 });
  for (const [x, y] of wells) {
    const px = x * 1.12;
    const pz = -y;
    kit.cylinder("rim", 0.132, 0.132, 0.09, { position: [px, -0.005, pz], radial: 32, open: true });
    kit.tube("metal", 0.025, 0.04, "y", { position: [px, 0, pz] });
    kit.circle("rotor", 0.12, { position: [px, 0.02, pz], rotation: FLAT, segments: 36 });
  }
  logo(kit, [0, 0.056, 0.02], [-Math.PI / 2, 0, 0], [0.32, 0.12]);
  // Belly pod + claws.
  kit.sphere("shell", 0.15, { position: [0, -0.13, 0.02], scale: [1, 0.85, 1] });
  kit.box("rim", [0.2, 0.03, 0.2], { position: [0, -0.05, 0.02], radius: 0.012 });
  eye(kit, [0, -0.13, 0.15], 0.032);
  for (const side of [-1, 1]) {
    kit.box("metal", [0.035, 0.1, 0.035], { position: [side * 0.12, -0.2, 0.08], rotation: [0.3, 0, side * 0.35], radius: 0.012 });
    kit.box("rubber", [0.022, 0.06, 0.022], { position: [side * 0.15, -0.27, 0.12], rotation: [0.8, 0, side * -0.4], radius: 0.008 });
    kit.box("rubber", [0.022, 0.05, 0.022], { position: [side * 0.12, -0.27, 0.14], rotation: [1.1, 0, side * 0.3], radius: 0.008 });
  }
  kit.sphere("navRed", 0.012, { position: [-0.58, 0, 0], width: 10, height: 8 });
  kit.sphere("navGreen", 0.012, { position: [0.58, 0, 0], width: 10, height: 8 });
}

function buildWhite(kit) {
  // Twin round ducts canted up like ears, joined by a capsule body.
  for (const side of [-1, 1]) {
    duct(kit, { x: side * 0.22, y: 0.2, outer: 0.18, inner: 0.13, depth: 0.08, sides: 32, tiltZ: -side * 0.25 });
    kit.shape("brass", ringShape(0.135, 0.122, 32), 0.02, { position: [side * 0.22, 0.24, 0], rotation: [FLAT[0], 0, -side * 0.25], bevel: 0.002 });
  }
  kit.box("shell", [0.2, 0.3, 0.2], { position: [0, 0.06, 0], radius: 0.07 });
  // Dark oval window.
  kit.box("rim", [0.012, 0.16, 0.09], { position: [0.1, 0.06, 0.01], radius: 0.005 });
  kit.box("rim", [0.012, 0.16, 0.09], { position: [-0.1, 0.06, 0.01], radius: 0.005 });
  logo(kit, [0, 0.13, 0.101], [0, 0, 0], [0.18, 0.066]);
  eye(kit, [0, -0.02, 0.1], 0.026);
  // Robotic arm: shoulder, upper arm, elbow, forearm, wrist, claw.
  kit.sphere("rim", 0.055, { position: [0, -0.1, 0.02] });
  kit.tube("chrome", 0.03, 0.2, "y", { position: [0, -0.2, 0.06], rotation: [0.4, 0, 0] });
  kit.sphere("rim", 0.045, { position: [0, -0.3, 0.1] });
  kit.box("shell", [0.08, 0.2, 0.08], { position: [0, -0.37, 0.2], rotation: [-0.9, 0, 0], radius: 0.03 });
  kit.box("metal", [0.05, 0.05, 0.05], { position: [0, -0.43, 0.3], radius: 0.015 });
  for (const side of [-1, 1]) {
    kit.box("brass", [0.018, 0.08, 0.02], { position: [side * 0.022, -0.47, 0.35], rotation: [-0.7, 0, side * 0.25], radius: 0.006 });
  }
  kit.sphere("navRed", 0.012, { position: [-0.4, 0.2, 0], width: 10, height: 8 });
  kit.sphere("navGreen", 0.012, { position: [0.4, 0.2, 0], width: 10, height: 8 });
}

/**
 * @param {"scout"|"gunship"|"kamikaze"} typeId
 * @param {number} [variantIndex]
 */
export function createDroneModel(typeId, variantIndex = 0) {
  const variants = DRONE_VARIANTS[typeId] ?? DRONE_VARIANTS.scout;
  const variant = variants[variantIndex % variants.length];
  const kit = createPartKit();

  if (variant === "gold") {
    buildGold(kit, { blue: false });
  } else if (variant === "blue") {
    buildGold(kit, { blue: true });
  } else if (variant === "red") {
    buildRed(kit);
  } else if (variant === "teal") {
    buildTeal(kit);
  } else {
    buildWhite(kit);
  }

  const root = kit.build(getMaterials(variant), { name: `drone-${variant}` });
  for (const mesh of root.children) {
    if (mesh.name.endsWith(":rotor")) {
      mesh.renderOrder = 2;
    }
    if (mesh.name.endsWith(":logo")) {
      mesh.renderOrder = 3;
    }
  }
  root.userData.variant = variant;
  return root;
}
