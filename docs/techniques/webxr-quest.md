# WebXR on Meta Quest

**Goal:** play the endless runner in a Meta Quest headset (Quest 2 / 3 / 3S / Pro, Quest Browser) without forking the game: same simulation, same tiles, same rain. Only the camera, input, HUD and render path change while a VR session is presenting.

Primary code:

| Piece | File |
|-------|------|
| Boot decision, headset budgets, offscreen-render guard | `src/xr/xrSupport.js` |
| Rig, controllers, input, recenter, haptics, session, ENTER VR button | `src/xr/createXRMode.js` |
| In-headset HUD (canvas panels, damage shell) | `src/xr/createXRHud.js` |
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

XR mode also applies `applyXRPerformanceDefaults()` (1 city tile ahead, 2 500 rain drops, 256² height map with frame skip, no weapon lights, no sun-shadow refresh, no billboards or AO). The TSL is unchanged: the WebGL2 backend runs the same node materials and the rain compute.

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
| Right trigger | Fire (aim = right controller ray, light aim assist) | Confirm / pick card |
| Left trigger | Throw special from the left controller | — |
| Either stick flick ← → | Change lane | Move upgrade highlight |
| Stick flick ↑ / A | Jump | A = confirm |
| Stick flick ↓ / B / physical duck | Slide | B = back / menu |
| Right grip | Reload | — |
| Left grip / X | Next / previous weapon | X = toggle Daily Run |
| Y | Pause | Resume |
| Stick click | Recenter | Recenter |

Upgrade cards can also be picked by pointing the laser at them. The Armory, Missions and Records screens stay 2D-only. In VR they show "available outside VR".

## 5. HUD

DOM overlays are invisible in a headset. `createRunnerGame` wraps the DOM HUD in a `Proxy` (`mirrorHud`), so every `showScreen`, `showBanner`, `toast`, `setPrompt`, `flashDamage`, `hitMarker`, … call is also forwarded to `createXRHud` while a session is active. No call site changed.

- **Main panel** (1.8 × 1.1 m, 2.5 m ahead): menus, countdown, banners, toasts, tutorial prompts.
- **Stats strip** (1.2 m wide, low and tilted toward the eyes): HP, shield, score, combo or boss HP, ammo, weapon, special charge.
- **Damage:** a red back-face sphere around the head (both eyes, no FOV math).
- Panels live on `VIEWMODEL_LAYER`, so the AO, mirror and height passes never see them. The whole rig is also in `world.collisionHideExtra` (the controller models load onto layer 0).

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
| `STATS_POSITION`, `MAIN_POSITION` | `createXRHud.js` | Panel placement in player space |
| `DUCK_ENTER` / `DUCK_EXIT` | `createXRMode.js` | Physical duck thresholds (m) |
| `STICK_ENGAGE` / `STICK_RELEASE` | `createXRMode.js` | Flick hysteresis |
| `applyXRPerformanceDefaults` | `xrSupport.js` | Headset budgets |
