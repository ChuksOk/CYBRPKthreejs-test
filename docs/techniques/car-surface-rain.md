# Procedural rain on the car

How the Quadra reads as wet paint and wet glass **without a simulation texture**. Drops are a TSL math graph evaluated in the material. The ground does **not** use this graph — see [wet-ground.md](./wet-ground.md).

**Audience:** graphics programmers and coding agents porting this pattern.

**Source of truth:** [`surfaceRain.js`](../../src/tsl/surfaceRain.js), [`applyCarSurfaceRain.js`](../../src/world/car/applyCarSurfaceRain.js).

The drop motion is adapted from **[rocksdanister/rain](https://github.com/rocksdanister/rain)** (BigWings-style `MovingDropLayer`). That credit stays in the source file. This repository’s MIT license covers the integration, not that original shader as a separate work.

---

## What you see

Sliding drops, trails, and small satellite droplets on body panels and glass. Roughness drops where the mask is strong, so the clearcoat and env map pick up neon. There is no extra render target for the drops.

---

## System diagram

```mermaid
flowchart LR
  uv1["uv 1 rain channel"] --> graph[evaluateCarSurfaceRain]
  time[uTime uniform] --> graph
  graph --> mask[mask]
  graph --> nrm[normalOffset finite difference]
  mask --> rough[roughnessNode mix toward wet]
  nrm --> normalNode[normalNode]
  dist[Camera distance] --> intensity[uIntensity 0 to 1]
  intensity --> rough
```

---

## Part 1 — Drop graph

**File:** `src/tsl/surfaceRain.js`

Shared helpers: `N13` / `N` hashes, `Saw` envelope, `MovingDropLayer` (grid cell, falling drop, trail, droplets). Returns `vec2(mask, edge)`.

Two evaluators:

| Function | Used by | Static beads |
|----------|---------|----------------|
| `evaluateSurfaceRain` | Exported; intro glass uses the same family via `rainGlass.js` | Yes |
| `evaluateCarSurfaceRain` | Car paint and glass | **No** (`getCarRainLayerWeights` forces static weight to 0) |

Static beads on the car’s secondary UV blinked. Moving layers only.

`evaluateCarSurfaceRain(uv(1), uniforms)`:

1. Time `uTime * 1.2 * uSpeed`.
2. Scale the rain UV by `uScale` (default 20.5) before the grid.
3. `computeCarDropNormalOffset` evaluates the mask **three times** (center, +ε X, +ε Y, ε = 0.005) and returns `normalOffset = (cx - c, cy - c)` in tangent XY.

One uniform block from `createSurfaceRainUniforms()` is shared by every converted material (`uTime`, `uIntensity`, `uScale`, `uDropSize`, paint vs glass roughness and normal strength, `uDropletMix`).

---

## Part 2 — UV split

PBR maps stay on **UV0** (`uv()`). Rain uses **UV1** (`uv(1)`, `TEXCOORD_1`).

The Quadra UVs for that channel were corrected in Blender (commit `1338ccd`). If you port this, give the mesh a second UV that unfolds the panels you want wet. Do not reuse a mirrored or overlapping UV0 or drops will tile across unrelated islands.

---

## Part 3 — Wiring materials

**Entry:** `applyCarSurfaceRain(carRoot)`

- Paint candidates become `MeshStandardNodeMaterial` (`ensurePaintNodeMaterial`).
- Named glass (`77_5`) becomes `MeshPhysicalNodeMaterial` with a smoked clearcoat look (`applyGlassLook`): low roughness, metalness 0, clearcoat 1. Opaque, not alpha-blended glass.
- `mat_0.001` and very transparent or strongly emissive non-metals are skipped.

`wireSurfaceRain`:

- `rainAmount = mask * uIntensity`
- `roughnessNode = mix(baseRoughness, wetRoughness, rainAmount)`
- `normalNode` adds `normalOffset * normalStrength` on top of the existing normal map (or uses the offset alone).
- Glass also mixes albedo toward a cool tint with `uGlassWetBrighten` so beads read on dark glass.
- Emissive maps stay on UV0 so bloom is unchanged.

`update(delta)` only advances `uTime`. There is no per-texel simulation.

---

## Part 4 — Distance fade

`syncProximity({ camera, carRoot, rainEnabled })` runs from the render loop.

Intensity is 0 when rain is off, `carSurfaceRain` is false, or the camera is missing. Otherwise it smoothsteps from **1** at `carSurfaceRainFadeStart` (default **20** m) to **0** at `carSurfaceRainFadeEnd` (default **32** m).

The shader still runs, but a zero intensity removes the wet mix. That is the budget knob when the car is a small shape in the distance.

---

## Replication checklist

- [ ] Port or import the drop `Fn` graph. Keep the upstream credit.
- [ ] Put rain on a dedicated UV channel.
- [ ] Finite-difference the mask into a tangent offset. Drive `roughnessNode` and `normalNode`.
- [ ] Share one uniform block across materials.
- [ ] Skip static drops if the rain UV islands pop.
- [ ] Fade `uIntensity` by camera distance.
- [ ] Do not also run this graph on the ground. Ground wetness is ripples plus a planar mirror.

---

## Related docs

- [README — Wet surfaces](../../README.md#wet-surfaces--two-different-systems)
- [AGENTS.md — Recipe B](../../AGENTS.md)
- [Wet ground](./wet-ground.md)
- Intro screen drops: `src/tsl/rainGlass.js` (same family, applied to screen UV)
