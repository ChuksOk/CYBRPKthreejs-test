import * as THREE from "three/webgpu";
import { color, mx_noise_float, positionLocal } from "three/tsl";
import { getSharedMaterials } from "../runner/models/createGunModels.js";
import { VIEWMODEL_LAYER } from "../runner/runnerConfig.js";

/**
 * First-person gloved hands, fully procedural (no skinning): a palm, four
 * three-joint fingers and a two-joint thumb per hand, each a capsule on a
 * joint group so the fingers can curl. Tactical glove (fabric weave in TSL),
 * off-white knuckle armour with neon trim to match the VX guns, a strip of
 * skin at the wrist and a techwear sleeve running out of frame.
 *
 * Hands mount on anchors inside each gun (see createGunModels `anchors`), so
 * they inherit recoil, sway, bob and weapon switches for free. Animation:
 * trigger squeeze on each shot, left hand travels to the magazine and back
 * on reload, idle finger micro-motion.
 */

// Finger segment lengths (proximal, middle, distal) and radius, metres.
const FINGERS = [
  { name: "index", x: 0.029, y: 0.046, len: [0.044, 0.027, 0.022], r: 0.0098 },
  { name: "middle", x: 0.0095, y: 0.049, len: [0.049, 0.03, 0.023], r: 0.0102 },
  { name: "ring", x: -0.0095, y: 0.047, len: [0.046, 0.028, 0.022], r: 0.0097 },
  { name: "pinky", x: -0.028, y: 0.04, len: [0.035, 0.022, 0.019], r: 0.0088 },
];
// Joint curl (rad) for a full grip, per joint.
const GRIP_CURL = [1.25, 1.45, 0.95];

function fabricMaterial(hex, { roughness = 0.82, weave = 520 } = {}) {
  const material = new THREE.MeshStandardNodeMaterial({ roughness, metalness: 0 });
  const weaveNoise = mx_noise_float(positionLocal.mul(weave)).mul(0.5).add(0.5);
  const broad = mx_noise_float(positionLocal.mul(38)).mul(0.5).add(0.5);
  material.colorNode = color(hex).mul(weaveNoise.mul(0.22).add(broad.mul(0.12)).add(0.78));
  material.roughnessNode = weaveNoise.mul(0.12).add(roughness - 0.06);
  return material;
}

function skinMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.52, metalness: 0 });
  const pores = mx_noise_float(positionLocal.mul(900)).mul(0.5).add(0.5);
  material.colorNode = color(0xb57a58).mul(pores.mul(0.08).add(0.94));
  return material;
}

let materials = null;
function getMaterials() {
  if (!materials) {
    const gun = getSharedMaterials();
    materials = {
      glove: fabricMaterial(0x1c1e23),
      palm: fabricMaterial(0x2b2621, { roughness: 0.7, weave: 260 }),
      armor: gun.body,
      trim: gun.neon,
      dark: gun.dark,
      skin: skinMaterial(),
      sleeve: fabricMaterial(0x252833, { roughness: 0.88, weave: 340 }),
    };
  }
  return materials;
}

const _capsuleCache = new Map();
function capsule(radius, length) {
  const key = `${radius}|${length}`;
  if (!_capsuleCache.has(key)) {
    const geometry = new THREE.CapsuleGeometry(radius, Math.max(0.001, length - radius * 2), 4, 10);
    geometry.translate(0, length / 2, 0);
    _capsuleCache.set(key, geometry);
  }
  return _capsuleCache.get(key);
}

function roundedBox(w, h, d, r) {
  const shape = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + h - r);
  shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  shape.lineTo(x + r, y + h);
  shape.quadraticCurveTo(x, y + h, x, y + h - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: d - r,
    bevelEnabled: true,
    bevelThickness: r / 2,
    bevelSize: r / 2,
    bevelSegments: 3,
    curveSegments: 6,
  });
  geometry.translate(0, 0, -(d - r) / 2);
  geometry.computeVertexNormals();
  return geometry;
}

/** @param {1|-1} side  +1 = left hand (thumb toward +X), −1 = right hand */
function buildHand(side) {
  const m = getMaterials();
  const root = new THREE.Group();
  root.name = side > 0 ? "hand-left" : "hand-right";
  const add = (parent, geometry, material, position = [0, 0, 0], rotation = [0, 0, 0]) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    parent.add(mesh);
    return mesh;
  };

  // Palm (glove), palm pad (leather), back-of-hand armour plate + neon trim.
  add(root, roundedBox(0.084, 0.094, 0.03, 0.012), m.glove, [0, 0, 0]);
  add(root, roundedBox(0.074, 0.07, 0.008, 0.004), m.palm, [0, -0.004, -0.013]);
  add(root, roundedBox(0.066, 0.05, 0.008, 0.004), m.armor, [side * 0.002, 0.004, 0.016], [0.06, 0, 0]);
  add(root, new THREE.BoxGeometry(0.05, 0.0025, 0.002), m.trim, [side * 0.002, -0.016, 0.0205]);
  // Knuckle guard: a single curved bar across the knuckles.
  add(root, roundedBox(0.08, 0.016, 0.014, 0.006), m.armor, [0, 0.043, 0.012], [0.2, 0, 0]);
  add(root, new THREE.BoxGeometry(0.004, 0.004, 0.002), m.trim, [side * 0.03, 0.043, 0.02]);

  // Fingers: joint chains, curl about local X toward the palm (−Z).
  const fingers = FINGERS.map((spec) => {
    const joints = [];
    let parent = root;
    let y = spec.y;
    spec.len.forEach((length, i) => {
      const joint = new THREE.Group();
      joint.position.set(i === 0 ? side * -spec.x : 0, i === 0 ? y : spec.len[i - 1], i === 0 ? -0.002 : 0);
      parent.add(joint);
      const r = spec.r * (1 - i * 0.07);
      add(joint, capsule(r, length + r * 0.6), m.glove);
      // Armoured cap on the proximal segment.
      if (i === 0) {
        add(joint, roundedBox(r * 1.7, length * 0.55, 0.005, 0.002), m.armor, [0, length * 0.5, r * 0.85]);
      }
      joints.push(joint);
      parent = joint;
      y = 0;
    });
    return { joints, spec };
  });

  // Thumb: metacarpal from the heel of the palm on the thumb side, then two
  // segments; it folds across toward the palm.
  const thumbBase = new THREE.Group();
  thumbBase.position.set(side * 0.036, -0.022, -0.008);
  root.add(thumbBase);
  add(thumbBase, capsule(0.0125, 0.045), m.glove);
  const thumbMid = new THREE.Group();
  thumbMid.position.y = 0.043;
  thumbBase.add(thumbMid);
  add(thumbMid, capsule(0.0112, 0.034), m.glove);
  add(thumbMid, roundedBox(0.017, 0.018, 0.005, 0.002), m.armor, [0, 0.016, 0.0095]);
  const thumbTip = new THREE.Group();
  thumbTip.position.y = 0.032;
  thumbMid.add(thumbTip);
  add(thumbTip, capsule(0.0104, 0.028), m.glove);

  // Cuff, wrist skin, sleeve (runs back out of frame along −Y).
  const cuff = new THREE.CylinderGeometry(0.036, 0.034, 0.03, 18);
  add(root, cuff, m.glove, [0, -0.058, 0], [0, 0, 0]).scale.set(1.12, 1, 0.72);
  add(root, new THREE.TorusGeometry(0.035, 0.0022, 6, 24), m.trim, [0, -0.044, 0], [Math.PI / 2, 0, 0]).scale.set(1.12, 0.72, 1);
  add(root, new THREE.CylinderGeometry(0.03, 0.03, 0.024, 16), m.skin, [0, -0.083, 0]).scale.set(1.1, 1, 0.8);
  // Forearm: its own group at the wrist, aimed at an elbow point each frame
  // (built along +Z so Object3D.lookAt points it).
  const forearm = new THREE.Group();
  forearm.position.set(0, -0.09, 0);
  root.add(forearm);
  const sleeve = new THREE.CylinderGeometry(0.043, 0.056, 0.5, 18, 1, true);
  sleeve.translate(0, 0.25, 0);
  sleeve.rotateX(Math.PI / 2);
  add(forearm, sleeve, m.sleeve).scale.set(1.08, 0.9, 1);
  const ring = new THREE.CylinderGeometry(0.045, 0.045, 0.022, 18);
  ring.rotateX(Math.PI / 2);
  add(forearm, ring, m.dark, [0, 0, 0.006]).scale.set(1.08, 0.9, 1);
  const stripe = new THREE.BoxGeometry(0.003, 0.003, 0.36);
  stripe.translate(0, 0, 0.22);
  add(forearm, stripe, m.trim, [side * 0.046, 0.012, 0]);

  root.traverse((object) => {
    object.layers.set(VIEWMODEL_LAYER);
    object.frustumCulled = false;
  });

  function pose({ curl = 1, index = null, thumb = 1, spread = 0, time = 0 }) {
    fingers.forEach(({ joints }, f) => {
      // Idle micro-motion: each finger breathes slightly out of phase.
      const idle = Math.sin(time * 1.3 + f * 1.7) * 0.03;
      const amount = f === 0 && index != null ? index : curl;
      joints.forEach((joint, j) => {
        joint.rotation.x = -(GRIP_CURL[j] * amount + idle * (j + 1) * 0.5);
      });
      joints[0].rotation.z = side * (f - 1.5) * spread;
    });
    thumbBase.rotation.set(-0.55 - 0.35 * thumb, 0, -side * (0.95 - 0.25 * thumb));
    thumbMid.rotation.x = -0.35 * thumb;
    thumbTip.rotation.x = -0.45 * thumb;
  }

  pose({});
  return { root, pose, forearm };
}

const _elbow = new THREE.Vector3();
// Elbow targets in camera space (metres): out of frame, below and behind.
const ELBOW_RIGHT = new THREE.Vector3(0.3, -0.45, 0.12);
const ELBOW_LEFT = new THREE.Vector3(-0.1, -0.5, -0.02);

/** @param {{ rig: THREE.Object3D }} options  camera-aligned viewmodel rig */
export function createHands({ rig }) {
  const right = buildHand(-1);
  const left = buildHand(1);
  // Left hand rides on a mount that blends between grip and magazine anchors.
  const leftMount = new THREE.Group();
  leftMount.add(left.root);
  let gun = null;
  let time = 0;
  let squeeze = 0;
  const _q = new THREE.Quaternion();

  function attach(gunModel) {
    gun = gunModel;
    gunModel.anchors.right.add(right.root);
    gunModel.anchors.right.parent.add(leftMount);
    leftMount.layers.set(VIEWMODEL_LAYER);
  }

  function fire() {
    squeeze = 1;
  }

  /**
   * @param {number} delta
   * @param {number} reloadT  0..1 while reloading, −1 otherwise
   */
  function update(delta, reloadT = -1) {
    if (!gun) {
      return;
    }
    time += delta;
    squeeze = Math.max(0, squeeze - delta * 14);
    const { right: rightAnchor, left: gripAnchor, mag: magAnchor } = gun.anchors;

    right.pose({
      curl: rightAnchor.userData.curl,
      index: (rightAnchor.userData.index ?? 0.5) + squeeze * 0.35,
      thumb: 1,
      time,
    });

    // Reload path: grip → magazine (open hand) → grab + seat → back to grip.
    let toMag = 0;
    let grab = 1;
    let seat = 0;
    if (reloadT >= 0) {
      toMag = THREE.MathUtils.smoothstep(reloadT, 0.05, 0.28) * (1 - THREE.MathUtils.smoothstep(reloadT, 0.78, 0.96));
      grab = 1 - Math.sin(THREE.MathUtils.clamp((reloadT - 0.1) / 0.3, 0, 1) * Math.PI) * 0.8;
      seat = Math.sin(THREE.MathUtils.clamp((reloadT - 0.55) / 0.2, 0, 1) * Math.PI);
    }
    leftMount.position.lerpVectors(gripAnchor.position, magAnchor.position, toMag);
    leftMount.position.y += seat * 0.025;
    leftMount.quaternion.copy(gripAnchor.quaternion).slerp(_q.copy(magAnchor.quaternion), toMag);
    const curl = THREE.MathUtils.lerp(gripAnchor.userData.curl, magAnchor.userData.curl, toMag);
    left.pose({ curl: curl * grab, thumb: grab, spread: (1 - grab) * 0.12, time: time + 2 });
  }

  /** Call after the rig pose is final (needs world matrices). */
  function aimForearms() {
    rig.updateMatrixWorld(true);
    right.forearm.lookAt(rig.localToWorld(_elbow.copy(ELBOW_RIGHT)));
    left.forearm.lookAt(rig.localToWorld(_elbow.copy(ELBOW_LEFT)));
  }

  function setVisible(value) {
    right.root.visible = value;
    left.root.visible = value;
  }

  return { attach, update, aimForearms, fire, setVisible };
}
