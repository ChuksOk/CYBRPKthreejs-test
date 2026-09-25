import * as THREE from "three/webgpu";
import {
  abs,
  color,
  float,
  fract,
  mix,
  mx_noise_float,
  normalView,
  positionLocal,
  positionViewDirection,
  step,
  time,
  uniform,
  vec3,
} from "three/tsl";

/**
 * PBR materials for the procedural rifle and drones. Surface detail
 * (anodizing variation, stipple, carbon weave, hazard paint, wear) comes
 * from TSL noise on positionLocal, so there are no textures to load and
 * the scene's env map / neon lights provide the realism.
 */

const micro = (scale, amount) => mx_noise_float(positionLocal.mul(scale)).mul(amount);

/** Per-object scalar read from mesh.userData.fx (drone flash / glow). */
export function objectFx(key, fallback = 0) {
  return uniform(fallback).onObjectUpdate(({ object }) => object.userData.fx?.[key] ?? fallback);
}

export function gunmetal({ tint = 0x2b2e34, roughness = 0.3 } = {}) {
  const material = new THREE.MeshStandardNodeMaterial({ color: tint, metalness: 0.9 });
  material.roughnessNode = float(roughness).add(micro(220, 0.05)).add(micro(14, 0.08)).clamp(0.08, 1);
  material.colorNode = color(tint).mul(float(1).add(micro(9, 0.12)));
  return material;
}

export function cerakote({ tint = 0x3a3d42, roughness = 0.5 } = {}) {
  const material = new THREE.MeshStandardNodeMaterial({ color: tint, metalness: 0.35 });
  material.roughnessNode = float(roughness).add(micro(300, 0.08)).clamp(0.2, 1);
  material.colorNode = color(tint).mul(float(1).add(micro(6, 0.1)));
  return material;
}

export function polymer({ tint = 0x16181c } = {}) {
  const material = new THREE.MeshStandardNodeMaterial({ color: tint, metalness: 0 });
  // Stippled grip texture: high-frequency roughness breakup.
  material.roughnessNode = float(0.66).add(micro(420, 0.18)).clamp(0.3, 1);
  return material;
}

export function rubber() {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0x0b0b0c, metalness: 0 });
  material.roughnessNode = float(0.9).add(micro(500, 0.05));
  return material;
}

export function chrome({ tint = 0x8f949b } = {}) {
  const material = new THREE.MeshStandardNodeMaterial({ color: tint, metalness: 1 });
  material.roughnessNode = float(0.16).add(micro(60, 0.05));
  return material;
}

/** Twill carbon fibre from local position (works on merged geometry). */
export function carbon({ scale = 90 } = {}) {
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0.25 });
  const p = positionLocal.mul(scale);
  const weave = step(0.5, fract(p.x.add(p.y).add(p.z.mul(0.5)).floor().mul(0.5)));
  const fibre = abs(fract(p.x.add(p.z).mul(2)).sub(0.5)).mul(2);
  material.colorNode = mix(color(0x0d0e11), color(0x262a31), weave.mul(0.7).add(fibre.mul(0.3)));
  material.roughnessNode = mix(float(0.24), float(0.46), weave);
  return material;
}

/** Painted panels with slight chipping toward bare metal. */
export function paint({ tint = 0x9aa1ab, roughness = 0.42, flashKey = null, wear: wearAmount = 1, rimKey = null, selfLit = 0 } = {}) {
  const material = new THREE.MeshStandardNodeMaterial({ color: tint });
  const chips = mx_noise_float(positionLocal.mul(38)).add(mx_noise_float(positionLocal.mul(160)).mul(0.4));
  const wear = chips.smoothstep(0.55, 0.75).mul(wearAmount);
  material.colorNode = mix(color(tint).mul(float(1).add(micro(5, 0.08))), color(0x4b4f55), wear);
  material.metalnessNode = mix(float(0.18), float(0.85), wear);
  material.roughnessNode = mix(float(roughness), float(0.3), wear).add(micro(260, 0.05));
  let emissiveNode = null;
  if (flashKey) {
    emissiveNode = vec3(1, 0.93, 0.85).mul(objectFx(flashKey)).mul(1.6);
  }
  if (rimKey) {
    // Fresnel rim in the drone's accent color so silhouettes read at night.
    const rimColor = uniform(new THREE.Color(0xffffff)).onObjectUpdate(({ object }) => object.userData.fx?.[rimKey]);
    const rim = float(1).sub(normalView.dot(positionViewDirection).abs()).pow(2.2);
    const rimNode = rimColor.mul(rim).mul(objectFx("rim", 1.6));
    emissiveNode = emissiveNode ? emissiveNode.add(rimNode) : rimNode;
  }
  if (selfLit > 0) {
    const lit = color(tint).mul(selfLit);
    emissiveNode = emissiveNode ? emissiveNode.add(lit) : lit;
  }
  if (emissiveNode) {
    material.emissiveNode = emissiveNode;
  }
  return material;
}

export function hazard({ a = 0xe8c21a, b = 0x111214, scale = 14, flashKey = null } = {}) {
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0.2 });
  const p = positionLocal.mul(scale);
  const stripe = step(0.5, fract(p.x.add(p.y).add(p.z)));
  material.colorNode = mix(color(b), color(a), stripe);
  material.roughnessNode = float(0.45).add(micro(200, 0.08));
  if (flashKey) {
    material.emissiveNode = vec3(1, 0.93, 0.85).mul(objectFx(flashKey)).mul(1.6);
  }
  return material;
}

export function concrete({ tint = 0x8b8a85 } = {}) {
  const material = new THREE.MeshStandardNodeMaterial({ color: tint, metalness: 0 });
  const grime = mx_noise_float(positionLocal.mul(3)).mul(0.5).add(0.5);
  material.colorNode = color(tint).mul(float(0.72).add(micro(40, 0.12)).add(grime.mul(0.25)));
  material.roughnessNode = float(0.86).add(micro(300, 0.08));
  return material;
}

export function glass({ tint = 0x06080c } = {}) {
  const material = new THREE.MeshStandardNodeMaterial({ color: tint, metalness: 0.3, roughness: 0.04 });
  return material;
}

/** Unlit emissive (blooms via the emissive MRT). Optional per-object gain. */
export function emissive(hex, strength = 4, { gainKey = null, blink = null, colorKey = null } = {}) {
  const material = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
  let node = colorKey
    ? uniform(new THREE.Color(hex)).onObjectUpdate(({ object }) => object.userData.fx?.[colorKey])
    : color(hex);
  node = node.mul(strength);
  if (gainKey) {
    node = node.mul(objectFx(gainKey, 1));
  }
  if (blink) {
    node = node.mul(step(1 - blink.duty, fract(time.mul(blink.rate).add(blink.phase ?? 0))));
  }
  material.emissiveNode = node;
  material.toneMapped = false;
  return material;
}
