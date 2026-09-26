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
/** Menu tickets: one CSS px in metres, and where the panel floats. */
const SCREEN_METRES_PER_PX = 0.0021;
const SCREEN_POSITION = new THREE.Vector3(0, 1.5, -2.3);
const SCREEN_MARGIN = 18;

const HUD_SNAPSHOT_INTERVAL = 0.25; // s — the ticket's numbers tick at 4 Hz
const SCREEN_SNAPSHOT_DEBOUNCE = 0.06;
const SNAPSHOT_SCALE = 1.5;

const CLICKABLE = "button, a, input, label, select, [data-action], [data-special], [role='button']";

function createCanvasTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return { canvas, texture };
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

/** Union of the visible children's rects (the ticket, not the dim backdrop). */
function contentRect(screen) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const child of screen.children) {
    if (!isShown(child)) {
      continue;
    }
    const rect = child.getBoundingClientRect();
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  if (!Number.isFinite(left)) {
    return null;
  }
  return {
    left: Math.max(0, left - SCREEN_MARGIN),
    top: Math.max(0, top - SCREEN_MARGIN),
    right: Math.min(window.innerWidth, right + SCREEN_MARGIN),
    bottom: Math.min(window.innerHeight, bottom + SCREEN_MARGIN),
  };
}

/** Crop a snapshot (flipY texture) to a CSS-px rect of the viewport. */
function cropTexture(texture, rect, viewportWidth, viewportHeight) {
  texture.repeat.set((rect.right - rect.left) / viewportWidth, (rect.bottom - rect.top) / viewportHeight);
  texture.offset.set(rect.left / viewportWidth, 1 - rect.bottom / viewportHeight);
}

/**
 * VR HUD made of *pictures of the flat UI* (see domSnapshot.js), so the
 * headset matches the ticket / label design exactly:
 *
 * - Menu screens (start ticket, pause, game over, upgrades, armory, missions,
 *   records, soundtrack, countdown) are snapshotted whenever the DOM changes
 *   and shown on one floating panel. The laser clicks the real DOM elements
 *   under the pointer, so every flat-screen menu works in the headset.
 * - The running HUD is snapshotted at 4 Hz and cut into per-card quads.
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
    rect: null, // CSS px crop of the viewport shown on the panel
    viewport: { width: 1, height: 1 },
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
    const texture = hudSurface.texture.clone();
    const mesh = createQuad(texture, `xr-hud${selector.replace(".", "-")}`);
    group.add(mesh);
    return { selector, texture, mesh };
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
      if (domHud?.screen) {
        screenObserver.observe(domHud.screen, observerOptions);
      }
      if (domHud?.root) {
        hudObserver.observe(domHud.root, observerOptions);
      }
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
    const screen = domHud?.screen;
    const mode = screen?.dataset.mode;
    const rect = mode ? contentRect(screen) : null;
    if (!screen || !mode || !rect) {
      screenMesh.visible = false;
      screenState.rect = null;
      return;
    }
    const size = await snapshotter.snapshot(screen, screenSurface.canvas, { scale: SNAPSHOT_SCALE });
    if (!active) {
      return;
    }
    screenState.rect = rect;
    screenState.viewport = size;
    cropTexture(screenSurface.texture, rect, size.width, size.height);
    screenSurface.texture.needsUpdate = true;
    screenMesh.scale.set((rect.right - rect.left) * SCREEN_METRES_PER_PX, (rect.bottom - rect.top) * SCREEN_METRES_PER_PX, 1);
    screenMesh.visible = true;
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
    if (!root) {
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
    if (!active) {
      return;
    }
    hudSurface.texture.needsUpdate = true;
    cards.forEach((card, index) => {
      const rect = rects[index];
      card.mesh.visible = Boolean(rect);
      if (!rect) {
        return;
      }
      cropTexture(card.texture, rect, size.width, size.height);
      card.texture.needsUpdate = true;
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

  // ── Laser pointer on the menu panel ────────────────────────────────────
  const _hits = [];
  let hover = null;
  let pointer = null; // { x, y } in CSS px of the live viewport

  function setHover(element) {
    if (hover === element) {
      return;
    }
    hover?.classList.remove("is-xr-hover");
    hover = element;
    hover?.classList.add("is-xr-hover");
  }

  /** DOM element under a viewport point, restricted to the menu screen. */
  function elementAt(x, y) {
    const screen = domHud?.screen;
    if (!screen) {
      return null;
    }
    for (const element of document.elementsFromPoint(x, y)) {
      if (screen.contains(element)) {
        return element;
      }
    }
    return null;
  }

  /** @returns {boolean} true while the ray is on the menu panel */
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
    // hit.uv spans the plane; map it back through the crop.
    const x = rect.left + hit.uv.x * (rect.right - rect.left);
    const y = rect.top + (1 - hit.uv.y) * (rect.bottom - rect.top);
    pointer = { x, y };
    cursor.position.set(hit.uv.x - 0.5, hit.uv.y - 0.5, 0.002);
    cursor.scale.set(1 / screenMesh.scale.x, 1 / screenMesh.scale.y, 1);
    cursor.visible = true;
    setHover(elementAt(x, y)?.closest(CLICKABLE) ?? null);
    return true;
  }

  /** Click whatever the laser points at. Returns true when something was clicked. */
  function click() {
    if (!pointer) {
      return false;
    }
    const element = elementAt(pointer.x, pointer.y);
    const target = element?.closest(CLICKABLE) ?? null;
    if (!target) {
      return false;
    }
    if (target instanceof HTMLInputElement && (target.type === "range" || target.type === "text")) {
      target.focus();
      return true;
    }
    target.click();
    return true;
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
    pump(screenState, SCREEN_SNAPSHOT_DEBOUNCE, refreshScreen, delta);
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
    pointAt,
    click,
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
