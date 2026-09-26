# WebXR on Meta Quest

**Goal:** play the endless runner in a Meta Quest headset (Quest 2 / 3 / 3S / Pro, Quest Browser) without forking the game: same simulation, same tiles, same rain. Only the camera, input, HUD and render path change while a VR session is presenting.

Primary code:

| Piece | File |
|-------|------|
| Boot decision, headset budgets, offscreen-render guard | `src/xr/xrSupport.js` |
| Rig, controllers, input, recenter, haptics, session, ENTER VR button | `src/xr/createXRMode.js` |
| In-headset HUD: menu snapshots + laser input, native in-run cards | `src/xr/createXRHud.js`, `src/xr/domSnapshot.js`, `src/xr/createXRHudCards.js` |
| Renderer backend + XR flags | `src/bootstrap/createRenderer.js` |
| Frame order in VR | `src/runtime/createRenderLoop.js` |
| Camera pose override, `pushAction` | `src/controls/createRunnerControls.js` |
| HUD mirroring, `xrAction`, left-hand special | `src/runner/createRunnerGame.js` |
| Gun on the controller | `src/weapon/createViewmodel.js` (`setXRMode`) |

---

## 1. Boot: which backend

WebGPU XR sessions need the experimental `XRGPUBinding`, which the Quest browser does not ship. `WebGPURenderer` cannot change backend after `init()`, so `main.js` decides before the renderer exists (`wantsXRMode`):

| Condition | Renderer |
|-----------|----------|
| Quest Browser UA, or `?xr` | `WebGPURenderer({ forceWebGL: true })`, `xr.enabled`, `local-floor`, foveation 1 |
| `?xrwebgpu` and `XRGPUBinding` exists | WebGPU backend, session requests the `webgpu` feature |
| `?noxr` | Never XR |
| Anything else | Normal WebGPU boot; if `immersive-vr` is supported the button says **VR MODE** and reloads with `?xr` |

XR mode renders 90% eye buffers with plain PCF shadows, and also applies `applyXRPerformanceDefaults()` (1 city tile ahead, 2 500 rain drops, 256² height map with frame skip, no weapon lights, no sun-shadow refresh, no billboards or AO). The TSL is unchanged: the WebGL2 backend runs the same node materials and the rain compute.

## 2. Two cameras

The game camera stays authoritative for gameplay. Hitscan, aim assist, specials, and rain / height-map centering all read it. In VR it is posed on the **right controller's target ray** every frame (`applyPose`). Without controllers (hand tracking) it falls back to the head pose.

The headset renders through a separate `xrCamera` inside a rig:

```
rig        position = (player.x, feetY + slideDip, player.z), yaw = run heading (−π/2)
 ├─ space  recenter: rotation −headYaw, position −headXZ, y = eyeHeight − calibrated head height
 │   ├─ xrCamera          (headset pose from WebXR)
 │   └─ controllers/grips (poses from WebXR)
 └─ HUD panels            (body-locked, always down the street)
```

- **No forced camera motion.** Head bob, shake, roll and FOV kick exist only on the flat-screen path. Recoil and impacts become haptics instead.
- **Recenter** (thumbstick click, and automatically on session start) makes the current head pose "standing in the lane, facing +X". It also maps the head height to `RUNNER.eyeHeight`, so seated and standing players get the same view.
- **Duck to slide:** dropping 0.3 m below the calibrated height triggers a slide, and the slide lasts for as long as the player stays down. A button slide lowers the view only by what the player isn't already ducking.
- **Sky Run:** while flying, the rig rides the game's chase point (`chaseDistance` behind, `chaseHeight` above the car, on its smoothed `camY` / `camZ` follow path) instead of sitting inside the hull. The chase roll and the crash cinematic are flat-screen only. The rifle hides as it does on the flat screen, and shots still aim down the right controller ray.
- **Floating-origin wrap:** `controls.shiftX` re-runs the pose override, so the rig jumps with the world in the same frame.

## 3. Render path while presenting

```
xr.beforeUpdate   poll gamepads → controls.pushAction / runnerGame.xrAction
runnerGame.update controls pose the rig + game camera (applyPose)
height pass, rain, sky, ground ripples       (unchanged)
xr.afterUpdate    HUD redraw (dirty / 10 Hz), laser
renderer.render(scene, xrCamera)             (no ground mirror, no post stack)
```

- **Post is bypassed.** `RenderPipeline.render()` draws its output quad with `xr.enabled = false`, so it cannot drive stereo views. Tone mapping and the sRGB output still apply through the renderer's own output pass.
- **Offscreen passes keep their camera.** While presenting, `Renderer._updateCamera` swaps in the XR camera for **every** render call, including render targets. The rain height pass and the ground mirror call `withXRDisabled(renderer, …)`. The shadow map is rendered inside the main render, so `createShadowUpdater` defers shadow requests during a session and flushes them on exit.
- **The ground mirror is off in VR.** It would be rendered from one mono camera, and costs a second scene draw. Ripples and roughness still read as wet.

## 4. Controls (Touch controllers)

| Input | Running | Menus |
|-------|---------|-------|
| Right trigger | Fire (aim = right controller ray, light aim assist) | Click what the laser points at (hold to drag sliders) |
| Left trigger | Throw special from the left controller | — |
| Either stick flick ← → | Change lane (Sky Run: strafe) | — |
| Stick flick ↑ / A | Jump (Sky Run: climb) | A = click |
| Stick flick ↓ / B / physical duck | Slide (Sky Run: dive) | B = back / menu |
| Stick ↑↓ (held) | — | Scroll the list under the laser |
| Right grip | Reload | — |
| Left grip / X | Next / previous weapon | X = toggle Daily Run |
| Y | Pause | Resume |
| Stick click | Recenter | Recenter |

Aiming the trigger off the page panel starts / resumes / restarts, so the loop never needs precise pointing.

## 5. HUD: the flat UI, adapted for the headset

DOM overlays are invisible in an immersive session. The headset keeps the flat game's design and every feature, adapted for comfort and a standalone GPU budget.

**Menus** (every state except running / dying): pictures of the real page (`domSnapshot.js`).

- Scope: start ticket, pause, game over, upgrades, Armory, Missions, Records, soundtrack, Style, countdown, plus the header, Settings and About.
- Rasterizer: clones the DOM into an SVG `<foreignObject>` with the page's own CSS.
  - `html` / `body` / `:root` selectors are retargeted.
  - Fonts and images are inlined, woff2 only.
  - Each snapshot keeps only the rules whose classes exist in it, plus the fonts it uses.
  - Chromium renders foreignObject with full CSS.
  - It must be a **data:** URL: a blob URL taints the canvas, and WebGL then refuses it.
- While presenting, `html.xr-presenting` rules (`xrButton.css`) drop the full-screen backdrops, top-align tall tickets and hide the flat now-playing toast. The snapshot is transparent and cropped to the visible UI, so the tickets float in the street about 2.2 m ahead.
- A `MutationObserver` re-snapshots quickly on structural changes (new nodes, class / data changes). Inline-style and text ticks (progress bars, clocks) refresh at most every 1.5 s.
- The laser drives the real page:
  - `elementsFromPoint` hit-tests, and synthetic `pointermove` / `pointerdown` / `pointerup` + `click` keep the idle and hover logic working.
  - Range inputs drag while the trigger is held. `<select>` cycles its options.
  - The stick scrolls the list under the laser.
  - The hovered control gets an acid outline.
- Clicks run inside the XR session's `selectstart`. That is real user activation, so gesture-gated features (music playback, share) work.

**Runs:** `createXRHudCards.js` repaints the flat HUD cards natively on small canvases. Rasterizing DOM several times a second causes judder on a Quest.

- Cards: score ticket, orders, vitals, ammo + special, weapon chips, Sky Run hull, carrier bar, banner, prompt, toasts / mission stamp, now playing.
- Values are read from the live flat HUD (text, state classes, bar `scaleX`), so the strings always match the flat game.
- The look follows `runnerHud.css`: palette, notches, dot grids, barcodes, Barlow Condensed + JetBrains Mono.
- A card repaints only when its values change (≤ 10 Hz).
- The cards are body-locked on an arc within ±30° (score / orders / vitals left, chips / ammo right, banner / boss / toasts / prompt / hull centred).

The crosshair, target brackets, threat arrows and score pop-ups are screen-projected in the flat game, so VR leaves them out. The laser and haptics cover them. While in VR the runner HUD lists the Touch controller scheme (`hud.setXRMode`), and tutorial / Sky Run prompts use VR wording.

- **Audio:** every controller select / squeeze resumes the soundtrack (`music.resumeFromGesture()`) and the SFX context. The flat page reporting `hidden` no longer pauses a VR run; the XR session's own `visibilitychange` does.
- **Damage:** a red back-face sphere around the head, plus haptics. `mirrorHud` forwards only `flashDamage` / `hitMarker`.
- Quads live on `VIEWMODEL_LAYER`, so the AO, mirror and height passes never see them. The whole rig is also in `world.collisionHideExtra`.

## 6. Testing without a headset

[IWER](https://github.com/meta-quest/immersive-web-emulation-runtime) (Meta's WebXR emulator) runs the full session in desktop Chromium:

```js
// before the app scripts load (e.g. Playwright addInitScript)
const device = new IWER.XRDevice(IWER.metaQuest3);
device.installRuntime({ forceInstall: true });
// then: open /?xr, click ENTER VR, and drive device.controllers.right.updateButtonValue("trigger", 1) …
```

IWER returns `null` for `XRWebGLLayer.framebuffer` (it draws to the default framebuffer). Real headsets return an opaque framebuffer, as the spec requires. three's WebGL backend uses the framebuffer as a `WeakMap` key, so under IWER every XR render throws. In the emulator, override the getter with a real offscreen framebuffer (RGBA8 + DEPTH24 renderbuffers at `drawingBufferWidth × drawingBufferHeight`). You can then `readPixels` it to inspect the headset frame.

On a real Quest, open the dev server over HTTPS on the LAN (`npm run dev` prints the address; `@vitejs/plugin-basic-ssl` is already configured), accept the certificate, then press **ENTER VR** on the start ticket.

## Tuning knobs

| Constant | File | Meaning |
|----------|------|---------|
| `XR_OFFSET` | `createViewmodel.js` | Gun grip relative to the controller ray origin |
| `SCREEN_METRES_PER_PX`, `SCREEN_DISTANCE` | `createXRHud.js` | Menu ticket size / distance |
| `MAJOR_DELAY`, `MINOR_INTERVAL` | `createXRHud.js` | Menu snapshot rates (main-thread cost) |
| `CARDS[].place`, `ARC_RADIUS`, `METRES_PER_PX` | `createXRHudCards.js` | In-run card layout |
| `DUCK_ENTER` / `DUCK_EXIT` | `createXRMode.js` | Physical duck thresholds (m) |
| `STICK_ENGAGE` / `STICK_RELEASE` | `createXRMode.js` | Flick hysteresis |
| `applyXRPerformanceDefaults` | `xrSupport.js` | Headset budgets |
