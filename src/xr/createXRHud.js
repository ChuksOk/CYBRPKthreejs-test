import * as THREE from "three/webgpu";
import { VIEWMODEL_LAYER } from "../runner/runnerConfig.js";
import { createDomSnapshotter } from "./domSnapshot.js";
import { createXRHudCards } from "./createXRHudCards.js";

/** Menu panel: metres per CSS px, and where it floats (player space). */
const SCREEN_METRES_PER_PX = 0.0021;
const SCREEN_DISTANCE = 2.2;
const SCREEN_EYE_Y = 1.5;
/** Left out of the page snapshot: the scene, the in-run HUD, dev tooling. */
const SCREEN_SKIP =
  "canvas, video, iframe, .runner-hud, .xr-enter-button, .intro-container, .intro-overlay, #app-loader, .loader-overlay, #inspector, .inspector, [data-xr-skip]";
/** Page elements that never count towards the panel crop. */
const CROP_IGNORE = new Set(["CANVAS", "SCRIPT", "STYLE", "LINK", "NOSCRIPT"]);
const CROP_MARGIN = 14;

/** Structural change → re-snapshot quickly; ticking bars / clocks → rarely. */
const MAJOR_DELAY = 0.08;
const MINOR_INTERVAL = 1.5;
const SNAPSHOT_SCALE = 1.5;

const CLICKABLE =
  "button, a[href], input, label, select, summary, [data-action], [data-special], [role='button'], [role='tab'], [role='switch'], [onclick], [tabindex]:not([tabindex='-1'])";

const _local = new THREE.Vector3();

function makeTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  return texture;
}

function isShown(element) {
  if (!element?.isConnected || CROP_IGNORE.has(element.tagName)) {
    return false;
  }
  if (element.checkVisibility && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

/**
 * Bounding box of the visible UI (CSS px). Full-viewport containers (the
 * runner screen, overlays) contribute their children, so the panel hugs the
 * ticket instead of the whole viewport.
 */
function visibleUiRect(skip) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  const addRect = (element, depth) => {
    if (element.matches(skip) || !isShown(element)) {
      return;
    }
    const rect = element.getBoundingClientRect();
    const fullScreen = rect.width >= vw * 0.95 && rect.height >= vh * 0.95;
    if (fullScreen && depth < 3 && element.children.length) {
      for (const child of element.children) {
        addRect(child, depth + 1);
      }
      return;
    }
    box.left = Math.min(box.left, rect.left);
    box.top = Math.min(box.top, rect.top);
    box.right = Math.max(box.right, rect.right);
    box.bottom = Math.max(box.bottom, rect.bottom);
  };
  for (const child of document.body.children) {
    addRect(child, 0);
  }
  if (!Number.isFinite(box.left)) {
    return null;
  }
  return {
    left: Math.max(0, box.left - CROP_MARGIN),
    top: Math.max(0, box.top - CROP_MARGIN),
    right: Math.min(vw, box.right + CROP_MARGIN),
    bottom: Math.min(vh, box.bottom + CROP_MARGIN),
  };
}

/**
 * Jump running (finite) CSS animations / transitions on the page UI to their
 * end state. The snapshot shows the final state, so rects measured
 * mid-entrance would not match it — and while the headset presents, the flat
 * page stops producing frames, so its animations never advance on their own
 * (a screen stuck at opacity 0 was left out of the crop entirely).
 * `html.xr-presenting` also disables new ones (xrButton.css).
 */
function finishAnimations(skip) {
  for (const animation of document.getAnimations()) {
    const target = animation.effect?.target;
    const iterations = animation.effect?.getTiming?.().iterations;
    if (iterations === Infinity || !(target instanceof Element) || target.closest(skip)) {
      continue;
    }
    try {
      animation.finish();
    } catch {
      animation.cancel();
    }
  }
}

/**
 * Tickets are laid out for a desktop window; the headset's page viewport is
 * often shorter, which clips the bottom. Zoom the runner screen's content
 * (live DOM and snapshot alike) until it fits; the panel is scaled back up
 * in metres so its physical size stays the same. Returns the zoom.
 */
function fitRunnerScreen(screen) {
  const content = screen?.firstElementChild;
  if (!content || !screen.dataset.mode) {
    return 1;
  }
  screen.style.setProperty("--xr-fit", "1");
  // Layout sizes (not transformed rects): unaffected by entry animations.
  const width = content.offsetWidth;
  const height = content.offsetHeight;
  if (!width || !height) {
    return 1;
  }
  const zoom = Math.min(1, (window.innerHeight - 24) / height, (window.innerWidth - 24) / width);
  const fit = Math.max(0.45, Math.floor(zoom * 100) / 100);
  screen.style.setProperty("--xr-fit", String(fit));
  return fit;
}

/** PlaneGeometry(1,1) UVs → a CSS-px rect of a viewport-sized snapshot. */
function cropQuad(mesh, rect, width, height) {
  const u0 = rect.left / width;
  const u1 = rect.right / width;
  const v0 = 1 - rect.bottom / height;
  const v1 = 1 - rect.top / height;
  const uv = mesh.geometry.attributes.uv;
  uv.setXY(0, u0, v1);
  uv.setXY(1, u1, v1);
  uv.setXY(2, u0, v0);
  uv.setXY(3, u1, v0);
  uv.needsUpdate = true;
}

/**
 * VR HUD, adapted from the flat UI so the headset keeps its look and all of
 * its functionality:
 *
 * - Menus (start ticket, pause, game over, upgrades, armory, missions,
 *   records, soundtrack, style, countdown, settings, about): the page is
 *   snapshotted without its backdrops (domSnapshot.js + the
 *   `html.xr-presenting` rules in xrButton.css) and cropped to the visible UI,
 *   so the tickets float in the street. The laser drives the real page —
 *   clicks, slider drags, dropdowns (cycled) and scrolling.
 * - Runs: native canvas cards painted from the live flat HUD values
 *   (createXRHudCards.js) — cheap enough for a standalone headset.
 *
 * DOM HUD calls still arrive through mirrorHud (createRunnerGame.js); only
 * flashDamage / hitMarker need VR-side work (red shell + haptics).
 */
export function createXRHud({ domHud, onHit = null, onDamage = null } = {}) {
  const group = new THREE.Group();
  group.name = "xr-hud";
  const snapshotter = createDomSnapshotter();

  // ── Menu panel ─────────────────────────────────────────────────────────
  const screenCanvas = document.createElement("canvas");
  const screenMaterial = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), screenMaterial);
  screenMesh.name = "xr-hud-screen";
  screenMesh.renderOrder = 1002;
  screenMesh.frustumCulled = false;
  screenMesh.layers.set(VIEWMODEL_LAYER);
  screenMesh.visible = false;
  group.add(screenMesh);
  let screenTexture = null;
  let textureSize = { width: 0, height: 0 };

  const screenState = {
    shown: false, // menus: the page panel is wanted
    busy: false,
    majorAt: -1, // time a structural change is due (−1 = none)
    minorDirty: false,
    lastSnapshot: -Infinity,
    rect: null, // CSS px crop of the viewport shown on the panel
    metresPerPx: SCREEN_METRES_PER_PX,
    token: 0, // bumps when a stuck snapshot is abandoned
  };
  let clock = 0;

  // Pointer cursor on the panel.
  const cursor = new THREE.Mesh(
    new THREE.RingGeometry(0.4, 0.75, 24),
    new THREE.MeshBasicNodeMaterial({ color: 0xd9ff3b, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false }),
  );
  cursor.name = "xr-hud-cursor";
  cursor.renderOrder = 1003;
  cursor.layers.set(VIEWMODEL_LAYER);
  cursor.visible = false;
  group.add(cursor);

  // ── In-run cards ───────────────────────────────────────────────────────
  const cards = createXRHudCards({ domHud });
  group.add(cards.group);

  // ── Damage: red shell around the head (parented to the XR camera) ──────
  const damageMaterial = new THREE.MeshBasicNodeMaterial({
    color: 0xff1030,
    transparent: true,
    opacity: 0,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const damageMesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), damageMaterial);
  damageMesh.name = "xr-hud-damage";
  damageMesh.renderOrder = 1004;
  damageMesh.frustumCulled = false;
  damageMesh.layers.set(VIEWMODEL_LAYER);
  damageMesh.visible = false;
  let damage = 0;

  // ── Laser pointer state ────────────────────────────────────────────────
  const _hits = [];
  let hover = null;
  let pointer = null; // { x, y } in CSS px of the live viewport
  let dragging = null; // range input being dragged with the trigger held
  let lastMove = null;

  // ── DOM change tracking ────────────────────────────────────────────────
  let active = false;
  const observer = new MutationObserver((mutations) => {
    if (!screenState.shown) {
      return;
    }
    for (const mutation of mutations) {
      const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      if (!target || target.closest?.(SCREEN_SKIP)) {
        continue;
      }
      // Our own zoom-to-fit writes (fitRunnerScreen) are not page changes.
      if (target === domHud?.screen && mutation.attributeName === "style") {
        continue;
      }
      // New content or state classes → soon. Inline styles (progress bars)
      // and text ticks (clocks, timers) → at most every MINOR_INTERVAL.
      const major =
        mutation.type === "childList" || (mutation.type === "attributes" && mutation.attributeName !== "style");
      if (major) {
        if (screenState.majorAt < 0) {
          screenState.majorAt = clock + MAJOR_DELAY;
        }
      } else {
        screenState.minorDirty = true;
      }
    }
  });

  function setActive(value) {
    active = Boolean(value);
    observer.disconnect();
    if (active) {
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      screenState.majorAt = 0;
      dragging = null;
      // Styles can change between sessions (settings, Moebius, music CSS).
      snapshotter.prepare({ force: true }).catch((error) => console.warn("[xr] HUD styles:", error));
    } else {
      screenMesh.visible = false;
      cards.group.visible = false;
      cursor.visible = false;
      setHover(null);
    }
  }

  // ── Snapshots ──────────────────────────────────────────────────────────
  async function refreshScreen(token) {
    finishAnimations(SCREEN_SKIP);
    const fit = fitRunnerScreen(domHud?.screen);
    const rect = visibleUiRect(SCREEN_SKIP);
    if (!rect) {
      screenMesh.visible = false;
      screenState.rect = null;
      // Still animating in / not laid out yet: look again shortly.
      screenState.majorAt = clock + 0.4;
      return;
    }
    const size = await snapshotter.snapshot(document.body, screenCanvas, {
      // Zoomed-out tickets get proportionally more pixels.
      scale: Math.min(2.4, SNAPSHOT_SCALE / fit),
      skip: SCREEN_SKIP,
      transparent: true,
    });
    screenState.metresPerPx = SCREEN_METRES_PER_PX / fit;
    if (!active || !screenState.shown || token !== screenState.token) {
      return;
    }
    // GPU storage is allocated at the first upload: a new size needs a new
    // texture (the material only gets built once it has one).
    if (!screenTexture || screenCanvas.width !== textureSize.width || screenCanvas.height !== textureSize.height) {
      screenTexture?.dispose();
      screenTexture = makeTexture(screenCanvas);
      textureSize = { width: screenCanvas.width, height: screenCanvas.height };
      screenMaterial.map = screenTexture;
      screenMaterial.needsUpdate = true;
    } else {
      screenTexture.needsUpdate = true;
    }
    screenState.rect = rect;
    cropQuad(screenMesh, rect, size.width, size.height);
    const metresPerPx = screenState.metresPerPx;
    screenMesh.scale.set((rect.right - rect.left) * metresPerPx, (rect.bottom - rect.top) * metresPerPx, 1);
    // Keep a hint of the page layout, but centre the UI on the eyes.
    const cx = ((rect.left + rect.right) / 2 - size.width / 2) * metresPerPx;
    const cy = (size.height / 2 - (rect.top + rect.bottom) / 2) * metresPerPx;
    screenMesh.position.set(cx * 0.35, SCREEN_EYE_Y + cy * 0.35, -SCREEN_DISTANCE);
    screenMesh.updateMatrixWorld();
    screenMesh.visible = true;
  }

  function pumpScreen() {
    // Watchdog: a snapshot that never settles must not freeze the panel.
    if (screenState.busy && clock - screenState.lastSnapshot > 8) {
      console.warn(`[xr] menu snapshot stuck at "${snapshotter.getStage()}" — retrying`);
      screenState.busy = false;
      screenState.token += 1;
      screenState.majorAt = clock;
    }
    if (!screenState.shown || screenState.busy) {
      return;
    }
    const majorDue = screenState.majorAt >= 0 && clock >= screenState.majorAt;
    const minorDue = screenState.minorDirty && clock - screenState.lastSnapshot >= MINOR_INTERVAL;
    if (!majorDue && !minorDue) {
      return;
    }
    screenState.majorAt = -1;
    screenState.minorDirty = false;
    screenState.lastSnapshot = clock;
    screenState.busy = true;
    const token = ++screenState.token;
    refreshScreen(token)
      .catch((error) => {
        console.warn("[xr] menu snapshot failed:", error);
        if (token === screenState.token) {
          screenState.majorAt = clock + 1; // try again
        }
      })
      .finally(() => {
        if (token === screenState.token) {
          screenState.busy = false;
        }
      });
  }

  /** Menus show the page panel; runs show the native cards. */
  function setMenuMode(value) {
    const shown = Boolean(value);
    if (shown === screenState.shown) {
      return;
    }
    screenState.shown = shown;
    if (shown) {
      screenState.majorAt = clock;
    } else {
      screenMesh.visible = false;
      pointer = null;
      cursor.visible = false;
      setHover(null);
      dragging = null;
    }
  }

  // ── Laser pointer on the page panel ────────────────────────────────────
  function setHover(element) {
    if (hover === element) {
      return;
    }
    hover?.classList.remove("is-xr-hover");
    hover = element;
    hover?.classList.add("is-xr-hover");
  }

  /** Topmost page element under a viewport point (never the scene / HUD). */
  function elementAt(x, y) {
    for (const element of document.elementsFromPoint(x, y)) {
      if (element === document.documentElement || element === document.body) {
        continue;
      }
      if (element.closest(SCREEN_SKIP)) {
        continue;
      }
      return element;
    }
    return null;
  }

  function clickableAt(x, y) {
    return elementAt(x, y)?.closest(CLICKABLE) ?? null;
  }

  /** Synthetic pointer events keep the flat UI's idle / hover logic alive. */
  function dispatchPointer(type, target, x, y) {
    target?.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        pointerId: 71,
        pointerType: "mouse",
        isPrimary: true,
        button: type === "pointermove" ? -1 : 0,
        buttons: type === "pointerdown" || (type === "pointermove" && dragging) ? 1 : 0,
      }),
    );
  }

  /** @returns {boolean} true while the ray is on the page panel */
  function pointAt(raycaster) {
    pointer = null;
    cursor.visible = false;
    const rect = screenState.rect;
    if (!screenMesh.visible || !rect) {
      setHover(null);
      return false;
    }
    _hits.length = 0;
    raycaster.intersectObject(screenMesh, false, _hits);
    const hit = _hits[0];
    if (!hit) {
      setHover(null);
      return false;
    }
    // The quad's UVs are cropped: map the hit through its local position.
    screenMesh.worldToLocal(_local.copy(hit.point));
    const x = rect.left + (_local.x + 0.5) * (rect.right - rect.left);
    const y = rect.top + (0.5 - _local.y) * (rect.bottom - rect.top);
    pointer = { x, y };
    if (!lastMove || Math.abs(lastMove.x - x) + Math.abs(lastMove.y - y) > 2) {
      lastMove = { x, y };
      dispatchPointer("pointermove", elementAt(x, y) ?? document.body, x, y);
    }
    // The cursor lives in the HUD group (which rides the player rig): place
    // it in group space, a hair in front of the panel.
    _local.set(_local.x, _local.y, 0.004);
    screenMesh.localToWorld(_local);
    group.worldToLocal(_local);
    cursor.position.copy(_local);
    cursor.quaternion.copy(screenMesh.quaternion);
    cursor.scale.setScalar(dragging || hover ? 0.03 : 0.022);
    cursor.visible = true;
    if (dragging) {
      setRangeFromPointer(dragging);
    } else {
      setHover(clickableAt(x, y));
    }
    return true;
  }

  function setRangeFromPointer(input) {
    const rect = input.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (pointer.x - rect.left) / Math.max(1, rect.width)));
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const step = Number(input.step) || 0;
    let value = min + t * (max - min);
    if (step > 0) {
      value = Math.round((value - min) / step) * step + min;
    }
    if (String(value) !== input.value) {
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  /**
   * Trigger pressed: click what the laser points at (sliders start a drag,
   * dropdowns cycle their options). Returns true when a control was hit.
   */
  function press() {
    if (!pointer) {
      return false;
    }
    const under = elementAt(pointer.x, pointer.y);
    dispatchPointer("pointerdown", under ?? document.body, pointer.x, pointer.y);
    dispatchPointer("pointerup", under ?? document.body, pointer.x, pointer.y);
    const target = under?.closest(CLICKABLE) ?? null;
    if (!target) {
      // Plain click on a backdrop (closes overlays like Settings).
      under?.click();
      return false;
    }
    if (target instanceof HTMLInputElement && target.type === "range") {
      dragging = target;
      setRangeFromPointer(target);
      return true;
    }
    if (target instanceof HTMLSelectElement) {
      // Native dropdowns cannot open in a headset: step through the options.
      target.selectedIndex = (target.selectedIndex + 1) % Math.max(1, target.options.length);
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    target.click();
    return true;
  }

  /** Trigger released: finish a slider drag. */
  function release() {
    if (dragging) {
      dragging.dispatchEvent(new Event("change", { bubbles: true }));
      dragging = null;
    }
  }

  /** Scroll the scrollable container under the laser (thumbstick in menus). */
  function scroll(amount) {
    if (!pointer) {
      return;
    }
    let element = elementAt(pointer.x, pointer.y);
    while (element && element !== document.body) {
      const style = getComputedStyle(element);
      if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1) {
        element.scrollBy({ top: amount });
        screenState.majorAt = clock + MAJOR_DELAY;
        return;
      }
      element = element.parentElement;
    }
  }

  // ── Mirrored runner HUD API (mirrorHud) ────────────────────────────────
  function flashDamage(amount = 0.5) {
    damage = Math.max(damage, amount);
    onDamage?.(amount);
  }

  function hitMarker(kill = false) {
    onHit?.(kill);
  }

  function update(delta) {
    if (!active) {
      return;
    }
    clock += delta;
    pumpScreen();
    cards.update(delta, !screenState.shown);
    if (damage > 0) {
      damage = Math.max(0, damage - delta * 2.2);
      damageMaterial.opacity = damage * 0.45;
    }
    damageMesh.visible = damage > 0.01;
  }

  function reset() {
    damage = 0;
    damageMesh.visible = false;
  }

  function dispose() {
    setActive(false);
    screenTexture?.dispose();
    cards.dispose();
    for (const mesh of [screenMesh, cursor, damageMesh]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }

  return {
    group,
    damageMesh,
    screenMesh,
    setActive,
    setMenuMode,
    pointAt,
    press,
    release,
    /** Click without drag semantics (A button). */
    click: () => {
      const hit = press();
      release();
      return hit;
    },
    scroll,
    isPointing: () => pointer !== null,
    /** Dev: menu panel state (window.__app.xr.hud.debugState()). */
    debugState: () => ({
      shown: screenState.shown,
      busy: screenState.busy,
      majorAt: screenState.majorAt,
      clock,
      rect: screenState.rect,
      visible: screenMesh.visible,
      liveRect: visibleUiRect(SCREEN_SKIP),
      fit: domHud?.screen?.style.getPropertyValue("--xr-fit"),
      stage: snapshotter.getStage(),
      mode: domHud?.screen?.dataset.mode,
      animations: document.getAnimations().filter((a) => a.playState === "running").map((a) => `${a.animationName ?? a.transitionProperty ?? "anim"}@${a.effect?.target?.className ?? ""}:${a.effect?.getTiming?.().iterations}`).slice(0, 12),
    }),
    hasScreen: () => screenMesh.visible,
    flashDamage,
    hitMarker,
    update,
    reset,
    dispose,
  };
}
