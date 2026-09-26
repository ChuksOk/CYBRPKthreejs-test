import "./ui/core/global.css";
import "./ui/core/ticketTheme.css";
import * as THREE from "three/webgpu";
import { createScene } from "./world/scene.js";
import { createWorld, createLightingController } from "./world/createWorld.js";
import { applyEnvironmentMap } from "./world/envMap.js";
import { createPostProcessing } from "./post/postprocessing.js";
import { createLoaderOverlay } from "./app/createLoaderOverlay.js";
import { createAppShell } from "./app/createAppShell.js";
import { createIntroFlow } from "./app/createIntroFlow.js";
import {
  createCamera,
  createCameraLayoutSync,
  cameraParams,
  getBaseFovForLayout,
} from "./bootstrap/createCamera.js";
import {
  createRenderer,
  createShadowUpdater,
  resizeRenderer,
} from "./bootstrap/createRenderer.js";
import { createCameraDirector } from "./runtime/createCameraDirector.js";
import { createRunnerGame } from "./runner/createRunnerGame.js";
import { createWeatherSystem } from "./runner/createWeatherSystem.js";
import { createDayNightCycle } from "./runner/createDayNightCycle.js";
import { RUNNER } from "./runner/runnerConfig.js";
import { FEATURES } from "./world/features.js";
import { createRenderLoop } from "./runtime/createRenderLoop.js";
import {
  compileDeferredStartup,
  finalizeStartupLighting,
} from "./runtime/warmup.js";
import { createPerformanceDevTools } from "./debug/createPerformanceDevTools.js";
import { createInspectorSession } from "./debug/createInspectorSession.js";
import {
  createDevAppApi,
  attachDevAudio,
  attachDevPerf,
} from "./debug/createDevAppApi.js";
import {
  syncLayoutClass,
  onMobileLayoutChange,
} from "./platform/deviceLayout.js";
import { createAdaptiveDprController } from "./platform/adaptiveDpr.js";
import {
  performanceProfile,
  applyDevicePerformanceDefaults,
  shouldCompileBeforeRenderLoop,
} from "./platform/performanceProfile.js";
import { getStoredLookPreset, isDevelopmentModeEnabled } from "./platform/userPreferences.js";
import {
  applyXRPerformanceDefaults,
  wantsWebGPUXR,
  wantsXRMode,
} from "./xr/xrSupport.js";
import { createXRMode } from "./xr/createXRMode.js";
import {
  DEFAULT_LOOK_PRESET,
  LOOK_PRESETS,
} from "./post/look/cyberpunkLook.js";

const loader = createLoaderOverlay();

init(loader).catch((error) => {
  loader.fail("Failed to load. Check the console for details.");
  console.error("Failed to initialize scene:", error);
});

async function init(loaderOverlay) {
  // Must run before createRenderer so the initial setPixelRatio sees iOS caps.
  applyDevicePerformanceDefaults();
  // Meta Quest / ?xr: WebXR-capable renderer + headset budgets.
  const xrBoot = FEATURES.runner && wantsXRMode();
  if (xrBoot) {
    applyXRPerformanceDefaults();
  }
  syncLayoutClass();

  loaderOverlay.setProgress(0.03);
  loaderOverlay.setStatus("BOOTING SCENE");

  const camera = createCamera();
  const sceneResult = createScene();
  const { scene, sunLight } = sceneResult;

  loaderOverlay.setProgress(0.1);
  loaderOverlay.setStatus("SPINNING UP RENDERER");

  const { renderer } = await createRenderer({
    xr: xrBoot,
    xrWebGPU: xrBoot && wantsWebGPUXR(),
  });

  loaderOverlay.setProgress(0.2);
  loaderOverlay.setStatus("LINKING WEBGPU");

  const { requestShadowMapUpdate, flushDeferredShadowUpdate } = createShadowUpdater({
    renderer,
    getSunLight: () => sunLight,
  });

  const world = await createWorld({
    scene,
    renderer,
    camera,
    loaderOverlay,
    requestShadowMapUpdate,
  });

  const envMapBaseIntensity = { value: 0.08 };
  const lighting = createLightingController({
    sceneResult,
    envMapBaseIntensity,
    requestShadowMapUpdate,
  });

  lighting.syncLighting();
  requestShadowMapUpdate("init");

  loaderOverlay.setProgress(0.8);

  applyEnvironmentMap(scene, renderer, world.envTexture, {
    intensity: envMapBaseIntensity.value,
  });
  scene.environmentRotation.set(
    0,
    THREE.MathUtils.degToRad(70),
    THREE.MathUtils.degToRad(51),
  );

  loaderOverlay.setProgress(0.85);
  loaderOverlay.setStatus("WIRING POST FX");

  const pipeline = createPostProcessing(renderer, scene, camera, {
    rain: world.rain,
    smoke: world.smoke,
  });
  const post = pipeline.post;

  const storedLookPreset = getStoredLookPreset();
  const initialLookPreset =
    storedLookPreset && LOOK_PRESETS[storedLookPreset]
      ? storedLookPreset
      : DEFAULT_LOOK_PRESET;

  pipeline.applyLookPreset(initialLookPreset, {
    bloomPass: pipeline.bloomPass,
    lensflare: pipeline.lensflare,
  });

  const adaptiveDpr = createAdaptiveDprController({
    renderer,
    pipeline,
    // Once FPS forces the pixel ratio down, also shed DOF, lensflare, and
    // billboard video decode — all comparatively expensive once we know the
    // device is struggling.
    onForcedLow: () => {
      performanceProfile.dof = false;
      pipeline.perf.setDofEnabled(false);
      performanceProfile.lensflare = false;
      pipeline.perf.setLensflareEnabled(false);
      world.billboards?.userData?.billboardMaterials?.billboard?.disable();
    },
  });
  adaptiveDpr.onResize();

  // Adaptive DPR must not react to intro / rain-glass FPS — that hitch was
  // permanently locking capable Androids into the low-DPR path before ENTER.
  const adaptiveSampleGate = { allow: false };

  const performanceTools = createPerformanceDevTools({
    pipeline,
    ground: world.ground,
    adaptiveDpr,
    getAllowAdaptiveSample: () => adaptiveSampleGate.allow,
  });

  const walkModeBridge = { onChange: null };

  const cameraDirector = createCameraDirector({
    camera,
    renderer,
    world,
    getFinishedIntro: () => appShell?.isFinishedIntro?.() ?? false,
    onWalkModeChange: (walk) => walkModeBridge.onChange?.(walk),
  });

  let runnerGame = null;
  let xrMode = null;
  if (FEATURES.runner && world.track) {
    loaderOverlay.setStatus("ARMING DRONES");
    runnerGame = await createRunnerGame({
      scene,
      renderer,
      camera,
      world,
      baseFov: getBaseFovForLayout(),
    });
    world.collisionHideExtra = runnerGame.collisionHideObjects;
    runnerGame.setPipeline(pipeline);
    const dayNight = createDayNightCycle({
      sceneResult,
      sky: world.sky,
      envMapBaseIntensity,
      syncEnvironmentIntensity: lighting.syncEnvironmentIntensity,
      requestShadowMapUpdate,
    });
    runnerGame.setDayNight(dayNight);
    world.weather = createWeatherSystem({ world, dayNight, audio: runnerGame.audio });
    runnerGame.setWeather(world.weather);
    world.runnerWarm = runnerGame.warm;
    cameraDirector.setRunner(runnerGame);
    // Tiles beyond the last clone are empty — never draw past them.
    camera.far = Math.min(
      300,
      RUNNER.segmentLength * performanceProfile.runnerSegmentsAhead - 5,
    );
    camera.updateProjectionMatrix();

    // WebXR: always created so desktop PC-VR users get a "VR MODE" button
    // (reloads with ?xr); only an XR-mode renderer can enter directly.
    xrMode = createXRMode({
      renderer,
      scene,
      camera,
      runnerGame,
      world,
      flushDeferredShadowUpdate,
    });
    world.collisionHideExtra = [...world.collisionHideExtra, xrMode.rig];
  }

  const cameraLayout = createCameraLayoutSync({
    camera,
    getWalkControls: () => cameraDirector.walkControls,
  });

  const inspectorSession = createInspectorSession({
    renderer,
    pipeline,
    sceneResult,
    world,
    cameraDirector,
    cameraParams,
    applyCameraFovForLayout: cameraLayout.applyCameraFovForLayout,
    syncWalkEyeHeight: cameraLayout.syncWalkEyeHeight,
    syncLighting: lighting.syncLighting,
    syncEnvironmentIntensity: lighting.syncEnvironmentIntensity,
    envMapBaseIntensity,
    requestShadowMapUpdate,
    adaptiveDpr,
  });

  const appShell = createAppShell({
    renderer,
    camera,
    cameraDirector,
    world,
    pipeline,
    inspectorSession,
    syncLighting: lighting.syncLighting,
  });

  walkModeBridge.onChange = appShell.onWalkModeChange;

  const devApp = createDevAppApi({
    scene,
    world,
    camera,
    controls: cameraDirector.controls,
  });
  if (devApp && runnerGame) {
    devApp.runner = runnerGame;
    devApp.xr = xrMode;
    devApp.camera = camera;
    devApp.renderer = renderer;
    devApp.world = world;
  }
  attachDevPerf(devApp, performanceTools.perfApi);

  const { carEngineAudio, planeEngineAudio, wetFootstepAudio } =
    await appShell.initAudio();
  cameraDirector.setFootstepAudio(wetFootstepAudio);
  attachDevAudio(devApp, carEngineAudio, planeEngineAudio, wetFootstepAudio);

  appShell.bindIdleListeners();
  appShell.bindOrbitIdleListeners(cameraDirector.controls);

  cameraDirector.preparePreRevealPose();

  const introFlow = createIntroFlow({
    pipeline,
    renderer,
    loaderOverlay,
    revealAppUi: () => {
      appShell.revealAppUi();
      runnerGame?.enterMenu();
      xrMode?.setAvailable(true);
      adaptiveSampleGate.allow = true;
    },
    world,
  });

  const renderLoop = createRenderLoop({
    camera,
    cameraDirector,
    world,
    pipeline,
    post,
    performanceTools,
    renderer,
    getRainGlassIntro: introFlow.getRainGlassIntro,
    getIntroActive: introFlow.isIntroActive,
    onFrame: (delta) => appShell.updateHud(delta),
    runnerGame,
    getXRMode: () => xrMode,
  });

  await finalizeStartupLighting({
    loaderOverlay,
    syncLighting: lighting.syncLighting,
    requestShadowMapUpdate,
    renderer,
    scene,
    pipeline,
    camera,
    world,
    post,
  });

  const deferredCompile = compileDeferredStartup({
    renderer,
    scene,
    pipeline,
    camera,
    world,
  }).catch((error) => {
    console.warn("[warmup] Deferred shader compile failed:", error);
  });

  if (shouldCompileBeforeRenderLoop()) {
    await deferredCompile;
  }

  renderLoop.startLoop();

  window.addEventListener("resize", () => {
    syncLayoutClass();
    cameraLayout.onWindowResizeAspect();
    runnerGame?.controls.setBaseFov(getBaseFovForLayout());
    resizeRenderer(renderer, pipeline, adaptiveDpr);
    requestShadowMapUpdate("resize");
  });

  onMobileLayoutChange(() => {
    syncLayoutClass();
    cameraLayout.applyCameraFovForLayout();
    runnerGame?.controls.setBaseFov(getBaseFovForLayout());
  });

  await introFlow.run();

  if (!shouldCompileBeforeRenderLoop()) {
    await deferredCompile;
  }

  // Inspector attaches only via Development Mode (never on load).
  inspectorSession.bootstrapInspector(appShell.settingsPanel);

  if (isDevelopmentModeEnabled()) {
    inspectorSession.revealInspector();
  }
}
