import { performanceProfile } from "../platform/performanceProfile.js";

/**
 * WebXR (Meta Quest) support.
 *
 * WebGPU XR sessions need the experimental `XRGPUBinding`, which the Quest
 * browser does not ship yet, so XR mode boots `WebGPURenderer` on its WebGL2
 * backend (`forceWebGL`). The renderer cannot switch backends after load, so
 * the choice is made before `createRenderer()`:
 *
 * - Meta Quest browser, or `?xr` in the URL → XR mode (WebGL2 backend).
 * - `?xrwebgpu` + a browser with `XRGPUBinding` → XR mode on WebGPU.
 * - `?noxr` → never.
 *
 * Desktop browsers with a PC VR runtime keep WebGPU; their "VR" button
 * reloads the page with `?xr` (see createXRButton in createXRMode.js).
 */

const params = new URLSearchParams(window.location.search);

export function isMetaQuestBrowser() {
  const ua = navigator.userAgent || "";
  return /OculusBrowser|Quest/i.test(ua);
}

function hasWebXR() {
  return typeof navigator !== "undefined" && Boolean(navigator.xr?.isSessionSupported);
}

/** Boot in XR mode (decided once, before the renderer exists). */
export function wantsXRMode() {
  if (params.has("noxr") || !hasWebXR()) {
    return false;
  }
  return params.has("xr") || params.has("xrwebgpu") || isMetaQuestBrowser();
}

/** WebGPU XR binding requested and available; otherwise XR uses WebGL2. */
export function wantsWebGPUXR() {
  return params.has("xrwebgpu") && typeof globalThis.XRGPUBinding !== "undefined";
}

export async function isImmersiveVrSupported() {
  if (params.has("noxr") || !hasWebXR()) {
    return false;
  }
  try {
    return await navigator.xr.isSessionSupported("immersive-vr");
  } catch {
    return false;
  }
}

/**
 * Standalone-headset budgets (Quest 2 / 3 / Pro): the scene is drawn twice per
 * frame at 72–90 Hz on a mobile GPU. Call after applyDevicePerformanceDefaults
 * and before createRenderer / createWorld.
 */
export function applyXRPerformanceDefaults() {
  Object.assign(performanceProfile, {
    adaptiveDpr: false,
    maxPixelRatio: 1,
    // Post passes never run in a VR session (see createRenderLoop), but the
    // 2D page still uses them before ENTER VR — keep that view cheap too.
    ao: false,
    lensflare: false,
    dof: false,
    smaa: false,
    billboardsEnabled: false,
    groundResolutionScale: 0.35,
    groundReflectionFrameSkip: 2,
    collisionRainResolution: 256,
    collisionRainFrameSkip: 2,
    collisionRainCount: 2500,
    runnerSegmentsAhead: 1,
    runnerMaxDrones: 6,
    runnerSparkCount: 96,
    runnerTracerCount: 12,
    runnerWeaponLight: false,
    runnerSunShadowInterval: 0,
  });
}

/**
 * While a session is presenting, `Renderer` swaps the XR camera in for every
 * render call — including offscreen passes (rain height map, ground mirror,
 * shadow map). Wrap those so they keep their own camera.
 */
export function withXRDisabled(renderer, callback) {
  const xr = renderer?.xr;
  if (!xr?.isPresenting) {
    return callback();
  }
  const enabled = xr.enabled;
  xr.enabled = false;
  try {
    return callback();
  } finally {
    xr.enabled = enabled;
  }
}
