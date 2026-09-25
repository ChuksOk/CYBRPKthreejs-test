import * as THREE from "three/webgpu";
import { color, float, fract, time, uv } from "three/tsl";
import { createPartKit } from "./modelKit.js";
import { carbon, chrome, emissive, glass, gunmetal, hazard, paint, rubber } from "./materials.js";

/**
 * Procedural military drones (front = +Z, up = +Y, ~0.9 m base span).
 * Materials are shared per archetype; per-drone hit flash / sensor glow /
 * accent color come from mesh.userData.fx via onObjectUpdate uniforms.
 */

const TYPE_STYLE = {
  scout: { paint: 0x737a84, arms: 4, armRadius: 0.45, body: [0.3, 0.1, 0.44] },
  gunship: { paint: 0x3a4137, arms: 6, armRadius: 0.5, body: [0.38, 0.13, 0.52] },
  kamikaze: { paint: 0x1f2125, arms: 4, armRadius: 0.4, body: [0.22, 0.09, 0.4] },
};

function rotorMaterial() {
  const material = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
  const centered = uv().sub(0.5);
  const radius = centered.length().mul(2);
  const angle = centered.y.atan(centered.x).div(Math.PI * 2).add(0.5);
  const blades = fract(angle.mul(3).add(time.mul(9)));
  const blade = blades.smoothstep(0.0, 0.08).mul(float(1).sub(blades.smoothstep(0.1, 0.42)));
  const disc = float(1).sub(radius.smoothstep(0.9, 1));
  const hubMask = radius.smoothstep(0.12, 0.2);
  const alpha = blade.mul(0.55).add(0.08).mul(disc).mul(hubMask);
  material.colorNode = color(0x2a2d33);
  material.emissiveNode = color(0x9aa3b0).mul(blade).mul(0.08).mul(disc);
  material.opacityNode = alpha;
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  return material;
}

const materialCache = new Map();

function getMaterials(typeId) {
  if (materialCache.has(typeId)) {
    return materialCache.get(typeId);
  }
  const style = TYPE_STYLE[typeId];
  const materials = {
    paint: paint({ tint: style.paint, roughness: typeId === "gunship" ? 0.55 : 0.4, flashKey: "flash" }),
    carbon: carbon(),
    metal: gunmetal({ tint: 0x2a2d32, roughness: 0.34 }),
    chrome: chrome(),
    rubber: rubber(),
    glass: glass({ tint: 0x05070a }),
    hazard: hazard({ flashKey: "flash" }),
    rotor: rotorMaterial(),
    visor: emissive(0xff2d55, 1.25, { gainKey: "glow", colorKey: "color" }),
    navRed: emissive(0xff1a2e, 5, { blink: { rate: 1.1, duty: 0.55, phase: 0 } }),
    navGreen: emissive(0x1aff6a, 5, { blink: { rate: 1.1, duty: 0.55, phase: 0.5 } }),
    strobe: emissive(0xffffff, 12, { blink: { rate: 1.4, duty: 0.07, phase: 0.2 } }),
  };
  materialCache.set(typeId, materials);
  return materials;
}

export function createDroneModel(typeId) {
  const style = TYPE_STYLE[typeId] ?? TYPE_STYLE.scout;
  const kit = createPartKit();
  const [bw, bh, bd] = style.body;

  // ── Fuselage ────────────────────────────────────────────────────────────
  kit.box("paint", [bw, bh, bd], { radius: 0.03 });
  kit.sphere("paint", 0.14, { position: [0, bh * 0.42, -0.02], scale: [bw / 0.3, 0.32, (bd / 0.44) * 1.35] });
  kit.box("carbon", [bw * 0.66, 0.05, bd * 0.6], { position: [0, -bh * 0.62, -0.02], radius: 0.012 });
  // Panel seams + vents.
  for (const x of [-bw * 0.28, bw * 0.28]) {
    kit.box("rubber", [0.004, 0.004, bd * 0.8], { position: [x, bh * 0.5 + 0.001, 0], radius: 0.001, segments: 1 });
  }
  for (let i = 0; i < 4; i++) {
    for (const x of [-bw * 0.5, bw * 0.5]) {
      kit.box("rubber", [0.006, 0.012, 0.05], { position: [x, 0, -0.1 + i * 0.03], radius: 0.002, segments: 1 });
    }
  }
  // Rear antenna + GPS puck.
  kit.tube("metal", 0.003, 0.12, "y", { position: [-bw * 0.3, bh * 0.5 + 0.06, -bd * 0.4] });
  kit.tube("paint", 0.028, 0.012, "y", { position: [bw * 0.2, bh * 0.5 + 0.01, -bd * 0.3] });

  // ── Sensor visor + gimbal camera ────────────────────────────────────────
  kit.box("glass", [bw * 0.72, bh * 0.36, 0.02], { position: [0, bh * 0.12, bd * 0.5 - 0.004], radius: 0.006 });
  kit.box("visor", [bw * 0.6, 0.012, 0.008], { position: [0, bh * 0.12, bd * 0.5 + 0.008], radius: 0.003 });
  kit.box("metal", [0.05, 0.03, 0.05], { position: [0, -bh * 0.55, bd * 0.36], radius: 0.01 });
  kit.sphere("metal", 0.055, { position: [0, -bh * 0.9, bd * 0.38] });
  kit.tube("glass", 0.03, 0.03, "z", { position: [0, -bh * 0.9, bd * 0.38 + 0.05], radial: 24 });
  kit.torus("visor", 0.022, 0.004, { position: [0, -bh * 0.9, bd * 0.38 + 0.066], tubular: 28 });

  // ── Arms, motors, ducts, rotors ─────────────────────────────────────────
  const r = style.armRadius;
  for (let i = 0; i < style.arms; i++) {
    const angle =
      style.arms === 4
        ? Math.PI / 4 + (i * Math.PI) / 2 + (typeId === "kamikaze" ? 0 : 0.05 * (i % 2 ? 1 : -1))
        : (i * Math.PI * 2) / 6 + Math.PI / 6;
    const x = Math.sin(angle) * r;
    const z = Math.cos(angle) * r;
    const armLength = r - 0.08;
    kit.box("carbon", [0.05, 0.035, armLength], {
      position: [x * 0.5, 0.005, z * 0.5],
      rotation: [0, angle, 0],
      radius: 0.012,
    });
    kit.tube("metal", 0.036, 0.05, "y", { position: [x, 0.03, z], radial: 22 });
    kit.tube("chrome", 0.012, 0.016, "y", { position: [x, 0.062, z], radial: 14 });
    const duct = typeId === "kamikaze" ? "hazard" : "paint";
    kit.torus(duct, 0.165, 0.016, { position: [x, 0.045, z], rotation: [Math.PI / 2, 0, 0], tubular: 44, radial: 10 });
    kit.box("carbon", [0.33, 0.008, 0.012], { position: [x, 0.03, z], rotation: [0, angle + Math.PI / 2, 0], radius: 0.003, segments: 1 });
    kit.circle("rotor", 0.15, { position: [x, 0.058, z], rotation: [-Math.PI / 2, 0, 0], segments: 40 });
    // Nav lights on the outer duct rim: red port (-X), green starboard.
    kit.sphere(x < 0 ? "navRed" : "navGreen", 0.012, {
      position: [x + Math.sin(angle) * 0.17, 0.045, z + Math.cos(angle) * 0.17],
      width: 10,
      height: 8,
    });
    // Landing strut.
    kit.box("rubber", [0.014, 0.08, 0.014], { position: [x * 0.55, -0.07, z * 0.55], radius: 0.005 });
  }
  kit.sphere("strobe", 0.014, { position: [0, bh * 0.5 + 0.045, 0.02], width: 10, height: 8 });

  // ── Weapons by archetype ────────────────────────────────────────────────
  if (typeId === "scout") {
    kit.box("metal", [0.05, 0.04, 0.12], { position: [0, -bh * 0.75, 0.05], radius: 0.01 });
    kit.tube("metal", 0.011, 0.2, "z", { position: [0, -bh * 0.8, 0.2], radial: 16 });
    kit.torus("visor", 0.012, 0.003, { position: [0, -bh * 0.8, 0.301], tubular: 20 });
  } else if (typeId === "gunship") {
    // Armor cheek plates.
    for (const x of [-bw * 0.56, bw * 0.56]) {
      kit.box("paint", [0.03, bh * 0.9, bd * 0.7], { position: [x, 0, 0.02], rotation: [0, 0, x < 0 ? 0.12 : -0.12], radius: 0.01 });
      kit.box("hazard", [0.032, 0.02, bd * 0.5], { position: [x, bh * 0.34, 0.04], radius: 0.004 });
    }
    // Twin rotary cannons.
    for (const side of [-1, 1]) {
      const gx = side * 0.12;
      kit.box("metal", [0.07, 0.06, 0.12], { position: [gx, -bh * 0.8, 0.12], radius: 0.012 });
      for (let b = 0; b < 3; b++) {
        const a = (b / 3) * Math.PI * 2;
        kit.tube("metal", 0.008, 0.24, "z", {
          position: [gx + Math.cos(a) * 0.016, -bh * 0.8 + Math.sin(a) * 0.016, 0.3],
          radial: 10,
        });
      }
      kit.torus("chrome", 0.024, 0.005, { position: [gx, -bh * 0.8, 0.36], tubular: 20 });
      kit.torus("visor", 0.02, 0.003, { position: [gx, -bh * 0.8, 0.425], tubular: 20 });
    }
  } else if (typeId === "kamikaze") {
    // Shaped-charge warhead with hazard paint.
    kit.cylinder("hazard", 0.03, 0.075, 0.18, { position: [0, -0.01, bd * 0.5 + 0.1], rotation: [Math.PI / 2, 0, 0], radial: 20 });
    kit.cylinder("metal", 0.006, 0.03, 0.05, { position: [0, -0.01, bd * 0.5 + 0.215], rotation: [Math.PI / 2, 0, 0], radial: 14 });
    kit.sphere("visor", 0.01, { position: [0, 0.03, bd * 0.5 + 0.12], width: 10, height: 8 });
    kit.box("hazard", [bw * 1.02, 0.02, 0.05], { position: [0, bh * 0.3, -bd * 0.2], radius: 0.005 });
  }

  const root = kit.build(getMaterials(typeId), { name: `drone-${typeId}` });
  // Rotor discs render after the airframe.
  for (const mesh of root.children) {
    if (mesh.name.endsWith(":rotor")) {
      mesh.renderOrder = 2;
    }
  }
  return root;
}
