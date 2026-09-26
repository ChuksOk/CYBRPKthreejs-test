import * as THREE from "three/webgpu";
import { collectCollisionHideObjects } from "../world/weather/collisionHideObjects.js";

export function createRenderLoop({
  camera,
  cameraDirector,
  world,
  pipeline,
  post,
  performanceTools,
  renderer,
  getRainGlassIntro,
  getIntroActive,
  onFrame,
  runnerGame = null,
  getXRMode = null,
}) {
  const timer = new THREE.Timer();

  function renderFrame() {
    timer.update();
    const delta = timer.getDelta();
    // WebXR (Meta Quest): controller input first, then the runner poses the
    // rig + game camera (src/xr/createXRMode.js).
    const xr = getXRMode?.();
    const xrActive = xr?.isPresenting() ?? false;
    if (xrActive) {
      xr.beforeUpdate(delta);
    }

    // Runner owns the camera pose in runner mode; it must be final before
    // the height map, rain, reflection and post passes read it.
    runnerGame?.update(delta);
    cameraDirector.update(delta);
    onFrame?.(delta);

    // Dry weather disables the rain: skip its height pass too.
    if (world.rain?.params?.enabled !== false) {
      world.collisionHeight?.update({
        camera,
        hideObjects: collectCollisionHideObjects(world),
      });
    }
    world.rain?.update(delta, camera);

    const introActive = getIntroActive?.() ?? false;

    if (!introActive) {
      world.planes?.update?.(delta);
    }

    world.sky?.update(camera, timer.getElapsed());
    world.ground?.update?.(delta);
    const rainEnabled = world.rain?.params?.enabled ?? false;
    world.ground?.setRippleAmount?.(world.weather?.getRippleAmount() ?? (rainEnabled ? 1 : 0));

    if (!introActive) {
      world.billboards?.userData?.billboardMaterials?.billboard?.update?.(camera);
    }
    const carRainActive = world.carSurfaceRain?.syncProximity({
      camera,
      carRoot: world.car,
      rainEnabled,
    });
    if (carRainActive) {
      world.carSurfaceRain.update(delta);
    }

    if (xrActive) {
      // Stereo: no planar mirror, no post stack (RenderPipeline draws its
      // output quad with XR disabled). Tone mapping still applies.
      xr.afterUpdate(delta);
      xr.render();
      return;
    }

    if (performanceTools?.shouldUpdateGroundReflection()) {
      world.ground?.updateReflection?.(renderer, camera);
    }

    pipeline.syncCameras?.(camera);
    pipeline.dof.updateFocusPoint(cameraDirector.focusPoint, camera);
    getRainGlassIntro?.()?.update();
    post.render();
    // Same task as the render: the WebGPU canvas is still readable.
    runnerGame?.snapshots?.captureIfPending(renderer.domElement);
    performanceTools?.sampleFps();
  }

  function startLoop() {
    renderer.setAnimationLoop(renderFrame);
  }

  function stopLoop() {
    renderer.setAnimationLoop(null);
  }

  function warmFrame() {
    renderFrame();
  }

  return {
    renderFrame,
    startLoop,
    stopLoop,
    warmFrame,
  };
}
