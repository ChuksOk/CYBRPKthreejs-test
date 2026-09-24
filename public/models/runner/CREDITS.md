# Runner model credits

From **Kenney — Starter Kit FPS**
(https://github.com/KenneyNL/Starter-Kit-FPS, commit `185fd23`), CC0 1.0
(https://creativecommons.org/publicdomain/zero/1.0/).

| File | Used as |
|------|---------|
| `blaster-repeater.glb` | First-person rifle (restyled in `src/weapon/createViewmodel.js`) |
| `enemy-flying.glb` | Drones (restyled in `src/enemies/createDroneManager.js`) |
| `wall-low.glb` | Jump barrier (restyled in `src/runner/createObstacles.js`) |
| `Textures/colormap.png` | Shared palette texture for the three models |

Materials are replaced at load time (gunmetal PBR + neon emissive from the
palette's saturated cells); geometry is unmodified. Parked-car obstacles
reuse the scene's existing `quadra.glb`.
