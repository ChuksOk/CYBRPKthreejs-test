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
| HUD + screens | `src/ui/runner/createRunnerHud.js`, `runnerHud.css` |
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

The CC0 Kenney models are restyled in code: gunmetal `MeshStandardNodeMaterial` over the palette texture. The palette's saturated cells become `emissiveNode` glow, measured as `max(rgb) − min(rgb)`, so bloom picks them up.

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

`camera.far` is capped at `segmentLength · runnerSegmentsAhead − 5`, so the view never reaches past the last tile.

## Port checklist

- [ ] Choose a straight slab; confirm lanes are clear (a vertical ray probe along each lane z).
- [ ] Slice every city-scale root with `sliceGeometryX` and keep small props whole.
- [ ] Put seam covers inside the tile so every clone carries them.
- [ ] Keep the player in tile 0; give every dynamic system a `shiftX`.
- [ ] Make repeating world-space textures divide the segment length.
- [ ] Draw a camera-attached viewmodel on its own layer when the post uses cloned cameras.
