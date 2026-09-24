# Technique deep dives

Focused guides for humans and coding agents. Each doc is self-contained enough to replicate the idea in another project.

| Technique | Doc | Primary code |
|-----------|-----|----------------|
| GPU rain + collision height texture | [collision-rain.md](./collision-rain.md) | `src/world/weather/createCollisionHeight.js`, `createCollisionRain.js` |
| Wet ground (ripples + planar reflection) | [wet-ground.md](./wet-ground.md) | `src/world/ground/createGround.js`, `src/tsl/rainRipples.js` |
| Car surface rain (procedural drops) | [car-surface-rain.md](./car-surface-rain.md) | `src/tsl/surfaceRain.js`, `src/world/car/applyCarSurfaceRain.js` |
| Endless runner + drone shooter (tiled city, floating origin, viewmodel) | [endless-runner.md](./endless-runner.md) | `src/runner/`, `src/weapon/`, `src/enemies/` |

The [README](../../README.md) and [AGENTS.md](../../AGENTS.md) remain the index.
