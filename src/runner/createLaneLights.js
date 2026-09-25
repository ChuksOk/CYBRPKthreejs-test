import * as THREE from "three/webgpu";
import { color, float, mix, positionWorld, sin, time, uniform } from "three/tsl";
import { RUNNER } from "./runnerConfig.js";

const SPACING = 4;
const BEHIND = 16;
const AHEAD = 124;

/**
 * Neon lane markers: emissive dashes on the lane dividers (cyan) and street
 * edges (pink), in one InstancedMesh. A pulse travels along world X toward
 * the player and speeds up with run speed.
 *
 * Floating origin: the dashes are laid out once in local space and the group
 * snaps to the player each frame (multiples of SPACING), so no shiftX needed.
 */
export function createLaneLights({ scene }) {
  const lanes = RUNNER.laneZ;
  const half = (lanes[1] - lanes[0]) / 2;
  const lines = [
    { z: lanes[0] - half, edge: true },
    ...lanes.slice(1).map((z, i) => ({ z: (lanes[i] + z) / 2, edge: false })),
    { z: lanes[lanes.length - 1] + half, edge: true },
  ];
  const perLine = Math.ceil((BEHIND + AHEAD) / SPACING);
  const count = perLine * lines.length;

  const geometry = new THREE.BoxGeometry(1.7, 0.02, 0.07);
  const uPhase = uniform(0);
  const uIntensity = uniform(1);
  // Divider vs edge colour from world Z parity: edges are the outermost lines.
  const isEdge = positionWorld.z.sub(lanes[1]).abs().greaterThan(half * 2.5);
  const tint = mix(color(0x22e5ff), color(0xff3d8b), isEdge.select(float(1), float(0)));
  const pulse = sin(positionWorld.x.mul(0.18).add(uPhase)).mul(0.5).add(0.5).pow(6);
  const shimmer = sin(time.mul(3).add(positionWorld.x.mul(0.7))).mul(0.08).add(0.92);
  const material = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
  material.colorNode = tint.mul(0.35);
  material.emissiveNode = tint.mul(float(1.2).add(pulse.mul(5))).mul(shimmer).mul(uIntensity);
  material.toneMapped = false;

  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.name = "runner-lane-lights";
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  const matrix = new THREE.Matrix4();
  let index = 0;
  for (const line of lines) {
    for (let i = 0; i < perLine; i++) {
      matrix.makeTranslation(-BEHIND + i * SPACING, RUNNER.floorY + 0.012, line.z);
      mesh.setMatrixAt(index++, matrix);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);

  function update(delta, playerX, speed) {
    mesh.position.x = Math.floor(playerX / SPACING) * SPACING;
    // Pulse runs toward the camera (−X in world) faster than the street.
    uPhase.value += delta * (4 + speed * 0.35);
  }

  function setIntensity(value) {
    uIntensity.value = value;
  }

  return { mesh, update, setIntensity };
}
