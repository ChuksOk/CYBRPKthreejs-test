# Endless runner + shooter on a static city

**Goal:** turn one hand-built alley into an infinite first-person run with drones to shoot, without re-authoring the city in Blender and without breaking the rain collision, wet ground, or post stack.

Primary code:

| Piece | File |
|-------|------|
| Triangle slab clipping | `src/runner/sliceGeometry.js` → `sliceGeometryX` |
| Tiles + seam gates + wrap | `src/runner/createTrack.js` → `createTrack` |
| Tuning (lanes, speeds, slab) | `src/runner/runnerConfig.js` → `RUNNER` |
| Game loop / spawner / score | `src/runner/createRunnerGame.js` → `createRunnerGame` |
| Lanes, jump, slide, aim | `src/controls/createRunnerControls.js` |
| Rifle viewmodel | `src/weapon/createViewmodel.js` |
| Hitscan + reload + overclock | `src/weapon/createWeapon.js` |
| Tracers, sparks, explosions, muzzle flash | `src/weapon/createWeaponFx.js` |
| Drones | `src/enemies/createDroneManager.js`, `droneTypes.js` |
| Enemy bolts | `src/enemies/createEnemyProjectiles.js` |
| Obstacles / pickups | `src/runner/createObstacles.js`, `createPickups.js` |
| HUD + screens (ticket / label style) | `src/ui/runner/createRunnerHud.js`, `runnerHud.css`, chrome theme `src/ui/core/ticketTheme.css` |
| Procedural PBR models | `src/runner/models/` (`modelKit.js`, `materials.js`, rifle, drones, barrier) |
| SFX | `src/audio/createRunnerAudio.js` |

Toggle with `FEATURES.runner` in `src/world/features.js` (false restores the walk / orbit demo).

---

## 1. Why the city is clipped on the CPU

`cyberpunk_compressed.glb` is 78 meshes, but most of them are **merged across the whole block** (one mesh spans x −186…105). Picking meshes by bounding box cannot produce a tile.

GPU clipping (`THREE.ClippingGroup`) was tried first. With several groups that share materials, every clone ended up using the same clip planes (the node builder state is shared), so only one tile showed.

The approach that works:

1. Pick a straight slab of street: `x ∈ [segmentStartX, segmentStartX + segmentLength]` = **[−140, 72]**. Both ends fall on gaps between buildings.
2. For every mesh, clip each triangle against the two planes `x = xMin` and `x = xMax` in **world** space (Sutherland–Hodgman), interpolating **all** attributes. The output is non-indexed Float32 in **local** space.
3. Replace the geometry and rebuild the BVH (`buildModelBvh`).
4. Clone the tile root N times at `k · segmentLength`. Clones share geometry, BVH and materials.

Cost: about 0.8 s once at load in a software renderer. Each tile draws only its slab, so four tiles cost roughly 2× the original city, not 4×.

Everything downstream stays correct for free:

- **Rain height pass:** it renders the scene from above and sees exactly the clipped tiles.
- **Weapon raycasts:** they hit the tiled BVH geometry.
- **Shadows:** static tiles, and the shadow map never moves.

## 2. Seams

Where the slab is cut you would see hollow building cross-sections. `createSeamGate` adds dark bulkheads over the building rows (z < 10 and z > 40) plus a neon arch over the street at `x = segmentStartX`. The arch reads as a "sector gate". It is part of the tile, so every seam has one.

## 3. Floating origin (never move the world)

The player always runs inside tile 0. When `x > segmentStartX + segmentLength`, `track.getWrapShift` returns `−segmentLength`, and **every dynamic system** gets `shiftX(shift)` in the same frame:

```
controls, drones, projectiles, obstacles, pickups, fx, spawner cursor
```

The tiles are identical, so the jump is invisible. Static objects never move, so the shadow map (`autoUpdate = false`) stays valid.

The other systems handle the jump themselves:

| System | Why nothing breaks |
|--------|--------------------|
| Rain | Drops already wrap modulo the rain area around the camera; out-of-place drops respawn when below the new floor. |
| Collision height RT | Re-centers on the camera every frame. |
| Ground | Follows the player in whole texture tiles. `segmentLength` is a multiple of `RUNNER.groundTile` (212 / 8), and `createWorld` sets `uvRepeat = size / groundTile`. |

## 4. First-person rifle with the TSL post stack

The post pipeline renders **cloned** cameras (`sceneCamera`, `aoCamera`), so children of the main camera are never drawn. The viewmodel therefore lives in the scene and copies the camera pose each frame.

It sits on `VIEWMODEL_LAYER` (5):

- The main camera enables layer 5, so the scene pass draws it.
- The `aoCamera` explicitly disables it, so GTAO does not darken the gun.
- The ground mirror and rain height cameras only see layer 0 (plus rain).

The rifle, drones and obstacles are **procedural hard-surface models** (`src/runner/models/`), built at real-world scale:

- **Parts:** `createPartKit` adds bevelled boxes, extruded side profiles, tubes and tori under a material key, then merges each key into **one mesh**. A ~70-part carbine is ~12 draw calls.
- **Surface detail:** `materials.js` adds detail with TSL noise on `positionLocal`: anodizing variation, grip stipple, carbon twill, chipped paint, hazard stripes, concrete grime. There are no textures to load, and the scene env map and neon lights do the rest.
- **Per-drone state:** hit flash, sensor glow and accent color come from `uniform().onObjectUpdate(({ object }) => object.userData.fx…)`. All drones of a type share materials and pipelines.
- **Rotors:** they are single discs whose blades are animated in the fragment shader (no per-rotor transforms).
- **Rifle screen:** the rifle's receiver has a small `CanvasTexture` screen that mirrors the ammo count.

## 5. Combat without per-object raycasts

- **Hits:** one hitscan ray per shot. Drones and bolts use an analytic ray–sphere test; the city uses one `firstHitOnly` BVH ray for impacts and wall occlusion.
- **Player collision:** the player is an AABB (`controls.getPlayerBox`), tested against obstacle AABBs, bolts (point in box) and kamikaze spheres.
- **Dodgeable bolts:** bolt velocity is `runVelocity + aim·speed`, so in the player's frame each bolt flies straight at where the player **was**. Switching lane, jumping or sliding dodges it.
- **Touch:** aim assist auto-fires when a drone is inside a 4.5° cone and pulls the shot toward it.

## 6. Pooling + warmup

Every pooled object is allocated at load: drones per type, bolts, tracers, explosions, sparks (one `InstancedMesh`), obstacles and pickups. `createRunnerGame().warm.begin()` makes one of each visible in front of the camera during both `compileAsync` passes (`src/runtime/warmup.js`), so the first shot or explosion does not stall on pipeline creation.

Runner dynamics are listed in `world.collisionHideExtra`, which `collectCollisionHideObjects` hides from the rain height pass.

## 7. Budgets (`performanceProfile`)

| Flag | Desktop | Mobile |
|------|---------|--------|
| `runnerSegmentsBehind` | 1 | 1 |
| `runnerSegmentsAhead` | 2 | 1 |
| `runnerMaxDrones` | 8 | 5 |
| `runnerSparkCount` | 256 | 128 |
| `runnerTracerCount` | 24 | 12 |
| `runnerWeaponLight` | true | false |
| `runnerLaneLights` | true | true |

`camera.far` is capped at `segmentLength · runnerSegmentsAhead − 5`, so the view never reaches past the last tile.

## 8. Game-feel and meta layer

- **Time control** (`updateRunning` in `createRunnerGame.js`):
  - Hit-stop freezes the whole sim for a few real-time milliseconds.
  - Last-chance slow-mo scales `delta` by 0.35 when `lethalHitImminent()` finds an obstacle about 0.3 s ahead in the current lane that overlaps the player's height, or a bolt that would kill you.
  - Both count real time, so they never stretch themselves.
- **Near misses:**
  - Obstacles are flagged `arrived` when their front reaches the player. A near miss is the player being in that lane having jumped or slid within 0.35 s, or having left that lane within 0.35 s.
  - Bolts track their closest distance to the player box and report it once they are behind the player.
- **Determinism:** `rng.js` has two seeded streams, one for the layout and one for drone waves. Combat outcomes change how often the drone spawner rolls, and must never shift the Daily Run's obstacle layout. Drone *behaviour* still uses `Math.random`.
- **New dynamic objects** (the carrier and its launched scouts) live in the existing drone pools, so `shiftX` and the rain hide list already cover them.
- **Death animation:** `die()` calls `viewmodel.setDeathProgress(0)` and the `dying` state drives it with `stateTime / DEATH_DURATION` (real time, not the slow-mo delta). `createHands.release()` moves both hands from the gun anchors into rig space; they flinch into a bracing pose, then go limp and drop out of frame while the gun jolts and tumbles away. `resetRun()` passes −1, and `restore()` puts the hands back on the gun.
- **Run snapshots** (`createRunSnapshots.js`): at random run times (the first at 4–12 s, then every 7–20 s) the game queues a capture. The render loop copies the canvas right after `post.render()`, while it is in the same task, so the WebGPU swap-chain texture can still be read. A reservoir keeps 4 frames. If a run ends before any capture, the fatal frame is kept instead. At game over one random frame is shown on the stub. The player can share it (`sharePhoto`, a 1080×1350 card), save it, or pick another frame.
- **Moebius comic mode** (`src/tsl/moebius.js`): an alternate post style that replaces the neon grade and film grain in `rebuildSteadyOutput` (`pipeline.setVisualStyle("moebius" | "neon")`). It draws ink outlines from outer log-depth silhouettes plus a luminance Sobel on the scene colour, with the Sobel off on mobile via `performanceProfile.moebiusColorEdges`. Luminance is banded in perceptual space and split-toned (violet shadows, warm lights). Grey surfaces are pulled strongly toward a Moebius ramp (ultramarine → violet → coral → saffron → mint cream); already-coloured surfaces keep their hue. The darkest bands get cross-hatching. It adds lavender distance haze, a turquoise → lavender → peach sky, and warm paper grain. Bloom is added after the ink so neon stays vivid. Glowing shapes (laser tracers, neon, LEDs) then get a thin ink ring from the emissive buffer, drawn over the bloom halo. The player toggles it with STYLE on the start ticket or in Settings → Look, and the choice is saved in localStorage.
- **Soundtrack** (`audio/createMusicPlayer.js`, `audio/musicCatalog.js`, `ui/runner/musicPlayerUi.js`): an EA FC-style licensed-music catalog for the tracks in `public/game music`. Covers come from the ID3 art, extracted to `covers/*-512.jpg` / `*-128.jpg`. Two `<audio>` decks stream through Web Audio (per-deck gains for crossfade, master volume, a pause duck, an analyser for the visualizer); gains live in Web Audio because iOS ignores `element.volume`. The game sets a context (`menu` / `run` / `paused` / `dead`), and settings decide whether music plays in menus or during runs. The *Synth score* source hands runs back to the procedural `createAdaptiveMusic`. The start ticket has a MUSIC screen: now playing with a spinning vinyl, visualizer, seek bar and transport; the tracklist with in-rotation toggles; and source, volume, menus / runs, pop-ups and crossfade settings, persisted in localStorage. The pause screen has a mini player, a now-playing card slides in on every track change, N skips, and the OS media keys work via Media Session.
- **Comic-style tuning** (`src/post/moebiusSettings.js`): Settings → Look exposes the Moebius uniforms as presets (Arzach = shipped values, Pastel, Ink Noir, Sunset Pulp, Neon Night, Clean Line, Sketchbook) plus a "Tune comic style" drawer with line, tone and texture sliders and palette colour pickers. Edits are live uniform writes with no rebuild, persisted in localStorage, and "Reset configs" clears them. Colour pickers are sRGB; `Color.set()` converts to the linear uniform values.
- **Snapshot viewer**: clicking the game-over photo opens a full-screen viewer (browser fullscreen on PC) with share, save and another-shot controls. ← / → cycle shots and Esc closes. Keys are captured while it is open, so Enter can't restart the run.
- **PC aim assist** (`src/platform/gameplaySettings.js`): an opt-in Settings → Gameplay toggle plus strength, or T in-run. It reuses the touch target picker, but with mouse-friendly `autoAim` options: no re-centring without a target, a speed scaled by strength, and a pause for 260 ms after deliberate mouse movement.
- **Sky Run** (flying-car power-up; `createFlightMode.js`, `models/createFlyingCarModel.js`). The car is the project's Quadra (`world.car`), cloned with transforms unfrozen, yawed so its nose points +X, centred, and fitted with hover pads, twin rear jets and side cannon pods (the muzzles). A procedural car is the fallback when the car feature is off. Flight steering is a spring-damper (`RUNNER.flightSpring`): a lane switch reaches 90% in ~0.4 s with ~0.2 m overshoot. The car banks from lateral velocity plus acceleration (leans in, counter-leans on settle), noses into its travel and pitches on climbs, all smoothed. The chase cam trails with its own softer follow and light roll, plus a small FOV punch on fast strafes. Steering into the wall at an outer lane does a barrel roll. a rare `flycar` pickup appears in reward lines from 380 m, then every 900–1400 m (seeded). Collecting it switches to a Star Fox-style rail shooter:
  - `controls.setFlight(true)` gives the same inputs new meanings: A/D strafe across wider sky lanes (`RUNNER.flightLaneZ`), jump / slide climb or dive between altitude tiers (`flightAltitudes`). There is no gravity, and a chase camera blends in from first person over ~1.1 s while the car swoops in ahead.
  - Hitscan still fires from the camera through the crosshair; `weapon.setMuzzleProvider` sends tracers from the car's alternating cannons. Specials launch from the nose.
  - Drones fight at altitude via a virtual `player.floorY` 4.5 m below the car.
  - Ground obstacles are cleared and their spawner paused. Sky hazards (tier billboards, lane pylons, one-open-cell gates) and shard arcs take over, getting denser with flight time.
  - `damagePlayer` routes all damage to the car's hull (300 base; Armory **SKY CAR** tiers: Reinforced Chassis +20% hull per level, Car Cannons +10% damage while flying, Auto-Repair +3 hull/s after 2 s without a hit, Sky Permit brings the pickup sooner and more often; total levels give the Quadra's Mk shown on the gauge), shown on the HUD hull gauge. Distance pays ×1.5, and speed is ×1.3.
  - At 0 hull the car explodes and its wreck tumbles away. The runner drops back to the street (`setFlight(false)`: gravity plus the first-person blend) with 2.6 s of invulnerability, a slow-mo beat and a 70 m clear street.
  - The car and hazards are in `collisionHideObjects`, shift with the floating origin, and are warmed at startup. Dev shortcut: `__app.runner.startFlight()`.
- **Audio volumes**: `audioState` holds a persisted SFX volume. `audioVolume` (read by ambience, engines and footsteps) is its base level scaled by SFX, so existing subscribers follow it. Runner audio has an SFX bus (`master`) and a separate music bus for the synth score, which follows the soundtrack's music volume. Settings → Audio has Music and Sound-effects sliders, and the MUSIC screen has a matching SFX slider.
- **Graphics settings** (`platform/graphicsSettings.js`): the Development Mode performance flags are offered in Settings → Graphics as presets (Low / Medium / High / Ultra) plus advanced toggles and sliders, and are saved in localStorage. "High" is the device baseline captured after `applyDevicePerformanceDefaults`. On phones and Safari, resolution is capped at that baseline, and DoF stays locked off in Safari. Rain density sets `weather.setMaxDropCount`.

## Port checklist

- [ ] Choose a straight slab; confirm lanes are clear (a vertical ray probe along each lane z).
- [ ] Slice every city-scale root with `sliceGeometryX` and keep small props whole.
- [ ] Put seam covers inside the tile so every clone carries them.
- [ ] Keep the player in tile 0; give every dynamic system a `shiftX`.
- [ ] Make repeating world-space textures divide the segment length.
- [ ] Draw a camera-attached viewmodel on its own layer when the post uses cloned cameras.
