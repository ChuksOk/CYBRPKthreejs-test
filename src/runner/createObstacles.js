import * as THREE from "three/webgpu";
import { createPartKit } from "./models/modelKit.js";
import { createBarrierModel } from "./models/createBarrierModel.js";
import { chrome, emissive, gunmetal, hazard } from "./models/materials.js";
import { RUNNER } from "./runnerConfig.js";

const _box = new THREE.Box3();

/** How the player must answer each obstacle. */
export const OBSTACLE_KINDS = {
  barrier: { answer: "jump" },
  beam: { answer: "slide" },
  car: { answer: "lane" },
};

/** Hanging steel I-beam with hazard chevrons, chains and a blinking lamp. */
function createBeamVisual() {
  const kit = createPartKit();
  const span = 3.1;
  const y = 1.5;
  // I-beam: flanges + web.
  kit.box("steel", [0.3, 0.035, span], { position: [0, y + 0.19, 0], radius: 0.006 });
  kit.box("steel", [0.3, 0.035, span], { position: [0, y - 0.19, 0], radius: 0.006 });
  kit.box("steel", [0.03, 0.36, span], { position: [0, y, 0], radius: 0.004 });
  // Hazard plate on the approach face.
  kit.box("hazard", [0.012, 0.3, span * 0.94], { position: [-0.155, y, 0], radius: 0.003 });
  // Chains up into the dark.
  for (const z of [-1.3, 1.3]) {
    for (let i = 0; i < 18; i++) {
      kit.torus("chain", 0.028, 0.007, {
        position: [0, y + 0.25 + i * 0.075, z],
        rotation: [0, i % 2 ? Math.PI / 2 : 0, Math.PI / 2],
        tubular: 10,
        radial: 5,
      });
    }
  }
  // Warning lamps.
  for (const z of [-0.9, 0.9]) {
    kit.tube("steel", 0.035, 0.05, "y", { position: [0, y - 0.23, z] });
    kit.sphere("lamp", 0.03, { position: [0, y - 0.27, z], width: 12, height: 8 });
  }
  return kit.build({
    steel: gunmetal({ tint: 0x3d3f42, roughness: 0.55 }),
    hazard: hazard({ scale: 7 }),
    chain: chrome({ tint: 0x55585c }),
    lamp: emissive(0xffb300, 7, { blink: { rate: 1.6, duty: 0.5 } }),
  }, { name: "beam", castShadow: true });
}

/**
 * Pooled lane obstacles. Hitboxes are world AABBs derived from each visual
 * once at load, so collision is a box test instead of a mesh raycast.
 */
export function createObstacles({ scene, carModel, poolSize = 6 }) {
  const group = new THREE.Group();
  group.name = "runner-obstacles";
  scene.add(group);

  const pool = [];

  function register(kind, visual, localBox) {
    visual.visible = false;
    group.add(visual);
    pool.push({
      kind,
      visual,
      localBox,
      box: new THREE.Box3(),
      active: false,
      lane: 0,
      passed: false,
    });
  }

  function measure(visual) {
    visual.position.set(0, 0, 0);
    visual.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(visual, true);
  }

  // Barrier (jump over): procedural concrete jersey barrier.
  const barrierTemplate = createBarrierModel();
  for (let i = 0; i < poolSize; i++) {
    const visual = new THREE.Group();
    visual.add(barrierTemplate.clone(true));
    const localBox = measure(visual);
    localBox.max.y = Math.min(localBox.max.y, 0.82);
    register("barrier", visual, localBox);
  }

  // Overhead beam (slide under).
  const beamTemplate = createBeamVisual();
  for (let i = 0; i < poolSize; i++) {
    const visual = beamTemplate.clone(true);
    const localBox = new THREE.Box3(
      new THREE.Vector3(-0.3, 1.2, -1.55),
      new THREE.Vector3(0.3, 2.8, 1.55),
    );
    register("beam", visual, localBox);
  }

  // Parked car (switch lanes). The scene car has frozen static transforms
  // (addModel → freezeStaticTransforms), so clones must re-enable updates.
  const cloneMovable = (source) => {
    const copy = source.clone(true);
    copy.traverse((child) => {
      child.matrixAutoUpdate = true;
    });
    return copy;
  };
  if (carModel) {
    const probe = cloneMovable(carModel);
    probe.position.set(0, 0, 0);
    probe.rotation.set(0, 0, 0);
    probe.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(probe, true).getSize(new THREE.Vector3());
    const alongX = size.x >= size.z;
    for (let i = 0; i < Math.ceil(poolSize / 2); i++) {
      const visual = new THREE.Group();
      const car = cloneMovable(carModel);
      car.position.set(0, 0, 0);
      car.rotation.set(0, alongX ? Math.PI : -Math.PI / 2, 0);
      visual.add(car);
      const localBox = measure(visual);
      // Center the car on the lane.
      const center = localBox.getCenter(new THREE.Vector3());
      car.position.set(-center.x, -localBox.min.y, -center.z);
      const centered = measure(visual);
      centered.expandByVector(new THREE.Vector3(-0.1, 0, -0.15));
      register("car", visual, centered);
    }
  }

  function spawn(kind, x, lane) {
    const obstacle = pool.find((o) => !o.active && o.kind === kind);
    if (!obstacle) {
      return null;
    }
    obstacle.active = true;
    obstacle.passed = false;
    obstacle.arrived = false;
    obstacle.lane = lane;
    obstacle.visual.visible = true;
    obstacle.visual.position.set(x, RUNNER.floorY, RUNNER.laneZ[lane]);
    obstacle.visual.rotation.y = kind === "car" && Math.random() < 0.5 ? Math.PI : 0;
    obstacle.visual.updateMatrixWorld(true);
    syncBox(obstacle);
    return obstacle;
  }

  function syncBox(obstacle) {
    obstacle.box.copy(obstacle.localBox).translate(obstacle.visual.position);
  }

  /**
   * @returns {object|null} obstacle hit this frame
   */
  function update(playerBox, playerX, onPassed) {
    let hit = null;
    for (const obstacle of pool) {
      if (!obstacle.active) {
        continue;
      }
      if (obstacle.box.max.x < playerX - 12) {
        despawn(obstacle);
        continue;
      }
      if (!obstacle.passed && obstacle.box.max.x < playerX - 0.4) {
        obstacle.passed = true;
        onPassed?.(obstacle);
      }
      if (!hit && obstacle.box.intersectsBox(playerBox)) {
        hit = obstacle;
      }
    }
    return hit;
  }

  function despawn(obstacle) {
    obstacle.active = false;
    obstacle.visual.visible = false;
  }

  /** True if any active obstacle overlaps [x0, x1] in the given lane. */
  function isLaneBlocked(lane, x0, x1) {
    for (const obstacle of pool) {
      if (!obstacle.active || obstacle.lane !== lane) {
        continue;
      }
      _box.copy(obstacle.box);
      if (_box.max.x >= x0 && _box.min.x <= x1) {
        return true;
      }
    }
    return false;
  }

  function shiftX(dx) {
    for (const obstacle of pool) {
      obstacle.visual.position.x += dx;
      obstacle.visual.updateMatrixWorld(true);
      syncBox(obstacle);
    }
  }

  function clear() {
    for (const obstacle of pool) {
      despawn(obstacle);
    }
  }

  function setWarmupVisible(visible, position) {
    const seen = new Set();
    for (const obstacle of pool) {
      if (seen.has(obstacle.kind)) {
        continue;
      }
      seen.add(obstacle.kind);
      obstacle.visual.visible = visible;
      if (visible && position) {
        obstacle.visual.position.copy(position);
      }
    }
  }

  function getActive() {
    return pool.filter((obstacle) => obstacle.active);
  }

  return {
    group,
    spawn,
    update,
    getActive,
    isLaneBlocked,
    shiftX,
    clear,
    setWarmupVisible,
    kinds: [...new Set(pool.map((o) => o.kind))],
  };
}
