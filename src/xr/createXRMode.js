import * as THREE from "three/webgpu";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";
import { RUNNER, VIEWMODEL_LAYER } from "../runner/runnerConfig.js";
import { performanceProfile } from "../platform/performanceProfile.js";
import { createXRHud } from "./createXRHud.js";
import { isImmersiveVrSupported, wantsWebGPUXR } from "./xrSupport.js";
import "./xrButton.css";

const RUN_HEADING = -Math.PI / 2; // rig yaw that maps headset forward (−Z) to +X
const STICK_ENGAGE = 0.7;
const STICK_RELEASE = 0.35;
/** Physical duck (m below the recentered head height) that triggers a slide. */
const DUCK_ENTER = 0.3;
const DUCK_EXIT = 0.18;
const DEFAULT_HEAD_HEIGHT = 1.6;
const LASER_COLOR = 0xd9ff3b;

// xr-standard gamepad mapping (Meta Quest Touch controllers).
const BTN_TRIGGER = 0;
const BTN_SQUEEZE = 1;
const BTN_STICK = 3;
const BTN_LOWER = 4; // A / X
const BTN_UPPER = 5; // B / Y

const _scale = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");
const _offset = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _chase = new THREE.Vector3();

/**
 * Meta Quest / WebXR mode for the runner.
 *
 * The game camera stays authoritative for gameplay (hitscan, aim assist,
 * specials, rain / height map centering): in VR it is posed on the right
 * controller's aim ray every frame. The headset renders through a separate
 * XR camera inside a rig that follows the runner:
 *
 *   rig (player x / feet / z, yaw = run heading)
 *    └─ space (recenter: −head yaw, −head xz, eye-height calibration)
 *        ├─ xrCamera (headset pose from WebXR)
 *        └─ controllers + grips (poses from WebXR)
 *    └─ HUD panels (body-locked, always down the run direction)
 *
 * The TSL post stack is bypassed while presenting: `RenderPipeline` renders
 * its output quad with XR disabled, so it cannot drive stereo views.
 */
export function createXRMode({
  renderer,
  scene,
  camera,
  runnerGame,
  world,
  flushDeferredShadowUpdate,
}) {
  const controls = runnerGame.controls;
  const viewmodel = runnerGame.viewmodel;

  const rig = new THREE.Group();
  rig.name = "xr-rig";
  rig.rotation.y = RUN_HEADING;
  rig.visible = false;
  const space = new THREE.Group();
  space.name = "xr-space";
  rig.add(space);
  scene.add(rig);

  const xrCamera = new THREE.PerspectiveCamera(70, 1, 0.05, camera.far);
  xrCamera.name = "xr-camera";
  xrCamera.layers.enable(VIEWMODEL_LAYER);
  space.add(xrCamera);

  const hud = createXRHud({
    domHud: runnerGame.hud,
    onHit: (kill) => pulse("right", kill ? 0.6 : 0.25, kill ? 60 : 18),
    onDamage: (amount) => pulse("both", 0.35 + 0.6 * amount, 90),
  });
  rig.add(hud.group);
  xrCamera.add(hud.damageMesh);

  viewmodel?.setKickListener((strength) => {
    if (active) {
      pulse("right", Math.min(1, 0.22 * strength + 0.12), 22);
    }
  });

  // ── Controllers ────────────────────────────────────────────────────────
  const modelFactory = new XRControllerModelFactory();
  const slots = [0, 1].map((index) => {
    const controller = renderer.xr.getController(index);
    const grip = renderer.xr.getControllerGrip(index);
    const model = modelFactory.createControllerModel(grip);
    grip.add(model);
    space.add(controller, grip);
    const slot = {
      index,
      controller,
      grip,
      model,
      source: null,
      hand: null,
      pressed: [],
      stickArmed: true,
    };
    controller.addEventListener("connected", (event) => {
      slot.source = event.data;
      slot.hand = event.data.handedness === "left" ? "left" : "right";
      slot.pressed.length = 0;
      // The rifle is the right hand's model.
      model.visible = slot.hand === "left";
      if (slot.hand === "right") {
        controller.add(laser);
      }
    });
    controller.addEventListener("disconnected", () => {
      if (laser.parent === controller) {
        controller.remove(laser);
      }
      slot.source = null;
      slot.hand = null;
    });
    return slot;
  });

  function slotFor(hand) {
    return slots.find((slot) => slot.hand === hand && slot.source) ?? null;
  }

  // Aim laser on the right controller (long + faint in play, to the panel in menus).
  const laser = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicNodeMaterial({
      color: LASER_COLOR,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    }),
  );
  laser.name = "xr-laser";
  laser.layers.set(VIEWMODEL_LAYER);
  laser.frustumCulled = false;

  function pulse(hand, intensity, duration) {
    if (!active) {
      return;
    }
    for (const slot of slots) {
      if (!slot.source || (hand !== "both" && slot.hand !== hand)) {
        continue;
      }
      try {
        slot.source.gamepad?.hapticActuators?.[0]?.pulse?.(intensity, duration);
      } catch {
        // Haptics are optional.
      }
    }
  }

  // ── Recenter / calibration ─────────────────────────────────────────────
  let active = false;
  let session = null;
  let recenterPending = false;
  let calibratedHeadY = DEFAULT_HEAD_HEIGHT;
  let duckArmed = true;
  let ducked = false;
  let framesPresented = 0;

  /**
   * Current head pose becomes "standing in lane, facing down the street":
   * yaw and xz drift are cancelled and head height maps to RUNNER.eyeHeight,
   * so seated and standing players see the same view.
   */
  function recenter() {
    // xrCamera's local pose is the raw reference-space head pose.
    _euler.setFromQuaternion(xrCamera.quaternion, "YXZ");
    const yaw = _euler.y;
    const headY = xrCamera.position.y;
    calibratedHeadY = headY > 0.4 ? headY : DEFAULT_HEAD_HEIGHT;
    _offset.set(xrCamera.position.x, 0, xrCamera.position.z).applyAxisAngle(_up, -yaw).negate();
    space.rotation.set(0, -yaw, 0);
    space.position.set(_offset.x, RUNNER.eyeHeight - calibratedHeadY, _offset.z);
    recenterPending = false;
    duckArmed = true;
    ducked = false;
  }

  function duckAmount() {
    return Math.max(0, calibratedHeadY - xrCamera.position.y);
  }

  /**
   * controls pose override: place the rig on the runner, then pose the game
   * camera on the right controller's aim ray (head pose without controllers).
   */
  function applyPose(state, gameCamera) {
    // Slides only lower the view by what the player isn't already ducking.
    const slideDip = Math.min(0, state.eyeHeight - RUNNER.eyeHeight + duckAmount());
    rig.position.set(state.x, state.feetY + slideDip, state.z);
    // Sky Run: ride the game's chase point (behind + above the car, on its
    // smoothed follow path) instead of sitting inside the hull. No roll.
    const chase = THREE.MathUtils.smootherstep(state.flightBlend ?? 0, 0, 1);
    if (chase > 0) {
      _chase.set(
        state.x - RUNNER.chaseDistance,
        state.camY + RUNNER.chaseHeight - RUNNER.eyeHeight,
        state.camZ,
      );
      rig.position.lerp(_chase, chase);
    }
    rig.updateMatrixWorld(true);

    const right = slotFor("right");
    const pose = right?.controller.visible ? right.controller : xrCamera;
    pose.matrixWorld.decompose(gameCamera.position, gameCamera.quaternion, _scale);
    return true;
  }

  // ── Input ──────────────────────────────────────────────────────────────
  function edge(slot, button) {
    const pressed = Boolean(slot.source?.gamepad?.buttons?.[button]?.pressed);
    const was = slot.pressed[button] ?? false;
    slot.pressed[button] = pressed;
    return pressed && !was;
  }

  function held(slot, button) {
    return Boolean(slot?.source?.gamepad?.buttons?.[button]?.pressed);
  }

  /** Flick detection on a thumbstick; returns left / right / up / down once per flick. */
  function stickFlick(slot) {
    const axes = slot.source?.gamepad?.axes;
    if (!axes) {
      return null;
    }
    const x = axes[2] ?? axes[0] ?? 0;
    const y = axes[3] ?? axes[1] ?? 0;
    const magnitude = Math.max(Math.abs(x), Math.abs(y));
    if (!slot.stickArmed) {
      if (magnitude < STICK_RELEASE) {
        slot.stickArmed = true;
      }
      return null;
    }
    if (magnitude < STICK_ENGAGE) {
      return null;
    }
    slot.stickArmed = false;
    if (Math.abs(x) > Math.abs(y)) {
      return x < 0 ? "left" : "right";
    }
    return y < 0 ? "up" : "down";
  }

  const raycaster = new THREE.Raycaster();
  raycaster.layers.enableAll();

  function aimRay(slot) {
    _origin.setFromMatrixPosition(slot.controller.matrixWorld);
    _direction.set(0, 0, -1).transformDirection(slot.controller.matrixWorld);
    raycaster.ray.set(_origin, _direction);
    return raycaster;
  }

  function pollInput() {
    const state = runnerGame.getState();
    const running = state === "running";
    const right = slotFor("right");
    const left = slotFor("left");

    controls.setTrigger(running && held(right, BTN_TRIGGER));

    for (const slot of [right, left]) {
      if (!slot) {
        continue;
      }
      if (edge(slot, BTN_STICK)) {
        recenter();
        pulse(slot.hand, 0.3, 40);
      }
      if (running) {
        const flick = stickFlick(slot);
        if (flick) {
          controls.pushAction(flick === "up" ? "jump" : flick === "down" ? "slide" : flick);
        }
      } else if (hud.isPointing()) {
        // Menus: the stick scrolls whatever list is under the laser.
        const y = slot.source?.gamepad?.axes?.[3] ?? 0;
        if (Math.abs(y) > 0.25) {
          hud.scroll(y * 18);
        }
      }
    }

    if (right) {
      // Menus are the whole flat page (snapshots): the laser clicks it.
      const menus = !running && state !== "dying";
      hud.setMenuMode(menus);
      if (menus) {
        hud.pointAt(aimRay(right));
      }
      const trigger = edge(right, BTN_TRIGGER);
      if (trigger && menus) {
        // Off the panel entirely: trigger still starts / resumes / restarts.
        if (!hud.press() && !hud.isPointing()) {
          runnerGame.xrAction("confirm");
        }
      }
      if (!held(right, BTN_TRIGGER)) {
        hud.release();
      }
      if (edge(right, BTN_SQUEEZE) && running) {
        controls.requestReload();
      }
      if (edge(right, BTN_LOWER)) {
        if (running) {
          controls.pushAction("jump");
        } else if (!hud.click() && !hud.isPointing()) {
          runnerGame.xrAction("confirm");
        }
      }
      if (edge(right, BTN_UPPER)) {
        if (running) {
          controls.pushAction("slide");
        } else {
          runnerGame.xrAction("back");
        }
      }
    }

    if (left) {
      if (edge(left, BTN_TRIGGER) && running) {
        aimRay(left);
        runnerGame.useSpecial({ origin: raycaster.ray.origin, direction: raycaster.ray.direction });
      }
      if (edge(left, BTN_SQUEEZE) && running) {
        controls.selectWeapon("next");
      }
      if (edge(left, BTN_LOWER)) {
        if (running) {
          controls.selectWeapon("prev");
        } else {
          runnerGame.xrAction("daily");
        }
      }
      if (edge(left, BTN_UPPER)) {
        runnerGame.xrAction("pause");
      }
    }

    // Physical duck → slide (held for as long as the player stays down).
    if (running && !recenterPending) {
      const duck = duckAmount();
      if (duckArmed && duck > DUCK_ENTER) {
        duckArmed = false;
        ducked = true;
        controls.pushAction("slide");
      } else if (!duckArmed && duck < DUCK_EXIT) {
        duckArmed = true;
        ducked = false;
      }
      if (ducked && controls.state.grounded) {
        controls.state.slideTime = Math.max(controls.state.slideTime, 0.2);
      }
    }
  }

  // ── Per-frame hooks (createRenderLoop) ─────────────────────────────────
  function beforeUpdate() {
    if (recenterPending && framesPresented > 2 && xrCamera.position.lengthSq() > 0) {
      recenter();
    }
    pollInput();
  }

  function afterUpdate(delta) {
    const state = runnerGame.getState();
    hud.update(delta);

    const menu = state !== "running" && state !== "countdown" && state !== "dying";
    laser.visible = Boolean(laser.parent);
    laser.scale.z = menu ? 4 : 30;
    laser.material.opacity = menu ? 0.8 : 0.22;
  }

  function render() {
    // Draw to the XR layer even if an offscreen pass left a target bound.
    renderer.setRenderTarget(null);
    renderer.render(scene, xrCamera);
    framesPresented += 1;
  }

  // ── Session lifecycle ──────────────────────────────────────────────────
  function onSessionStart() {
    active = true;
    framesPresented = 0;
    recenterPending = true;
    session = renderer.xr.getSession();
    session?.addEventListener("visibilitychange", onVisibilityChange);
    xrCamera.far = camera.far;
    rig.visible = true;
    controls.setXR(true, applyPose);
    viewmodel?.setXRMode(true);
    hud.reset();
    hud.setActive(true);
    runnerGame.setXRHud(hud);
    world.ground?.setReflectionEnabled?.(false);
    document.documentElement.classList.add("xr-presenting");
    if (runnerGame.getState() === "running") {
      runnerGame.pause();
    }
    button.sync();
  }

  function onSessionEnd() {
    active = false;
    session?.removeEventListener("visibilitychange", onVisibilityChange);
    session = null;
    if (runnerGame.getState() === "running") {
      runnerGame.pause();
    }
    rig.visible = false;
    controls.setXR(false);
    viewmodel?.setXRMode(false);
    runnerGame.setXRHud(null);
    hud.setActive(false);
    world.ground?.setReflectionEnabled?.(performanceProfile.groundReflection);
    flushDeferredShadowUpdate?.();
    document.documentElement.classList.remove("xr-presenting");
    for (const slot of slots) {
      slot.pressed.length = 0;
    }
    button.sync();
  }

  function onVisibilityChange() {
    // Quest system menu / headset removed: pause the run.
    if (session?.visibilityState !== "visible" && runnerGame.getState() === "running") {
      runnerGame.pause();
    }
  }

  renderer.xr.addEventListener("sessionstart", onSessionStart);
  renderer.xr.addEventListener("sessionend", onSessionEnd);

  async function enter() {
    if (renderer.xr.isPresenting || !navigator.xr) {
      return;
    }
    runnerGame.audio?.ensureContext?.();
    const webgpu = renderer.backend.isWebGPUBackend === true && wantsWebGPUXR();
    const xrSession = await navigator.xr.requestSession("immersive-vr", {
      requiredFeatures: webgpu ? ["webgpu"] : [],
      optionalFeatures: ["local-floor", "bounded-floor", "layers"],
    });
    await renderer.xr.setSession(xrSession);
  }

  async function exit() {
    await renderer.xr.getSession()?.end();
  }

  // ── ENTER VR button ────────────────────────────────────────────────────
  const button = createXRButton({
    // XR needs the WebGL2 backend unless the WebGPU binding is available;
    // a WebGPU page reloads itself into XR mode.
    canEnterDirectly: renderer.xr.enabled === true,
    onEnter: enter,
    onExit: exit,
    isPresenting: () => renderer.xr.isPresenting,
  });

  isImmersiveVrSupported().then((supported) => {
    button.setSupported(supported);
  });

  return {
    rig,
    xrCamera,
    hud,
    isPresenting: () => active && renderer.xr.isPresenting,
    beforeUpdate,
    afterUpdate,
    render,
    recenter,
    enter,
    exit,
    /** Reveal the ENTER VR button (after the intro hands over to the menu). */
    setAvailable: (value) => button.setAvailable(value),
  };
}

function createXRButton({ canEnterDirectly, onEnter, onExit, isPresenting }) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "xr-enter-button";
  element.textContent = "ENTER VR";
  element.hidden = true;
  element.setAttribute("aria-label", "Enter virtual reality");
  document.body.appendChild(element);

  let supported = false;
  let available = false;
  let busy = false;

  function sync() {
    element.hidden = !(supported && available);
    element.textContent = isPresenting() ? "EXIT VR" : canEnterDirectly ? "ENTER VR" : "VR MODE";
  }

  element.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (busy) {
      return;
    }
    if (!canEnterDirectly) {
      const url = new URL(window.location.href);
      url.searchParams.set("xr", "1");
      window.location.assign(url);
      return;
    }
    busy = true;
    element.disabled = true;
    try {
      if (isPresenting()) {
        await onExit();
      } else {
        await onEnter();
      }
    } catch (error) {
      console.warn("[xr] Could not start the VR session:", error);
      element.textContent = "VR UNAVAILABLE";
      setTimeout(sync, 2000);
    } finally {
      busy = false;
      element.disabled = false;
      sync();
    }
  });

  return {
    element,
    sync,
    setSupported(value) {
      supported = Boolean(value);
      sync();
    },
    setAvailable(value) {
      available = Boolean(value);
      sync();
    },
  };
}
