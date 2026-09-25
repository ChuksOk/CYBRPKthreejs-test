import * as THREE from "three/webgpu";
import { color, mx_noise_float, positionLocal } from "three/tsl";
import { getSharedMaterials } from "../runner/models/createGunModels.js";
import { VIEWMODEL_LAYER } from "../runner/runnerConfig.js";

/**
 * First-person gloved hands, fully procedural (no skinning).
 *
 * Anatomy: tapered palm with thenar / hypothenar pads, four fingers of three
 * lathed segments (tapered, knuckle bulge, rounded tips), a two-segment thumb
 * on a metacarpal. Tactical glove with fabric sheen and weave, cut-off index
 * and thumb tips (skin + nails), graphite knuckle armour with neon trim, a
 * wrist strap, a strip of skin and a techwear sleeve aimed at the elbow.
 *
 * Hands mount on anchors inside each gun (createGunModels `anchors`) so they
 * inherit recoil, sway, bob and weapon switches. Animation: trigger squeeze
 * on each shot, left hand to the magazine on reload, idle finger motion, and
 * a throw: the left hand leaves the gun holding the special (grenade / drone
 * orb), winds back, snaps forward and releases it (onRelease callback gets
 * the world position of the item). On death both hands let go of the gun
 * (release / updateDeath / restore): they flinch up into a bracing pose,
 * fingers splayed, then slump out of frame while the gun tumbles away.
 */

// Finger segment lengths (proximal, middle, distal) and base radius, metres.
const FINGERS = [
  { name: "index", x: 0.028, y: 0.046, len: [0.043, 0.026, 0.021], r: 0.0096 },
  { name: "middle", x: 0.0093, y: 0.049, len: [0.048, 0.029, 0.022], r: 0.0099 },
  { name: "ring", x: -0.0093, y: 0.047, len: [0.045, 0.027, 0.021], r: 0.0094 },
  { name: "pinky", x: -0.0265, y: 0.041, len: [0.034, 0.021, 0.018], r: 0.0084 },
];
// Joint curl (rad) for a full grip, per joint.
const GRIP_CURL = [1.25, 1.45, 0.95];

function fabricMaterial(hex, { roughness = 0.82, weave = 520, sheen = 0.55 } = {}) {
  const material = new THREE.MeshPhysicalNodeMaterial({
    roughness,
    metalness: 0,
    sheen,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color(0x8a93a6),
  });
  const weaveNoise = mx_noise_float(positionLocal.mul(weave)).mul(0.5).add(0.5);
  const broad = mx_noise_float(positionLocal.mul(38)).mul(0.5).add(0.5);
  material.colorNode = color(hex).mul(weaveNoise.mul(0.22).add(broad.mul(0.14)).add(0.76));
  material.roughnessNode = weaveNoise.mul(0.12).add(roughness - 0.06);
  return material;
}

function skinMaterial() {
  const material = new THREE.MeshPhysicalNodeMaterial({
    roughness: 0.46,
    metalness: 0,
    sheen: 0.35,
    sheenRoughness: 0.4,
    sheenColor: new THREE.Color(0xff8f7a),
  });
  const pores = mx_noise_float(positionLocal.mul(900)).mul(0.5).add(0.5);
  const blotch = mx_noise_float(positionLocal.mul(70)).mul(0.5).add(0.5);
  // Base tone with slight redness variation (knuckles / fingertips).
  material.colorNode = color(0xb87b5a).mix(color(0xc4695a), blotch.mul(0.35)).mul(pores.mul(0.08).add(0.94));
  material.roughnessNode = pores.mul(0.1).add(0.42);
  return material;
}

let materials = null;
function getMaterials() {
  if (!materials) {
    const gun = getSharedMaterials();
    materials = {
      glove: fabricMaterial(0x1c1e23),
      palm: fabricMaterial(0x2d2722, { roughness: 0.66, weave: 260, sheen: 0.3 }),
      armor: gun.body,
      trim: gun.neon,
      dark: gun.dark,
      skin: skinMaterial(),
      nail: new THREE.MeshPhysicalNodeMaterial({ color: 0xd9a896, roughness: 0.25, clearcoat: 0.6 }),
      sleeve: fabricMaterial(0x252833, { roughness: 0.88, weave: 340, sheen: 0.45 }),
      strap: fabricMaterial(0x121317, { roughness: 0.9, weave: 700, sheen: 0.2 }),
      grenade: gun.dark,
      orb: gun.body,
    };
  }
  return materials;
}

const _segmentCache = new Map();
/**
 * Lathed finger segment along +Y from 0 to `length`: rounded base, slight
 * knuckle bulge, taper to `r1`, rounded (or fingertip) end.
 */
function fingerSegment(r0, r1, length, { tip = false } = {}) {
  const key = `${r0}|${r1}|${length}|${tip}`;
  if (_segmentCache.has(key)) {
    return _segmentCache.get(key);
  }
  const points = [];
  const capSteps = 5;
  for (let i = 0; i <= capSteps; i++) {
    const a = (i / capSteps) * (Math.PI / 2);
    points.push(new THREE.Vector2(Math.sin(a) * r0 * 1.04, r0 * (1 - Math.cos(a)) * 0.6));
  }
  const body = 6;
  for (let i = 1; i < body; i++) {
    const t = i / body;
    const bulge = Math.exp(-Math.pow((t - 0.12) / 0.12, 2)) * 0.06;
    const r = THREE.MathUtils.lerp(r0, r1, t) * (1 + bulge);
    points.push(new THREE.Vector2(r, r0 * 0.6 + t * (length - r0 * 0.6 - r1 * (tip ? 1 : 0.6))));
  }
  const endBase = length - r1 * (tip ? 1 : 0.6);
  for (let i = 0; i <= capSteps; i++) {
    const a = (i / capSteps) * (Math.PI / 2);
    points.push(new THREE.Vector2(Math.cos(a) * r1, endBase + Math.sin(a) * r1 * (tip ? 1 : 0.6)));
  }
  points[points.length - 1].x = 0.0001;
  const geometry = new THREE.LatheGeometry(points, 14);
  // Fingers are a touch flatter front-to-back than side-to-side.
  geometry.scale(1, 1, 0.88);
  geometry.computeVertexNormals();
  _segmentCache.set(key, geometry);
  return geometry;
}

function roundedBox(w, h, d, r, { taper = 0 } = {}) {
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
  if (taper) {
    // Narrower and thinner toward −Y (wrist end of the palm).
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const t = THREE.MathUtils.clamp((pos.getY(i) + h / 2) / h, 0, 1);
      const s = THREE.MathUtils.lerp(1 - taper, 1, t);
      pos.setX(i, pos.getX(i) * s);
      pos.setZ(i, pos.getZ(i) * THREE.MathUtils.lerp(1 - taper * 0.5, 1, t));
    }
  }
  geometry.computeVertexNormals();
  return geometry;
}

function ellipsoid(rx, ry, rz) {
  const geometry = new THREE.SphereGeometry(1, 16, 12);
  geometry.scale(rx, ry, rz);
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

  // Palm: tapered glove shell, leather palm pad, thenar + hypothenar pads.
  add(root, roundedBox(0.082, 0.094, 0.03, 0.013, { taper: 0.16 }), m.glove);
  add(root, roundedBox(0.07, 0.066, 0.008, 0.004, { taper: 0.1 }), m.palm, [0, -0.004, -0.0135]);
  add(root, ellipsoid(0.017, 0.028, 0.012), m.palm, [side * 0.024, -0.02, -0.01], [0, 0, side * 0.35]);
  add(root, ellipsoid(0.013, 0.03, 0.01), m.palm, [side * -0.028, -0.012, -0.009]);
  // Back of hand: armour plate + neon trim; knuckle guard with a ridge.
  add(root, roundedBox(0.062, 0.05, 0.008, 0.004, { taper: 0.1 }), m.armor, [side * 0.002, 0.002, 0.0165], [0.06, 0, 0]);
  add(root, new THREE.BoxGeometry(0.046, 0.0025, 0.002), m.trim, [side * 0.002, -0.018, 0.021]);
  add(root, roundedBox(0.078, 0.015, 0.014, 0.006), m.armor, [0, 0.043, 0.012], [0.2, 0, 0]);
  add(root, roundedBox(0.07, 0.004, 0.004, 0.0015), m.dark, [0, 0.043, 0.019], [0.2, 0, 0]);
  add(root, new THREE.BoxGeometry(0.004, 0.004, 0.002), m.trim, [side * 0.03, 0.043, 0.02]);

  // Fingers: joint chains, curl about local X toward the palm (−Z).
  const fingers = FINGERS.map((spec, f) => {
    const joints = [];
    let parent = root;
    spec.len.forEach((length, i) => {
      const joint = new THREE.Group();
      joint.position.set(i === 0 ? side * -spec.x : 0, i === 0 ? spec.y : spec.len[i - 1] * 0.94, i === 0 ? -0.002 : 0);
      parent.add(joint);
      const r0 = spec.r * (1 - i * 0.08);
      const r1 = r0 * (i === 2 ? 0.86 : 0.92);
      const isTip = i === 2;
      // Cut-off glove tip on the index finger: bare skin + nail.
      const bare = isTip && f === 0;
      add(joint, fingerSegment(r0, r1, length, { tip: isTip }), bare ? m.skin : m.glove);
      if (bare) {
        add(joint, roundedBox(r1 * 1.3, length * 0.5, 0.002, 0.0009), m.nail, [0, length * 0.62, r1 * 0.78], [-0.08, 0, 0]);
        add(joint, fingerSegment(r0 * 1.06, r0 * 1.04, 0.006), m.glove);
      }
      if (i === 0) {
        add(joint, roundedBox(r0 * 1.7, length * 0.5, 0.005, 0.002), m.armor, [0, length * 0.5, r0 * 0.82]);
      }
      joints.push(joint);
      parent = joint;
    });
    return { joints, spec };
  });

  // Thumb: metacarpal from the heel of the palm, two segments, bare tip.
  const thumbBase = new THREE.Group();
  thumbBase.position.set(side * 0.034, -0.024, -0.008);
  root.add(thumbBase);
  add(thumbBase, fingerSegment(0.0135, 0.0118, 0.046), m.glove);
  const thumbMid = new THREE.Group();
  thumbMid.position.y = 0.043;
  thumbBase.add(thumbMid);
  add(thumbMid, fingerSegment(0.0116, 0.0108, 0.033), m.glove);
  add(thumbMid, roundedBox(0.016, 0.017, 0.005, 0.002), m.armor, [0, 0.016, 0.0095]);
  const thumbTip = new THREE.Group();
  thumbTip.position.y = 0.031;
  thumbMid.add(thumbTip);
  add(thumbTip, fingerSegment(0.0108, 0.0094, 0.028, { tip: true }), m.skin);
  add(thumbTip, fingerSegment(0.0114, 0.0112, 0.006), m.glove);
  add(thumbTip, roundedBox(0.012, 0.013, 0.002, 0.0009), m.nail, [0, 0.018, 0.0086], [-0.08, 0, 0]);

  // Cuff + wrist strap, wrist skin.
  const cuff = new THREE.CylinderGeometry(0.036, 0.033, 0.032, 20);
  add(root, cuff, m.glove, [0, -0.058, 0]).scale.set(1.12, 1, 0.72);
  add(root, new THREE.CylinderGeometry(0.0375, 0.0375, 0.014, 20), m.strap, [0, -0.06, 0]).scale.set(1.14, 1, 0.74);
  add(root, roundedBox(0.02, 0.016, 0.006, 0.002), m.strap, [side * 0.03, -0.06, 0.02], [0, side * 0.6, 0]);
  add(root, new THREE.TorusGeometry(0.035, 0.0022, 6, 24), m.trim, [0, -0.044, 0], [Math.PI / 2, 0, 0]).scale.set(1.12, 0.72, 1);
  add(root, new THREE.CylinderGeometry(0.03, 0.03, 0.024, 16), m.skin, [0, -0.083, 0]).scale.set(1.1, 1, 0.8);

  // Forearm: its own group at the wrist, aimed at an elbow point each frame
  // (built along +Z so Object3D.lookAt points it).
  const forearm = new THREE.Group();
  forearm.position.set(0, -0.09, 0);
  root.add(forearm);
  const sleeve = new THREE.CylinderGeometry(0.043, 0.056, 0.5, 20, 1, true);
  sleeve.translate(0, 0.25, 0);
  sleeve.rotateX(Math.PI / 2);
  add(forearm, sleeve, m.sleeve).scale.set(1.08, 0.9, 1);
  const ring = new THREE.CylinderGeometry(0.045, 0.045, 0.022, 20);
  ring.rotateX(Math.PI / 2);
  add(forearm, ring, m.dark, [0, 0, 0.006]).scale.set(1.08, 0.9, 1);
  const stripe = new THREE.BoxGeometry(0.003, 0.003, 0.36);
  stripe.translate(0, 0, 0.22);
  add(forearm, stripe, m.trim, [side * 0.046, 0.012, 0]);

  // Held item (special) cupped in the palm, shown during a throw.
  const held = new THREE.Group();
  held.position.set(side * 0.004, 0.028, -0.04);
  root.add(held);
  const grenade = new THREE.Group();
  add(grenade, new THREE.SphereGeometry(0.026, 18, 14), m.grenade);
  add(grenade, new THREE.TorusGeometry(0.026, 0.003, 6, 24), m.trim, [0, 0, 0], [Math.PI / 2, 0, 0]);
  add(grenade, new THREE.CylinderGeometry(0.008, 0.008, 0.012, 10), m.armor, [0, 0.027, 0]);
  const orb = new THREE.Group();
  add(orb, new THREE.SphereGeometry(0.028, 18, 14), m.orb);
  add(orb, new THREE.TorusGeometry(0.029, 0.0028, 6, 24), m.trim, [0, 0, 0], [Math.PI / 2, 0, 0]);
  add(orb, new THREE.SphereGeometry(0.009, 10, 8), m.trim, [0, 0, -0.024]);
  held.add(grenade, orb);
  held.visible = false;

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

  function showHeld(type) {
    held.visible = Boolean(type);
    grenade.visible = type === "seeker";
    orb.visible = type === "ally";
  }

  pose({});
  return { root, pose, forearm, held, showHeld };
}

const _elbow = new THREE.Vector3();
// Elbow targets in camera space (metres): out of frame, below and behind.
const ELBOW_RIGHT = new THREE.Vector3(0.3, -0.45, 0.12);
const ELBOW_LEFT = new THREE.Vector3(-0.1, -0.5, -0.02);

/** Throw keyframes for the left palm, in camera (rig) space. */
function throwKey(t, position, fingers, back, curl) {
  const y = new THREE.Vector3(...fingers).normalize();
  const z = new THREE.Vector3(...back).normalize();
  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  z.crossVectors(x, y).normalize();
  return {
    t,
    position: new THREE.Vector3(...position),
    quaternion: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z)),
    curl,
  };
}
const THROW_DURATION = 0.72;
const THROW_RELEASE = 0.5;
const THROW_KEYS = [
  // Raise: palm up, item cupped.
  throwKey(0.22, [-0.18, -0.15, -0.44], [0.15, 0.45, -1], [-0.2, -1, -0.3], 0.55),
  // Wind back: hand up beside the view, back of the hand toward camera.
  throwKey(0.4, [-0.22, -0.07, -0.3], [0.1, 1, -0.2], [-0.35, 0.1, 1], 0.6),
  // Release: snapped forward, fingers opening.
  throwKey(0.52, [-0.15, -0.08, -0.62], [0.1, 0.15, -1], [0, 1, 0.25], 0.12),
  // Follow-through: hand drops.
  throwKey(0.7, [-0.15, -0.25, -0.52], [0.2, -0.6, -1], [0, 1, -0.5], 0.3),
];

// Death: bracing pose (camera space) the hands flinch into after letting go.
function deathKey(position, fingers, back) {
  const { position: p, quaternion } = throwKey(0, position, fingers, back, 0);
  return { position: p, quaternion };
}
const DEATH_BRACE = {
  right: deathKey([0.13, -0.1, -0.34], [0.35, 1, -0.15], [0.1, -0.1, 1]),
  left: deathKey([-0.15, -0.09, -0.35], [-0.35, 1, -0.15], [-0.1, -0.1, 1]),
};

/** @param {{ rig: THREE.Object3D }} options  camera-aligned viewmodel rig */
export function createHands({ rig }) {
  const right = buildHand(-1);
  const left = buildHand(1);
  // Left hand rides on a mount that blends between grip, magazine and the
  // throw path.
  const leftMount = new THREE.Group();
  leftMount.add(left.root);
  let gun = null;
  let time = 0;
  let squeeze = 0;
  const throwState = { t: -1, type: null, released: false, onRelease: null };
  const _q = new THREE.Quaternion();
  const _m = new THREE.Matrix4();
  const _gripPos = new THREE.Vector3();
  const _gripQuat = new THREE.Quaternion();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scale = new THREE.Vector3();
  const _parentInv = new THREE.Matrix4();
  const _world = new THREE.Vector3();
  const _axisX = new THREE.Vector3(1, 0, 0);
  // Death: hands let go of the gun and are animated in rig (camera) space.
  const death = {
    active: false,
    from: {
      right: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
      left: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
    },
  };

  function attach(gunModel) {
    gun = gunModel;
    if (death.active) {
      // Re-parented on restore().
      return;
    }
    gunModel.anchors.right.add(right.root);
    gunModel.anchors.right.parent.add(leftMount);
    leftMount.layers.set(VIEWMODEL_LAYER);
  }

  function fire() {
    squeeze = 1;
  }

  /**
   * Throw the special with the left hand.
   * @param {"ally"|"seeker"} type
   * @param {(worldPosition: THREE.Vector3) => void} onRelease
   * @returns {boolean} false if a throw is already in progress
   */
  function throwItem(type, onRelease) {
    if (throwState.t >= 0) {
      return false;
    }
    throwState.t = 0;
    throwState.type = type;
    throwState.released = false;
    throwState.onRelease = onRelease;
    left.showHeld(type);
    return true;
  }

  /** Blend the left mount along the throw path (camera-space keyframes). */
  function applyThrow(gripAnchor) {
    const parent = leftMount.parent;
    rig.updateMatrixWorld(true);
    // Grip pose expressed in rig space (start / end of the throw).
    _m.copy(rig.matrixWorld).invert().multiply(gripAnchor.matrixWorld);
    _m.decompose(_gripPos, _gripQuat, _scale);

    const t = throwState.t;
    const keys = [{ t: 0, position: _gripPos, quaternion: _gripQuat, curl: gripAnchor.userData.curl }, ...THROW_KEYS, { t: 1, position: _gripPos, quaternion: _gripQuat, curl: gripAnchor.userData.curl }];
    let a = keys[0];
    let b = keys[keys.length - 1];
    for (let i = 0; i < keys.length - 1; i++) {
      if (t >= keys[i].t && t <= keys[i + 1].t) {
        a = keys[i];
        b = keys[i + 1];
        break;
      }
    }
    const k = THREE.MathUtils.smoothstep((t - a.t) / Math.max(1e-4, b.t - a.t), 0, 1);
    _pos.lerpVectors(a.position, b.position, k);
    _quat.slerpQuaternions(a.quaternion, b.quaternion, k);

    // Rig space → mount parent space.
    _m.compose(_pos, _quat, _scale.set(1, 1, 1)).premultiply(rig.matrixWorld);
    _parentInv.copy(parent.matrixWorld).invert();
    _m.premultiply(_parentInv);
    _m.decompose(leftMount.position, leftMount.quaternion, _scale);
    return THREE.MathUtils.lerp(a.curl, b.curl, k);
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

    if (throwState.t >= 0) {
      throwState.t += delta / THROW_DURATION;
      const curl = applyThrow(gripAnchor);
      if (!throwState.released && throwState.t >= THROW_RELEASE) {
        throwState.released = true;
        left.root.updateMatrixWorld(true);
        left.held.getWorldPosition(_world);
        left.showHeld(null);
        throwState.onRelease?.(_world);
      }
      left.pose({ curl, thumb: Math.min(1, curl + 0.3), spread: (1 - curl) * 0.1, time });
      if (throwState.t >= 1) {
        throwState.t = -1;
      }
      return;
    }

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

  /** Let go of the gun: both hands move into rig space for the death pose. */
  function release() {
    if (death.active) {
      return;
    }
    throwState.t = -1;
    throwState.onRelease = null;
    left.showHeld(null);
    rig.updateMatrixWorld(true);
    rig.attach(right.root);
    rig.attach(left.root);
    death.from.right.position.copy(right.root.position);
    death.from.right.quaternion.copy(right.root.quaternion);
    death.from.left.position.copy(left.root.position);
    death.from.left.quaternion.copy(left.root.quaternion);
    death.active = true;
  }

  /**
   * Death animation: flinch into a bracing pose (fingers splayed, a short
   * tremor), then go limp and slump out of the bottom of the frame.
   * @param {number} t      0..1 progress
   * @param {number} delta  real-time delta (tremor / idle motion)
   */
  function updateDeath(t, delta) {
    if (!death.active) {
      return;
    }
    time += delta;
    const flinch = THREE.MathUtils.smoothstep(t, 0, 0.22);
    const slump = THREE.MathUtils.smoothstep(t, 0.38, 1);
    const tremor = Math.sin(time * 58) * 0.004 * flinch * (1 - slump);
    const hands = [
      [right, death.from.right, DEATH_BRACE.right, 1],
      [left, death.from.left, DEATH_BRACE.left, -1],
    ];
    for (const [hand, from, brace, dir] of hands) {
      hand.root.position.lerpVectors(from.position, brace.position, flinch);
      hand.root.position.x += dir * (0.07 * slump + tremor);
      hand.root.position.y += tremor * dir - 0.36 * slump * slump;
      hand.root.position.z += 0.06 * slump;
      hand.root.quaternion.slerpQuaternions(from.quaternion, brace.quaternion, flinch);
      // Wrists go limp: fingers pitch forward and droop as the arms fall.
      hand.root.quaternion.premultiply(_q.setFromAxisAngle(_axisX, -0.9 * slump));
      const open = THREE.MathUtils.lerp(1, 0.06, flinch);
      hand.pose({
        curl: THREE.MathUtils.lerp(open, 0.55, slump),
        thumb: THREE.MathUtils.lerp(1, 0.15, flinch) + 0.4 * slump,
        spread: 0.3 * flinch * (1 - slump * 0.6),
        time: time * (1 - slump),
      });
    }
  }

  /** Back on the gun (new run). */
  function restore() {
    if (!death.active) {
      return;
    }
    death.active = false;
    for (const hand of [right, left]) {
      hand.root.position.set(0, 0, 0);
      hand.root.quaternion.identity();
      hand.root.scale.set(1, 1, 1);
    }
    leftMount.add(left.root);
    if (gun) {
      attach(gun);
    }
  }

  function setVisible(value) {
    right.root.visible = value;
    left.root.visible = value;
  }

  return {
    attach,
    update,
    aimForearms,
    fire,
    throwItem,
    isThrowing: () => throwState.t >= 0,
    release,
    updateDeath,
    restore,
    isReleased: () => death.active,
    setVisible,
  };
}
