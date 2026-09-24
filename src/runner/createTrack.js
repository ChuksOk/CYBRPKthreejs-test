import * as THREE from "three/webgpu";
import { color } from "three/tsl";
import { buildModelBvh } from "../world/bvh.js";
import { sliceGeometryX } from "./sliceGeometry.js";
import { RUNNER } from "./runnerConfig.js";

const STREET_MIN_Z = 10;
const STREET_MAX_Z = 40;
const CAP_BOTTOM = -6;
const CAP_TOP = 70;
const CAP_THICKNESS = 0.8;

function sliceRoot(root, xMin, xMax) {
  root.updateMatrixWorld(true);
  const empty = [];

  root.traverse((child) => {
    if (!child.isMesh || !child.geometry || child.isInstancedMesh) {
      return;
    }

    const sliced = sliceGeometryX(child.geometry, child.matrixWorld, xMin, xMax);
    child.geometry.disposeBoundsTree?.();
    child.geometry.dispose();

    if (!sliced) {
      empty.push(child);
      return;
    }

    child.geometry = sliced;
  });

  for (const mesh of empty) {
    mesh.removeFromParent();
  }

  buildModelBvh(root);
}

/**
 * Dark bulkheads over the cut building cross-sections at each seam, plus a
 * neon gate arch over the street, so the tile boundary reads as a sector gate.
 */
function createSeamGate(x) {
  const group = new THREE.Group();
  group.name = "runner-seam-gate";

  const wallMaterial = new THREE.MeshStandardNodeMaterial({
    color: 0x07070c,
    roughness: 0.85,
    metalness: 0.2,
  });
  const cyan = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
  cyan.emissiveNode = color(0x22d3ee).mul(4);
  const magenta = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
  magenta.emissiveNode = color(0xe040fb).mul(4);

  const height = CAP_TOP - CAP_BOTTOM;
  const centerY = (CAP_TOP + CAP_BOTTOM) / 2;

  const addBox = (sx, sy, sz, px, py, pz, material, { shadow = true } = {}) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
    mesh.position.set(px, py, pz);
    mesh.castShadow = shadow;
    mesh.receiveShadow = shadow;
    group.add(mesh);
    return mesh;
  };

  // Bulkheads either side of the street (cover the sliced facades).
  const leftDepth = STREET_MIN_Z + 90;
  addBox(CAP_THICKNESS, height, leftDepth, x, centerY, STREET_MIN_Z - leftDepth / 2, wallMaterial);
  const rightDepth = 110;
  addBox(CAP_THICKNESS, height, rightDepth, x, centerY, STREET_MAX_Z + rightDepth / 2, wallMaterial);

  // Neon edges facing the street.
  const floor = RUNNER.floorY;
  const stripHeight = 26;
  addBox(0.9, stripHeight, 0.18, x, floor + stripHeight / 2, STREET_MIN_Z + 0.05, cyan, { shadow: false });
  addBox(0.9, stripHeight, 0.18, x, floor + stripHeight / 2, STREET_MAX_Z - 0.05, magenta, { shadow: false });

  // Gate arch over the street.
  const archY = floor + 9;
  const span = STREET_MAX_Z - STREET_MIN_Z;
  addBox(1.2, 0.9, span, x, archY, (STREET_MIN_Z + STREET_MAX_Z) / 2, wallMaterial);
  addBox(1.25, 0.12, span, x, archY - 0.5, (STREET_MIN_Z + STREET_MAX_Z) / 2, cyan, { shadow: false });
  addBox(1.25, 0.12, span * 0.6, x, archY + 0.5, (STREET_MIN_Z + STREET_MAX_Z) / 2, magenta, { shadow: false });

  return group;
}

/**
 * Endless alley: the loaded scenery is clipped to one straight slab of street
 * and cloned end to end. The player never leaves tile 0 — when they cross the
 * far seam everything dynamic is shifted back by one segment length
 * (floating origin), so the static tiles and shadow map never move.
 *
 * @param {object} options
 * @param {THREE.Scene} options.scene
 * @param {THREE.Object3D[]} options.slicedSources   city-scale roots to clip
 * @param {THREE.Object3D[]} options.wholeSources    small props kept whole (car)
 * @param {object} [options.ground]                  createGround() result
 * @param {number} [options.behind]
 * @param {number} [options.ahead]
 */
export function createTrack({
  scene,
  slicedSources = [],
  wholeSources = [],
  ground = null,
  behind = 1,
  ahead = 2,
}) {
  const start = RUNNER.segmentStartX;
  const length = RUNNER.segmentLength;
  const end = start + length;

  const tile = new THREE.Group();
  tile.name = "runner-tile-0";

  for (const root of slicedSources) {
    if (!root) {
      continue;
    }
    sliceRoot(root, start, end);
    root.removeFromParent();
    tile.add(root);
  }

  for (const root of wholeSources) {
    if (!root) {
      continue;
    }
    root.removeFromParent();
    tile.add(root);
  }

  tile.add(createSeamGate(start));
  scene.add(tile);

  const tiles = [tile];
  for (let k = -behind; k <= ahead; k++) {
    if (k === 0) {
      continue;
    }
    const copy = tile.clone();
    copy.name = `runner-tile-${k}`;
    copy.position.x = k * length;
    scene.add(copy);
    tiles.push(copy);
  }

  for (const t of tiles) {
    t.updateMatrixWorld(true);
  }

  // Ground plane follows the player in whole texture tiles so the pattern is
  // continuous across the wrap (segmentLength is a multiple of groundTile).
  function followGround(x) {
    if (!ground?.mesh) {
      return;
    }
    const snapped = Math.round(x / RUNNER.groundTile) * RUNNER.groundTile;
    if (ground.mesh.position.x !== snapped) {
      ground.mesh.position.x = snapped;
      ground.mesh.updateMatrixWorld();
    }
  }

  /**
   * @returns {number} shift to apply to every dynamic object (0 = no wrap)
   */
  function getWrapShift(x) {
    if (x > end) {
      return -length;
    }
    if (x < start) {
      return length;
    }
    return 0;
  }

  return {
    tile,
    tiles,
    start,
    end,
    length,
    /** Raycast roots (all tiles share one BVH per geometry). */
    colliders: tiles,
    followGround,
    getWrapShift,
  };
}
