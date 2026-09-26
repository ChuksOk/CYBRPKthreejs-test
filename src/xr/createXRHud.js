import * as THREE from "three/webgpu";
import { VIEWMODEL_LAYER } from "../runner/runnerConfig.js";
import { createDomSnapshotter } from "./domSnapshot.js";

/**
 * In-run HUD cards cropped out of the flat HUD snapshot. Each becomes its own
 * quad, laid out exactly where it sits on the flat screen (projected onto a
 * gentle curve in front of the player). Crosshair, target brackets, threat
 * arrows and score pop-ups are screen-projected in the flat game, so VR
 * leaves them out (the laser + haptics cover them).
 */
const HUD_CARDS = [
  ".rh-ticket",
  ".rh-vitals",
  ".rh-ammo",
  ".rh-weapons",
  ".rh-flight",
  ".rh-orders",
  ".rh-boss",
  ".rh-banner",
  ".rh-prompt",
  ".rh-toasts",
  ".rh-mission",
  ".rh-music",
  ".rh-slowmo",
];

/** Flat HUD → VR: the viewport maps onto an arc this wide / far (player space). */
const HUD_ARC_WIDTH = 2.3;
const HUD_DISTANCE = 1.75;
const HUD_EYE_DROP = 0.08;
/**
 * Menus: the *whole* flat page (header, runner ticket screens, settings,
 * about, soundtrack player …) minus the 3D canvas, on a virtual screen this
 * wide, floating ahead of the player.
 */
const SCREEN_WIDTH = 2.9;
const SCREEN_POSITION = new THREE.Vector3(0, 1.55, -2.35);
/** Left out of the page snapshot (the scene itself, dev tooling). */
const SCREEN_SKIP = "canvas, video, iframe, .xr-enter-button, #inspector, .inspector, [data-xr-skip]";

const HUD_SNAPSHOT_INTERVAL = 0.25; // s — the ticket's numbers tick at 4 Hz
const SCREEN_SNAPSHOT_INTERVAL = 0.15;
const SNAPSHOT_SCALE = 1.5;

const CLICKABLE =
  "button, a[href], input, label, select, summary, [data-action], [data-special], [role='button'], [role='tab'], [role='switch'], [onclick], [tabindex]:not([tabindex='-1'])";

function makeTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function createCanvasTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  return { canvas, texture: makeTexture(canvas), width: 2, height: 2 };
}

/**
 * GPU texture storage is allocated once at its first upload, so a canvas that
 * changes size needs a brand-new texture. Returns true when it was rebuilt.
 */
function syncSurface(surface) {
  const { canvas } = surface;
  if (canvas.width === surface.width && canvas.height === surface.height) {
    surface.texture.needsUpdate = true;
    return false;
  }
  surface.texture.dispose();
  surface.texture = makeTexture(canvas);
  surface.width = canvas.width;
  surface.height = canvas.height;
  return true;
}

function setMap(mesh, texture) {
  mesh.material.map = texture;
  mesh.material.needsUpdate = true;
}

function createQuad(texture, name, renderOrder = 1000) {
  const material = new THREE.MeshBasicNodeMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.name = name;
  mesh.renderOrder = renderOrder;
  mesh.frustumCulled = false;
  mesh.layers.set(VIEWMODEL_LAYER);
  mesh.visible = false;
  return mesh;
}

function isShown(element) {
  if (!element?.isConnected) {
    return false;
  }
  if (element.checkVisibility && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

/**
 * Crop a shared snapshot texture (flipY) to a CSS-px rect of the viewport via
 * the quad's UVs, so every card samples one texture uploaded once.
 */
function cropQuad(mesh, rect, viewportWidth, viewportHeight) {
  const u0 = rect.left / viewportWidth;
  const u1 = rect.right / viewportWidth;
  const v0 = 1 - rect.bottom / viewportHeight;
  const v1 = 1 - rect.top / viewportHeight;
  const uv = mesh.geometry.attributes.uv;
  // PlaneGeometry(1, 1) vertex order: top-left, top-right, bottom-left, bottom-right.
  uv.setXY(0, u0, v1);
  uv.setXY(1, u1, v1);
  uv.setXY(2, u0, v0);
  uv.setXY(3, u1, v0);
  uv.needsUpdate = true;
}

/**
 * VR HUD made of *pictures of the flat UI* (see domSnapshot.js), so the
 * headset matches the flat game exactly and keeps all of its functionality:
 *
 * - Menus (start ticket, pause, game over, upgrades, armory, missions,
 *   records, soundtrack, countdown — plus the header, Settings, About and the
 *   music player): the whole page minus the 3D canvas is snapshotted when it
 *   changes and shown on a virtual screen. The laser drives the real page:
 *   clicks, slider drags, dropdowns (cycled) and scrolling.
 * - Runs: the flat HUD is snapshotted at 4 Hz and cut into per-card quads,
 *   laid out where they sit on the flat screen.
 *
 * DOM HUD calls still arrive through mirrorHud (createRunnerGame.js); only
 * flashDamage / hitMarker need VR-side work (red shell + haptics).
 */
export function createXRHud({ domHud, onHit = null, onDamage = null } = {}) {
  const group = new THREE.Group();
  group.name = "xr-hud";
  const snapshotter = createDomSnapshotter();

  // ── Menu screen panel ──────────────────────────────────────────────────
  const screenSurface = createCanvasTexture();
  const screenMesh = createQuad(screenSurface.texture, "xr-hud-screen", 1002);
  screenMesh.position.copy(SCREEN_POSITION);
  group.add(screenMesh);
  const screenState = {
    dirty: true,
    busy: false,
    wait: 0,
    shown: false, // menus: the page panel is wanted
    rect: null, // viewport rect (CSS px) the panel shows
  };

  // Pointer cursor on the panel.
  const cursor = new THREE.Mesh(
    new THREE.RingGeometry(0.008, 0.014, 24),
    new THREE.MeshBasicNodeMaterial({ color: 0xd9ff3b, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false }),
  );
  cursor.name = "xr-hud-cursor";
  cursor.renderOrder = 1003;
  cursor.layers.set(VIEWMODEL_LAYER);
  cursor.visible = false;
  cursor.position.z = 0.002;
  screenMesh.add(cursor);

  // ── Running HUD cards ──────────────────────────────────────────────────
  const hudSurface = createCanvasTexture();
  const cards = HUD_CARDS.map((selector) => {
    const mesh = createQuad(hudSurface.texture, `xr-hud${selector.replace(".", "-")}`);
    group.add(mesh);
    return { selector, mesh };
  });
  const hudState = { dirty: true, busy: false, wait: 0 };

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

  // ── DOM change tracking ────────────────────────────────────────────────
  let active = false;
  const observerOptions = { subtree: true, childList: true, attributes: true, characterData: true };
  const screenObserver = new MutationObserver(() => {
    screenState.dirty = true;
  });
  const hudObserver = new MutationObserver(() => {
    hudState.dirty = true;
  });

  function setActive(value) {
    active = Boolean(value);
    screenObserver.disconnect();
    hudObserver.disconnect();
    if (active) {
      screenObserver.observe(document.body, observerOptions);
      if (domHud?.root) {
        hudObserver.observe(domHud.root, observerOptions);
      }
      dragging = null;
      screenState.dirty = true;
      hudState.dirty = true;
      // Styles can change between sessions (settings, Moebius, music CSS).
      snapshotter.prepare({ force: true }).catch((error) => console.warn("[xr] HUD styles:", error));
    } else {
      screenMesh.visible = false;
      for (const card of cards) {
        card.mesh.visible = false;
      }
      setHover(null);
    }
  }

  // ── Snapshots ──────────────────────────────────────────────────────────
  async function refreshScreen() {
    if (!screenState.shown) {
      screenMesh.visible = false;
      return;
    }
    const size = await snapshotter.snapshot(document.body, screenSurface.canvas, {
      scale: SNAPSHOT_SCALE,
      skip: SCREEN_SKIP,
    });
    if (!active || !screenState.shown) {
      return;
    }
    screenState.rect = { left: 0, top: 0, right: size.width, bottom: size.height };
    if (syncSurface(screenSurface)) {
      setMap(screenMesh, screenSurface.texture);
    }
    screenMesh.scale.set(SCREEN_WIDTH, (SCREEN_WIDTH * size.height) / size.width, 1);
    screenMesh.visible = true;
  }

  /** Menus show the full page panel; runs show the HUD cards. */
  function setMenuMode(value) {
    const shown = Boolean(value);
    if (shown === screenState.shown) {
      return;
    }
    screenState.shown = shown;
    screenState.dirty = true;
    screenState.wait = 0;
    hudState.dirty = true;
    if (!shown) {
      screenMesh.visible = false;
      pointer = null;
      cursor.visible = false;
      setHover(null);
      dragging = null;
    }
  }

  const _placement = new THREE.Vector3();
  function placeCard(mesh, rect, viewportWidth, viewportHeight) {
    const metresPerPx = HUD_ARC_WIDTH / viewportWidth;
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    const x = (cx / viewportWidth - 0.5) * HUD_ARC_WIDTH;
    const y = (0.5 - cy / viewportHeight) * viewportHeight * metresPerPx;
    // Wrap x onto a circle around the head so every card faces the eyes.
    const angle = x / HUD_DISTANCE;
    _placement.set(Math.sin(angle) * HUD_DISTANCE, 0, -Math.cos(angle) * HUD_DISTANCE);
    mesh.position.set(_placement.x, 1.55 - HUD_EYE_DROP + y, _placement.z);
    mesh.rotation.set(0, -angle, 0);
    mesh.scale.set((rect.right - rect.left) * metresPerPx, (rect.bottom - rect.top) * metresPerPx, 1);
  }

  async function refreshHud() {
    const root = domHud?.root;
    if (!root || screenState.shown) {
      for (const card of cards) {
        card.mesh.visible = false;
      }
      return;
    }
    // Rects are read before the snapshot so crops and layout agree.
    const rects = cards.map((card) => {
      const element = root.querySelector(card.selector);
      if (!isShown(element)) {
        return null;
      }
      const r = element.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
    if (!rects.some(Boolean)) {
      for (const card of cards) {
        card.mesh.visible = false;
      }
      return;
    }
    const size = await snapshotter.snapshot(root, hudSurface.canvas, { scale: 1.25 });
    if (!active || screenState.shown) {
      return;
    }
    if (syncSurface(hudSurface)) {
      for (const card of cards) {
        setMap(card.mesh, hudSurface.texture);
      }
    }
    cards.forEach((card, index) => {
      const rect = rects[index];
      card.mesh.visible = Boolean(rect);
      if (!rect) {
        return;
      }
      cropQuad(card.mesh, rect, size.width, size.height);
      placeCard(card.mesh, rect, size.width, size.height);
    });
  }

  function pump(state, interval, refresh, delta) {
    state.wait -= delta;
    if (!state.dirty || state.busy || state.wait > 0) {
      return;
    }
    state.dirty = false;
    state.busy = true;
    state.wait = interval;
    refresh()
      .catch((error) => console.warn("[xr] HUD snapshot failed:", error))
      .finally(() => {
        state.busy = false;
      });
  }

  // ── Laser pointer on the page panel ────────────────────────────────────
  const _hits = [];
  let hover = null;
  let pointer = null; // { x, y } in CSS px of the live viewport
  let dragging = null; // range input being dragged with the trigger held

  function setHover(element) {
    if (hover === element) {
      return;
    }
    hover?.classList.remove("is-xr-hover");
    hover = element;
    hover?.classList.add("is-xr-hover");
  }

  /** Topmost page element under a viewport point (never the 3D canvas). */
  function elementAt(x, y) {
    for (const element of document.elementsFromPoint(x, y)) {
      if (element === document.documentElement || element === document.body) {
        continue;
      }
      if (element.matches(SCREEN_SKIP) || element.closest(SCREEN_SKIP)) {
        continue;
      }
      return element;
    }
    return null;
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
        buttons: type === "pointerdown" || type === "pointermove" && dragging ? 1 : 0,
      }),
    );
  }

  let lastMove = null;

  function clickableAt(x, y) {
    return elementAt(x, y)?.closest(CLICKABLE) ?? null;
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
    if (!hit?.uv) {
      setHover(null);
      return false;
    }
    const x = rect.left + hit.uv.x * (rect.right - rect.left);
    const y = rect.top + (1 - hit.uv.y) * (rect.bottom - rect.top);
    pointer = { x, y };
    if (!lastMove || Math.abs(lastMove.x - x) + Math.abs(lastMove.y - y) > 2) {
      lastMove = { x, y };
      dispatchPointer("pointermove", elementAt(x, y) ?? document.body, x, y);
    }
    cursor.position.set(hit.uv.x - 0.5, hit.uv.y - 0.5, 0.002);
    cursor.scale.set(1 / screenMesh.scale.x, 1 / screenMesh.scale.y, 1);
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
   * dropdowns cycle their options). Returns true when something was hit.
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
      // Plain click on the backdrop (closes overlays like Settings).
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
        screenState.dirty = true;
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
    pump(screenState, SCREEN_SNAPSHOT_INTERVAL, refreshScreen, delta);
    pump(hudState, HUD_SNAPSHOT_INTERVAL, refreshHud, delta);
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
    screenSurface.texture.dispose();
    hudSurface.texture.dispose();
    for (const mesh of [screenMesh, cursor, damageMesh, ...cards.map((card) => card.mesh)]) {
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
    hasScreen: () => screenMesh.visible,
    flashDamage,
    hitMarker,
    update,
    reset,
    dispose,
  };
}
