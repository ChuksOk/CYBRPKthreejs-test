import { addModel } from "./scene.js";
import { loadCityModel } from "./city/loadCity.js";
import { loadBillboards } from "./billboards/loadBillboards.js";
import { applyBillboardMaterials } from "./billboards/applyBillboardMaterials.js";
import { loadQuadraCar } from "./car/loadCar.js";
import { loadEnvironmentMap } from "./envMap.js";
import { createGround } from "./ground/createGround.js";
import { createCollisionHeight } from "./weather/createCollisionHeight.js";
import { createCollisionRain } from "./weather/createCollisionRain.js";
import { createSmoke } from "./effects/createSmoke.js";
import { createFlyingPlanes } from "./effects/createFlyingPlanes.js";
import { createCloudSky } from "../clouds/createCloudSky.js";
import { FEATURES } from "./features.js";
import { createTrack } from "../runner/createTrack.js";
import { RUNNER } from "../runner/runnerConfig.js";
import { performanceProfile } from "../platform/performanceProfile.js";
import * as THREE from "three/webgpu";

function buildColliders({ city, boundsCollider, carCollider }) {
  const colliders = [];

  if (city) {
    colliders.push(city);
  }

  if (boundsCollider) {
    colliders.push(boundsCollider);
  }

  if (carCollider) {
    colliders.push(carCollider);
  }

  return colliders;
}

function buildFocusTargets({ city, car, ground, billboards }) {
  const targets = [];

  if (city) {
    targets.push(city);
  }

  if (billboards) {
    targets.push(billboards);
  }

  if (car) {
    targets.push(car);
  }

  if (ground?.mesh) {
    targets.push(ground.mesh);
  }

  return targets;
}

export async function createWorld({
  scene,
  renderer,
  camera = null,
  loaderOverlay,
  requestShadowMapUpdate,
}) {
  loaderOverlay.setProgress(0.35);
  loaderOverlay.setStatus("STREAMING MESHES");

  const loadTasks = [];

  if (FEATURES.city) {
    loadTasks.push(loadCityModel(renderer));
    loadTasks.push(
      performanceProfile.billboardsEnabled
        ? loadBillboards(renderer)
        : Promise.resolve(null),
    );
  } else {
    loadTasks.push(Promise.resolve(null));
    loadTasks.push(Promise.resolve(null));
  }

  if (FEATURES.car) {
    loadTasks.push(loadQuadraCar(renderer));
  } else {
    loadTasks.push(Promise.resolve(null));
  }

  loadTasks.push(loadEnvironmentMap());

  const [cityResult, billboards, quadra, envTexture] =
    await Promise.all(loadTasks);
  const city = cityResult?.city ?? null;
  const boundsCollider = cityResult?.boundsCollider ?? null;
  const quadraCar = quadra?.car ?? null;
  const quadraCollider = quadra?.collider ?? null;
  const carSurfaceRain = quadra?.surfaceRain ?? null;

  loaderOverlay.setProgress(0.7);
  loaderOverlay.setStatus("WIRING WORLD");

  if (city) {
    addModel(scene, city);
  }

  // The walk-mode bounds collider is not used by the runner (lanes are fixed).
  if (boundsCollider && !FEATURES.runner) {
    addModel(scene, boundsCollider);
  }

  if (billboards) {
    addModel(scene, billboards);
    billboards.userData.billboardMaterials = applyBillboardMaterials(billboards);
  }

  if (quadraCar) {
    addModel(scene, quadraCar);
  }

  if (quadraCollider && !FEATURES.runner) {
    scene.add(quadraCollider);
    requestShadowMapUpdate?.("quadra-car");
  }

  const groundSize = 400;
  const ground = FEATURES.ground
    ? createGround(
        scene,
        FEATURES.runner
          ? // Tile size must divide the runner segment so the wrap is seamless.
            { size: groundSize, uvRepeat: groundSize / RUNNER.groundTile }
          : undefined,
      )
    : null;

  let track = null;
  if (FEATURES.runner && city) {
    loaderOverlay.setStatus("TILING SECTOR");
    track = createTrack({
      scene,
      slicedSources: [city, billboards],
      wholeSources: [quadraCar],
      ground,
      behind: performanceProfile.runnerSegmentsBehind,
      ahead: performanceProfile.runnerSegmentsAhead,
    });
  }

  let smoke = null;
  // Exhaust smoke hangs off the one original car and would pop across tiles.
  if (FEATURES.smoke && quadraCar && !FEATURES.runner) {
    smoke = await createSmoke({ scene, car: quadraCar });
  }

  let planes = null;
  if (FEATURES.planes) {
    planes = await createFlyingPlanes({ scene, renderer });
  }

  let sky = null;
  if (FEATURES.sky) {
    sky = await createCloudSky(scene, {
      radius: 135,
      verticalOffset: -33.5,
    });
    // Scene is night / neon — skip the bright day cloud preset.
    sky.updateFromSun({
      night: 1,
      skyTop: new THREE.Color(0x0a0818),
      skyBottom: new THREE.Color(0x1c2438),
    });
  }

  let collisionHeight = null;
  let rain = null;
  if (FEATURES.rain) {
    collisionHeight = createCollisionHeight({ scene, renderer });
    rain = await createCollisionRain({
      scene,
      renderer,
      collisionHeight,
      camera,
    });
  }

  const colliders = FEATURES.runner
    ? []
    : buildColliders({
        city,
        boundsCollider,
        carCollider: quadraCollider,
      });
  const focusTargets = buildFocusTargets({
    city,
    car: quadraCar,
    ground,
    billboards,
  });

  return {
    city,
    boundsCollider,
    billboards,
    car: quadraCar,
    carCollider: quadraCollider,
    carSurfaceRain,
    envTexture,
    ground,
    collisionHeight,
    rain,
    smoke,
    planes,
    sky,
    colliders,
    focusTargets,
    primaryPlaneAnchor: planes?.primaryAnchor ?? null,
    track,
    /** Filled by the runner: dynamic objects to hide from the rain height pass. */
    collisionHideExtra: null,
    /** Filled by the runner: warmup hooks for pooled objects. */
    runnerWarm: null,
  };
}

export function createLightingController({
  sceneResult,
  envMapBaseIntensity,
  requestShadowMapUpdate,
}) {
  function syncEnvironmentIntensity() {
    sceneResult.scene.environmentIntensity = envMapBaseIntensity.value;
  }

  function syncLighting() {
    sceneResult.applySun();
    syncEnvironmentIntensity();
    requestShadowMapUpdate?.("lighting");
  }

  return {
    syncEnvironmentIntensity,
    syncLighting,
  };
}
