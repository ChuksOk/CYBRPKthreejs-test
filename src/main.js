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
import {
  getStoredLookPreset,
  getStoredVisualStyle,
  isDevelopmentModeEnabled,
  setStoredVisualStyle,
} from "./platform/userPreferences.js";
import { createGraphicsSettings } from "./platform/graphicsSettings.js";
import { createMoebiusSettings } from "./post/moebiusSettings.js";
import { getSfxVolume, setSfxVolume } from "./audio/audioState.js";
import {
  getGameplaySettings,
  resetGameplaySettings,
  setGameplaySetting,
} from "./platform/gameplaySettings.js";
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
  syncLayoutClass();

  loaderOverlay.setProgress(0.03);
  loaderOverlay.setStatus("BOOTING SCENE");

  const camera = createCamera();
  const sceneResult = createScene();
  const { scene, sunLight } = sceneResult;

  loaderOverlay.setProgress(0.1);
  loaderOverlay.setStatus("SPINNING UP RENDERER");

  const { renderer } = await createRenderer();

  loaderOverlay.setProgress(0.2);
  loaderOverlay.setStatus("LINKING WEBGPU");

  const { requestShadowMapUpdate } = createShadowUpdater({
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

  // Visual style (neon grade / Moebius cel shading), toggled from the
  // runner menu and Settings; persisted per browser.
  const visualStyleListeners = new Set();
  const visualStyle = {
    get: () => pipeline.getVisualStyle(),
    set(id) {
      pipeline.setVisualStyle(id);
      setStoredVisualStyle(pipeline.getVisualStyle());
      document.documentElement.classList.toggle("style-moebius", pipeline.getVisualStyle() === "moebius");
      visualStyleListeners.forEach((listener) => listener(pipeline.getVisualStyle()));
    },
    onChange: (listener) => visualStyleListeners.add(listener),
  };
  visualStyle.set(getStoredVisualStyle());
  // Comic-style tuning / presets (live uniform edits, persisted).
  const moebiusSettings = createMoebiusSettings({ moebius: pipeline.moebius });
  moebiusSettings.applyStored();

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
    runnerGame.setVisualStyle(visualStyle);
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
  }

  // Player graphics settings (Settings → Graphics), applied over device defaults.
  const graphics = createGraphicsSettings({
    pipeline,
    ground: world.ground,
    adaptiveDpr,
    rain: world.rain,
    getWeather: () => world.weather ?? null,
  });
  graphics.applyStored();

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
    graphics,
    visualStyle,
    moebiusSettings,
    // Settings → Audio: soundtrack / synth volume + sound effects.
    audio: {
      getMusic: () => runnerGame?.music.getState().settings.volume ?? 0.7,
      setMusic: (value) => runnerGame?.music.setVolume(value),
      getSfx: getSfxVolume,
      setSfx: setSfxVolume,
    },
    gameplay: {
      get: getGameplaySettings,
      set: setGameplaySetting,
      reset: resetGameplaySettings,
      // Touch always auto-aims; the toggle is for mouse players.
      showAimAssist: Boolean(runnerGame) && !runnerGame.controls.isTouch(),
    },
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
  }
  attachDevPerf(devApp, performanceTools.perfApi);
  if (devApp) {
    devApp.graphics = graphics;
  }

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
