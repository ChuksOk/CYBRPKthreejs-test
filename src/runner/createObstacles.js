import * as THREE from "three/webgpu";
import { color, float, fract, max, min, mix, step, texture, uv } from "three/tsl";
import { RUNNER } from "./runnerConfig.js";

const _box = new THREE.Box3();

/** How the player must answer each obstacle. */
export const OBSTACLE_KINDS = {
  barrier: { answer: "jump" },
  beam: { answer: "slide" },
  car: { answer: "lane" },
};

function restyleBarrier(root) {
  root.traverse((child) => {
    if (!child.isMesh) {
      return;
    }
    const map = child.material?.map ?? null;
    const material = new THREE.MeshStandardNodeMaterial({
      color: 0x5a6070,
      metalness: 0.55,
      roughness: 0.45,
      map,
    });
    if (map) {
      const sample = texture(map).rgb;
      const saturation = max(sample.r, max(sample.g, sample.b)).sub(min(sample.r, min(sample.g, sample.b)));
      material.emissiveNode = color(0xff2d55).mul(saturation.smoothstep(0.2, 0.45)).mul(3.2);
    }
    child.material = material;
    child.castShadow = true;
    child.receiveShadow = true;
  });
}

function createBeamVisual() {
  const group = new THREE.Group();
  const stripes = step(0.5, fract(uv().x.add(uv().y).mul(7)));
  const barMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.3 });
  barMaterial.colorNode = mix(color(0x111114), color(0xffc400), stripes);
  barMaterial.emissiveNode = color(0xffb300).mul(stripes).mul(1.6);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.42, 3.1), barMaterial);
  bar.position.y = 1.5;
  bar.castShadow = true;
  group.add(bar);

  const cableMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x111111, roughness: 0.8 });
  for (const z of [-1.35, 1.35]) {
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 7, 5), cableMaterial);
    cable.position.set(0, 1.5 + 3.5, z);
    group.add(cable);
  }

  const warnMaterial = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
  warnMaterial.emissiveNode = color(0xff2d55).mul(float(5));
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 2.9), warnMaterial);
  lamp.position.set(-0.19, 1.28, 0);
  group.add(lamp);
  return group;
}

/**
 * Pooled lane obstacles. Hitboxes are world AABBs derived from each visual
 * once at load, so collision is a box test instead of a mesh raycast.
 */
export function createObstacles({ scene, barrierModel, carModel, poolSize = 6 }) {
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

  // Barrier (jump over).
  if (barrierModel) {
    restyleBarrier(barrierModel);
    for (let i = 0; i < poolSize; i++) {
      const visual = new THREE.Group();
      const wall = barrierModel.clone(true);
      wall.rotation.y = Math.PI / 2;
      wall.scale.set(1.3, 1, 1.1);
      visual.add(wall);
      const localBox = measure(visual);
      localBox.max.y = Math.min(localBox.max.y, 0.82);
      register("barrier", visual, localBox);
    }
  }

  // Overhead beam (slide under).
  for (let i = 0; i < poolSize; i++) {
    const visual = createBeamVisual();
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
