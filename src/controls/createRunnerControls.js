import * as THREE from "three/webgpu";
import { isCoarsePointerDevice } from "../platform/deviceLayout.js";
import { RUNNER } from "../runner/runnerConfig.js";

const RUN_HEADING = -Math.PI / 2; // camera yaw that looks down +X
const MOUSE_SENSITIVITY = 0.0021;
const TOUCH_LOOK_SENSITIVITY = 0.0048;
const SWIPE_MIN_DISTANCE = 28;
const SWIPE_MAX_TIME = 450;
const HEAD_BOB_FREQ = 1.55; // strides per meter-ish scale
const HEAD_BOB_AMOUNT = 0.045;

function expLerpFactor(delta, speed) {
  return 1 - Math.exp(-delta * speed);
}

/** Damped spring acceleration toward `target` (frequency in Hz, ζ damping). */
function springAccel(x, v, target, hz, damping) {
  const omega = Math.PI * 2 * hz;
  return omega * omega * (target - x) - 2 * damping * omega * v;
}

function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

/**
 * First-person runner input + camera. The player auto-runs along +X; lanes,
 * jump and slide are discrete actions while mouse / right-thumb aim freely
 * inside a cone around the run heading.
 */
export function createRunnerControls({ camera, domElement, baseFov = 70 }) {
  const state = {
    active: false,
    inputEnabled: false,
    x: RUNNER.startX,
    lane: 1,
    z: RUNNER.laneZ[1],
    laneVelocity: 0,
    feetY: RUNNER.floorY,
    vy: 0,
    grounded: true,
    slideTime: 0,
    eyeHeight: RUNNER.eyeHeight,
    speed: RUNNER.startSpeed,
    yaw: 0,
    pitch: 0,
    recoilPitch: 0,
    recoilYaw: 0,
    shakeTime: 0,
    shakeStrength: 0,
    bobPhase: 0,
    trigger: false,
    pointerLocked: false,
    // Sky Run (flying car): discrete lanes × altitude tiers, chase camera.
    flying: false,
    flightBlend: 0, // 0 = first person on foot … 1 = chase cam behind the car
    tier: 1,
    flightY: RUNNER.floorY + RUNNER.flightAltitudes[1],
    flightVy: 0,
    flightVz: 0,
    flightAy: 0,
    flightAz: 0,
    // Chase-camera follow point (lags the car so it swings across frame).
    camY: 0,
    camZ: 0,
    // Barrel roll (steer into the wall at an outer lane): 0 = none.
    rollTime: 0,
    rollDir: 0,
  };

  let currentBaseFov = baseFov;
  const euler = new THREE.Euler(0, 0, 0, "YXZ");
  const listeners = { jump: new Set(), land: new Set(), lane: new Set(), slide: new Set(), climb: new Set(), roll: new Set(), lockChange: new Set(), reload: new Set(), weapon: new Set(), special: new Set() };
  const actionQueue = [];

  const touchLook = new Map();
  const touchSwipes = new Map();
  const coarse = isCoarsePointerDevice();

  function emit(name, payload) {
    for (const listener of listeners[name]) {
      listener(payload);
    }
  }

  function on(name, listener) {
    listeners[name].add(listener);
    return () => listeners[name].delete(listener);
  }

  function queue(action) {
    if (!state.active || !state.inputEnabled) {
      return;
    }
    actionQueue.push(action);
  }

  function applyLookDelta(dx, dy) {
    state.yaw = THREE.MathUtils.clamp(state.yaw - dx, -RUNNER.maxYaw, RUNNER.maxYaw);
    state.pitch = THREE.MathUtils.clamp(state.pitch - dy, RUNNER.minPitch, RUNNER.maxPitch);
  }

  // ── Keyboard ────────────────────────────────────────────────────────────
  function onKeyDown(event) {
    if (!state.active || isEditableTarget(event.target) || event.repeat) {
      return;
    }
    switch (event.code) {
      case "KeyA":
      case "ArrowLeft":
        queue("left");
        break;
      case "KeyD":
      case "ArrowRight":
        queue("right");
        break;
      case "Space":
      case "KeyW":
      case "ArrowUp":
        queue("jump");
        event.preventDefault();
        break;
      case "KeyS":
      case "ArrowDown":
      case "ControlLeft":
      case "KeyC":
        queue("slide");
        break;
      case "KeyR":
        if (state.inputEnabled) {
          emit("reload");
        }
        break;
      case "Digit1":
      case "Digit2":
      case "Digit3":
      case "Digit4":
        if (state.inputEnabled) {
          emit("weapon", Number(event.code.slice(5)) - 1);
        }
        break;
      case "KeyE":
      case "KeyF":
        if (state.inputEnabled) {
          emit("special");
        }
        break;
      case "KeyQ":
        if (state.inputEnabled) {
          emit("weapon", "next");
        }
        break;
      default:
        return;
    }
  }

  // ── Mouse (pointer lock) ────────────────────────────────────────────────
  function onMouseMove(event) {
    if (!state.active || !state.inputEnabled || !state.pointerLocked) {
      return;
    }
    applyLookDelta(event.movementX * MOUSE_SENSITIVITY, event.movementY * MOUSE_SENSITIVITY);
    // Deliberate mouse aim briefly suspends PC aim assist (tiny jitter doesn't).
    if (Math.abs(event.movementX) + Math.abs(event.movementY) > 4) {
      lastMouseLook = performance.now();
    }
  }

  function onMouseDown(event) {
    if (event.button !== 0 || !state.active) {
      return;
    }
    if (state.pointerLocked && state.inputEnabled) {
      state.trigger = true;
    }
  }

  function onMouseUp(event) {
    if (event.button === 0) {
      state.trigger = false;
    }
  }

  let wheelCooldown = 0;
  function onWheel(event) {
    if (!state.active || !state.inputEnabled || !state.pointerLocked) {
      return;
    }
    const now = performance.now();
    if (now < wheelCooldown || Math.abs(event.deltaY) < 1) {
      return;
    }
    wheelCooldown = now + 180;
    emit("weapon", event.deltaY > 0 ? "next" : "prev");
  }

  function onPointerLockChange() {
    state.pointerLocked = document.pointerLockElement === domElement;
    if (!state.pointerLocked) {
      state.trigger = false;
    }
    emit("lockChange", state.pointerLocked);
  }

  function requestPointerLock() {
    if (coarse || state.pointerLocked) {
      return;
    }
    try {
      const result = domElement.requestPointerLock?.();
      result?.catch?.(() => {});
    } catch {
      // Pointer lock may be refused (iframe / user setting) — aim still works unlocked.
    }
  }

  function exitPointerLock() {
    if (document.pointerLockElement === domElement) {
      document.exitPointerLock?.();
    }
  }

  // ── Touch: left half = swipes, right half = aim drag (auto-aim otherwise) ─
  let lastManualLook = -1e9;
  let lastMouseLook = -1e9;
  const _aimDir = new THREE.Vector3();

  /**
   * Touch auto-aim: ease the look toward a world point (or back to the run
   * heading when null). A manual drag suspends it for a moment.
   */
  /**
   * @param {THREE.Vector3|null} target
   * @param {number} delta
   * @param {{ recenter?: boolean, speed?: number, holdMs?: number }} [options]
   *   recenter: ease back to the run heading with no target (touch);
   *   speed: pull rate toward a target; holdMs: pause after manual look.
   */
  function autoAim(target, delta, { recenter = true, speed: targetSpeed = 7, holdMs = 900 } = {}) {
    const now = performance.now();
    if (!state.active || !state.inputEnabled || now - lastManualLook < holdMs || now - lastMouseLook < holdMs) {
      return;
    }
    if (!target && !recenter) {
      return;
    }
    let yaw = 0;
    let pitch = 0.04;
    let speed = 2.5;
    if (target) {
      _aimDir.copy(target).sub(camera.position).normalize();
      const worldYaw = Math.atan2(-_aimDir.x, -_aimDir.z);
      yaw = THREE.MathUtils.euclideanModulo(worldYaw - RUN_HEADING + Math.PI, Math.PI * 2) - Math.PI;
      pitch = Math.asin(THREE.MathUtils.clamp(_aimDir.y, -1, 1));
      speed = targetSpeed;
    }
    yaw = THREE.MathUtils.clamp(yaw, -RUNNER.maxYaw, RUNNER.maxYaw);
    pitch = THREE.MathUtils.clamp(pitch, RUNNER.minPitch, RUNNER.maxPitch);
    const blend = expLerpFactor(delta, speed);
    state.yaw += (yaw - state.yaw) * blend;
    state.pitch += (pitch - state.pitch) * blend;
  }

  function onPointerDown(event) {
    if (!state.active || event.pointerType === "mouse") {
      return;
    }
    const leftHalf = event.clientX < window.innerWidth * 0.5;
    if (leftHalf) {
      touchSwipes.set(event.pointerId, { x: event.clientX, y: event.clientY, t: performance.now() });
    } else {
      touchLook.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
  }

  function onPointerMove(event) {
    const look = touchLook.get(event.pointerId);
    if (!look || !state.inputEnabled) {
      return;
    }
    applyLookDelta(
      (event.clientX - look.x) * TOUCH_LOOK_SENSITIVITY,
      (event.clientY - look.y) * TOUCH_LOOK_SENSITIVITY,
    );
    lastManualLook = performance.now();
    look.x = event.clientX;
    look.y = event.clientY;
  }

  function onPointerUp(event) {
    touchLook.delete(event.pointerId);
    const swipe = touchSwipes.get(event.pointerId);
    touchSwipes.delete(event.pointerId);
    if (!swipe) {
      return;
    }
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    const dt = performance.now() - swipe.t;
    if (dt > SWIPE_MAX_TIME || Math.hypot(dx, dy) < SWIPE_MIN_DISTANCE) {
      return;
    }
    if (Math.abs(dx) > Math.abs(dy)) {
      queue(dx < 0 ? "left" : "right");
    } else {
      queue(dy < 0 ? "jump" : "slide");
    }
  }

  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("mousemove", onMouseMove);
  domElement.addEventListener("mousedown", onMouseDown);
  document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("pointerlockchange", onPointerLockChange);
  document.addEventListener("wheel", onWheel, { passive: true });
  domElement.addEventListener("pointerdown", onPointerDown);
  domElement.addEventListener("pointermove", onPointerMove);
  domElement.addEventListener("pointerup", onPointerUp);
  domElement.addEventListener("pointercancel", onPointerUp);

  // ── Simulation ──────────────────────────────────────────────────────────
  function processActions() {
    while (actionQueue.length > 0) {
      const action = actionQueue.shift();
      // Flying: the same inputs steer the car — lanes left / right, jump =
      // climb a tier, slide = dive a tier.
      if (state.flying) {
        const lastLane = RUNNER.flightLaneZ.length - 1;
        if (action === "left" && state.lane > 0) {
          state.lane -= 1;
          emit("lane", state.lane);
        } else if (action === "right" && state.lane < lastLane) {
          state.lane += 1;
          emit("lane", state.lane);
        } else if ((action === "left" || action === "right") && state.rollTime <= 0) {
          // Already at the edge: barrel roll instead.
          state.rollTime = RUNNER.flightRollDuration;
          state.rollDir = action === "left" ? -1 : 1;
          emit("roll", state.rollDir);
        } else if (action === "jump" && state.tier < RUNNER.flightAltitudes.length - 1) {
          state.tier += 1;
          emit("climb", state.tier);
        } else if (action === "slide" && state.tier > 0) {
          state.tier -= 1;
          emit("climb", state.tier);
        }
        continue;
      }
      if (action === "left" && state.lane > 0) {
        state.lane -= 1;
        emit("lane", state.lane);
      } else if (action === "right" && state.lane < RUNNER.laneZ.length - 1) {
        state.lane += 1;
        emit("lane", state.lane);
      } else if (action === "jump") {
        if (state.grounded) {
          state.vy = RUNNER.jumpVelocity;
          state.grounded = false;
          state.slideTime = 0;
          emit("jump");
        }
      } else if (action === "slide") {
        if (!state.grounded) {
          // Fast-fall into a slide.
          state.vy = Math.min(state.vy, -RUNNER.jumpVelocity);
        }
        state.slideTime = RUNNER.slideDuration;
        emit("slide");
      }
    }
  }

  function simulate(delta) {
    processActions();

    state.x += state.speed * delta;

    state.flightBlend = THREE.MathUtils.clamp(state.flightBlend + (state.flying ? delta / 1.1 : -delta / 0.8), 0, 1);
    if (state.flying) {
      // Flight: spring-damper toward the lane / tier, so a switch
      // accelerates, glides and settles with a hint of overshoot (and
      // chained presses blend instead of snapping).
      const spring = RUNNER.flightSpring;
      state.flightAz = springAccel(state.z, state.flightVz, RUNNER.flightLaneZ[state.lane], spring.lateralHz, spring.lateralDamping);
      state.flightVz += state.flightAz * delta;
      state.z += state.flightVz * delta;
      state.laneVelocity = state.flightVz;
      // Lift-off climbs from the runner's eye height.
      const targetY = RUNNER.floorY + RUNNER.flightAltitudes[state.tier];
      state.flightAy = springAccel(state.flightY, state.flightVy, targetY, spring.verticalHz, spring.verticalDamping);
      state.flightVy += state.flightAy * delta;
      state.flightY += state.flightVy * delta;
      state.rollTime = Math.max(0, state.rollTime - delta);
    } else {
      // Lane: critically damped spring toward the lane center.
      const targetZ = RUNNER.laneZ[state.lane];
      const previousZ = state.z;
      state.z += (targetZ - state.z) * expLerpFactor(delta, RUNNER.laneChangeSpeed);
      state.laneVelocity = delta > 0 ? (state.z - previousZ) / delta : 0;
    }
    // Chase-camera follow point trails the car.
    state.camZ += (state.z - state.camZ) * expLerpFactor(delta, 4.2);
    state.camY += (state.flightY - state.camY) * expLerpFactor(delta, 3.4);

    // Vertical.
    if (state.flying) {
      // The runner rides in the car: keep the body parked at the car.
      state.feetY = state.flightY - state.eyeHeight;
      state.vy = 0;
      state.grounded = false;
    } else if (!state.grounded) {
      state.vy -= RUNNER.gravity * delta;
      state.feetY += state.vy * delta;
      if (state.feetY <= RUNNER.floorY) {
        state.feetY = RUNNER.floorY;
        state.vy = 0;
        state.grounded = true;
        emit("land");
      }
    }

    if (state.slideTime > 0) {
      state.slideTime = Math.max(0, state.slideTime - delta);
    }
    const targetEye = state.slideTime > 0 ? RUNNER.slideEyeHeight : RUNNER.eyeHeight;
    state.eyeHeight += (targetEye - state.eyeHeight) * expLerpFactor(delta, 16);

    if (state.grounded) {
      state.bobPhase += delta * state.speed * HEAD_BOB_FREQ * 0.5;
    }

    // Recoil recovers toward zero.
    const recover = expLerpFactor(delta, 9);
    state.recoilPitch -= state.recoilPitch * recover;
    state.recoilYaw -= state.recoilYaw * recover;

    if (state.shakeTime > 0) {
      state.shakeTime = Math.max(0, state.shakeTime - delta);
    }
  }

  const _shake = new THREE.Vector3();
  const _chase = new THREE.Vector3();
  const _crashTarget = new THREE.Vector3();
  const _crashPos = new THREE.Vector3();
  const _crashOffset = new THREE.Vector3(-5.2, 1.9, 3.4);
  // Crash cinematic (Sky Run car destroyed): pushes in on the wreck.
  let crashCam = null;

  function applyCamera(delta) {
    const bobActive = state.grounded && state.slideTime <= 0 ? 1 : 0;
    const bobY = Math.abs(Math.sin(state.bobPhase * Math.PI)) * HEAD_BOB_AMOUNT * bobActive;
    const bobRoll = Math.sin(state.bobPhase * Math.PI) * 0.004 * bobActive;

    const shake = state.shakeTime > 0 ? state.shakeStrength * (state.shakeTime / 0.35) : 0;
    _shake.set(
      (Math.random() - 0.5) * shake,
      (Math.random() - 0.5) * shake,
      (Math.random() - 0.5) * shake,
    );

    camera.position.set(
      state.x,
      state.feetY + state.eyeHeight + bobY - HEAD_BOB_AMOUNT * 0.5 + _shake.y,
      state.z + _shake.z,
    );

    // Sky Run chase cam: behind and above the car, trailing its steering.
    const chase = THREE.MathUtils.smootherstep(state.flightBlend, 0, 1);
    if (chase > 0) {
      _chase.set(
        state.x - RUNNER.chaseDistance,
        state.camY + RUNNER.chaseHeight + _shake.y * 2,
        state.camZ + _shake.z * 2,
      );
      camera.position.lerp(_chase, chase);
    }

    // On foot: lean into lane changes. Chase cam: a light roll with the
    // car's bank (lateral velocity + acceleration), never the barrel roll.
    const footRoll = THREE.MathUtils.clamp(-state.laneVelocity * 0.012, -0.12, 0.12) + bobRoll;
    const chaseRoll = THREE.MathUtils.clamp(-(state.flightVz * 0.012 + state.flightAz * 0.0011), -0.14, 0.14);
    const roll = THREE.MathUtils.lerp(footRoll, chaseRoll, chase);
    euler.set(
      state.pitch + state.recoilPitch + _shake.x * 0.4,
      RUN_HEADING + state.yaw + state.recoilYaw,
      roll,
      "YXZ",
    );
    camera.quaternion.setFromEuler(euler);

    // Speed FOV kick.
    const speedT = THREE.MathUtils.clamp(
      (state.speed - RUNNER.startSpeed) / (RUNNER.maxSpeed - RUNNER.startSpeed),
      0,
      1,
    );
    if (crashCam) {
      applyCrashCam();
      return;
    }

    // Flight: wider view plus a small punch on fast strafes / dives.
    const strafePunch = state.flying ? Math.min(4, Math.hypot(state.flightVz, state.flightVy) * 0.35) : 0;
    const targetFov = currentBaseFov + 4 + speedT * 10 + state.flightBlend * 8 + strafePunch;
    const nextFov = camera.fov + (targetFov - camera.fov) * expLerpFactor(delta, 3);
    if (Math.abs(nextFov - camera.fov) > 0.001) {
      camera.fov = nextFov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
  }

  /**
   * Zoom into the exploding car: from wherever the camera is, ease to a
   * three-quarter close-up of the wreck, look at it, narrow the FOV.
   * Real-time driven so the game's slow-mo doesn't stretch it.
   */
  function applyCrashCam() {
    const t = Math.min(1, (performance.now() - crashCam.start) / (crashCam.duration * 1000));
    const push = THREE.MathUtils.smootherstep(Math.min(1, t * 1.5), 0, 1);
    crashCam.getTarget(_crashTarget);
    // Slow orbit around the wreck while pushing in.
    _crashOffset.set(-6.4 + t * 1.0, 2.4 - t * 0.3, 4.2 - t * 1.2);
    _crashPos.copy(_crashTarget).add(_crashOffset);
    camera.position.lerpVectors(crashCam.from, _crashPos, push);
    const shake = state.shakeTime > 0 ? state.shakeStrength * 0.5 : 0;
    camera.position.x += (Math.random() - 0.5) * shake;
    camera.position.y += (Math.random() - 0.5) * shake;
    camera.lookAt(_crashTarget);
    const fov = THREE.MathUtils.lerp(crashCam.fromFov, 45, push);
    if (Math.abs(fov - camera.fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
  }

  /** @param {(target: THREE.Vector3) => THREE.Vector3} getTarget */
  function startCrashCam(getTarget, duration = 1.6) {
    crashCam = {
      getTarget,
      duration,
      start: performance.now(),
      from: camera.position.clone(),
      fromFov: camera.fov,
    };
  }

  function stopCrashCam() {
    crashCam = null;
  }

  function update(delta, { simulateMovement = true } = {}) {
    if (!state.active) {
      return;
    }
    if (simulateMovement && delta > 0) {
      simulate(delta);
    } else {
      actionQueue.length = 0;
    }
    applyCamera(delta);
  }

  function reset() {
    state.x = RUNNER.startX;
    state.lane = 1;
    state.z = RUNNER.laneZ[1];
    state.laneVelocity = 0;
    state.feetY = RUNNER.floorY;
    state.vy = 0;
    state.grounded = true;
    state.slideTime = 0;
    state.eyeHeight = RUNNER.eyeHeight;
    state.speed = RUNNER.startSpeed;
    state.yaw = 0;
    state.pitch = 0;
    state.recoilPitch = 0;
    state.recoilYaw = 0;
    state.shakeTime = 0;
    state.trigger = false;
    state.flying = false;
    state.flightBlend = 0;
    state.tier = 1;
    state.flightY = RUNNER.floorY + RUNNER.flightAltitudes[1];
    state.flightVy = 0;
    state.flightVz = 0;
    state.flightAy = 0;
    state.flightAz = 0;
    state.camY = state.flightY;
    state.camZ = state.z;
    state.rollTime = 0;
    crashCam = null;
    actionQueue.length = 0;
    applyCamera(1);
  }

  /**
   * Sky Run on / off. Taking off starts the car at eye height and climbs to
   * the middle tier; landing drops the runner from the car (gravity), and
   * the camera blends back to first person.
   */
  function setFlight(on) {
    if (Boolean(on) === state.flying) {
      return;
    }
    state.flying = Boolean(on);
    actionQueue.length = 0;
    if (state.flying) {
      state.tier = 1;
      state.flightY = state.feetY + state.eyeHeight;
      state.flightVy = 0;
      state.flightVz = 0;
      state.flightAy = 0;
      state.flightAz = 0;
      state.camY = state.flightY;
      state.camZ = state.z;
      state.rollTime = 0;
      state.lane = Math.min(state.lane, RUNNER.flightLaneZ.length - 1);
      state.slideTime = 0;
    } else {
      state.flightVz = 0;
      state.flightAz = 0;
      state.rollTime = 0;
      state.feetY = Math.max(RUNNER.floorY, state.flightY - state.eyeHeight);
      state.vy = 0;
      state.grounded = state.feetY <= RUNNER.floorY;
    }
  }

  function setActive(value) {
    state.active = Boolean(value);
    if (!state.active) {
      state.trigger = false;
      exitPointerLock();
    }
  }

  function setInputEnabled(value) {
    state.inputEnabled = Boolean(value);
    if (!state.inputEnabled) {
      state.trigger = false;
      actionQueue.length = 0;
    }
  }

  function addRecoil(pitch, yaw) {
    state.recoilPitch += pitch;
    state.recoilYaw += yaw;
  }

  /**
   * @param {{x:number,y:number}} [direction]  optional screen-space push
   *   (x right, y up): kicks the view away from the event, then recovers.
   */
  function shake(strength, duration = 0.35, direction = null) {
    if (direction) {
      state.recoilYaw -= direction.x * strength * 0.9;
      state.recoilPitch += direction.y * strength * 0.9;
    }
    state.shakeStrength = Math.max(strength, state.shakeTime > 0 ? state.shakeStrength : 0);
    state.shakeTime = Math.max(state.shakeTime, duration);
  }

  /** Floating-origin wrap: move the player without any visual change. */
  function shiftX(dx) {
    state.x += dx;
    camera.position.x += dx;
    camera.updateMatrixWorld();
  }

  /** Aim-down direction snapshot used by aim assist on touch. */
  function getPlayerBox(target) {
    if (state.flying && state.flightBlend > 0.35) {
      // The car's hull (Quadra ≈ 5.6 × 1.4 × 2.6 m, slightly forgiving).
      target.min.set(state.x - 2.5, state.flightY - 0.55, state.z - 1.2);
      target.max.set(state.x + 2.5, state.flightY + 0.6, state.z + 1.2);
      return target;
    }
    const halfW = 0.3;
    target.min.set(state.x - halfW, state.feetY, state.z - 0.35);
    target.max.set(state.x + halfW, state.feetY + state.eyeHeight + 0.15, state.z + 0.35);
    return target;
  }

  function dispose() {
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("mousemove", onMouseMove);
    domElement.removeEventListener("mousedown", onMouseDown);
    document.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("pointerlockchange", onPointerLockChange);
    document.removeEventListener("wheel", onWheel);
    domElement.removeEventListener("pointerdown", onPointerDown);
    domElement.removeEventListener("pointermove", onPointerMove);
    domElement.removeEventListener("pointerup", onPointerUp);
    domElement.removeEventListener("pointercancel", onPointerUp);
  }

  return {
    state,
    on,
    update,
    reset,
    setActive,
    setInputEnabled,
    isActive: () => state.active,
    isPointerLocked: () => state.pointerLocked,
    isTouch: () => coarse,
    requestPointerLock,
    exitPointerLock,
    setBaseFov: (value) => {
      currentBaseFov = value;
    },
    setSpeed: (value) => {
      state.speed = value;
    },
    isTriggerHeld: () => state.trigger,
    /** On-screen fire button (touch). */
    setTrigger: (held) => {
      state.trigger = Boolean(held) && state.inputEnabled;
    },
    autoAim,
    /** Special attack (touch button / E key). */
    triggerSpecial: () => emit("special"),
    /** Programmatic weapon select (HUD chips on touch). */
    selectWeapon: (index) => emit("weapon", index),
    addRecoil,
    shake,
    shiftX,
    setFlight,
    isFlying: () => state.flying,
    startCrashCam,
    stopCrashCam,
    getPlayerBox,
    dispose,
  };
}
