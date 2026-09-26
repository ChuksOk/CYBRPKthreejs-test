import * as THREE from "three/webgpu";
import { getStaticPixelRatio } from "../platform/performanceProfile.js";
import {
  clearInspectorLayout,
  disableRendererTimestamps,
} from "../debug/inspectorControls.js";

async function getWebGPULimits() {
  if (!navigator.gpu) {
    return {};
  }

  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
    featureLevel: "compatibility",
  });
  if (!adapter) {
    return {};
  }

  const desired = 64;
  const supported = adapter.limits.maxColorAttachmentBytesPerSample;
  if (supported >= desired) {
    return { maxColorAttachmentBytesPerSample: desired };
  }
  if (supported > 32) {
    return { maxColorAttachmentBytesPerSample: supported };
  }
  return {};
}

/**
 * @param {{ xr?: boolean, xrWebGPU?: boolean }} [options]
 *   xr: boot for WebXR (Meta Quest). Uses the WebGL2 backend unless xrWebGPU
 *   (XRGPUBinding) is available — see src/xr/xrSupport.js.
 */
export async function createRenderer({ xr = false, xrWebGPU = false } = {}) {
  const forceWebGL = xr && !xrWebGPU;
  const requiredLimits = forceWebGL ? {} : await getWebGPULimits();

  const renderer = new THREE.WebGPURenderer({
    antialias: false,
    alpha: false,
    powerPreference: "high-performance",
    stencil: false,
    requiredLimits,
    forceWebGL,
  });
  if (xr) {
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType("local-floor");
    // Fixed foveation: cheap on Quest, invisible at the lens edges.
    renderer.xr.setFoveation(1);
    // Standalone headset budget: 90% eye buffers, and plain PCF shadows
    // (the soft filter is sampled per pixel in both eyes).
    renderer.xr.setFramebufferScaleFactor(0.9);
    // r185: XRManager's frame callback passes `_getFrameBufferTarget()`
    // straight to foveateBoundTexture, which is null whenever a render
    // target is still bound at frame start (e.g. a pass threw mid-frame).
    // Unguarded, that one error repeats and kills every later XR frame.
    const foveateBoundTexture = renderer.xr.foveateBoundTexture.bind(renderer.xr);
    renderer.xr.foveateBoundTexture = (renderTarget) =>
      renderTarget ? foveateBoundTexture(renderTarget) : undefined;
  }
  renderer.setPixelRatio(getStaticPixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = xr ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  clearInspectorLayout();

  renderer.domElement.style.opacity = "0";
  renderer.domElement.style.zIndex = "14";
  renderer.domElement.style.transition = "opacity 220ms ease";
  document.body.appendChild(renderer.domElement);

  await renderer.init();
  disableRendererTimestamps(renderer);

  if (import.meta.env.DEV) {
    const backend = renderer.backend.isWebGLBackend
      ? "WebGL2 (fallback)"
      : "WebGPU";
    console.info(`[renderer] ${backend}`);
  }

  return { renderer, inspector: null };
}

export function createShadowUpdater({ renderer, getSunLight }) {
  let deferred = false;

  function requestShadowMapUpdate() {
    const sunLight = getSunLight?.();
    if (!sunLight || !renderer) {
      return;
    }

    // In a WebXR session the renderer would draw the shadow map with the XR
    // camera (it swaps it in for every render call); keep the last map and
    // refresh once the session ends.
    if (renderer.xr?.isPresenting) {
      deferred = true;
      return;
    }

    sunLight.shadow.needsUpdate = true;
    renderer.shadowMap.needsUpdate = true;
  }

  function flushDeferredShadowUpdate() {
    if (deferred) {
      deferred = false;
      requestShadowMapUpdate();
    }
  }

  return { requestShadowMapUpdate, flushDeferredShadowUpdate };
}

export function applyRendererPixelRatio(renderer, pipeline, dpr) {
  const width = window.innerWidth;
  const height = window.innerHeight;

  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height);
  pipeline?.resizePostProcessing?.(width, height);
}

export function resizeRenderer(renderer, pipeline, adaptiveDpr = null) {
  if (adaptiveDpr) {
    adaptiveDpr.onResize();
    return;
  }

  applyRendererPixelRatio(renderer, pipeline, getStaticPixelRatio());
}
