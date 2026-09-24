# Runner audio credits

All files in this folder come from **Kenney — Starter Kit FPS**
(https://github.com/KenneyNL/Starter-Kit-FPS, commit `185fd23`).

The kit's README states: "Assets included in this package (2D sprites, 3D
models and sound effects) are CC0 licensed"
(https://creativecommons.org/publicdomain/zero/1.0/).

| File | Used for |
|------|----------|
| `blaster_repeater.ogg` | Rifle shot |
| `enemy_attack.ogg` | Drone bolt |
| `enemy_destroy.ogg` | Drone explosion |
| `enemy_hurt.ogg` | Drone hit |
| `jump_a.ogg` | Jump |
| `land.ogg` | Land |
| `weapon_change.ogg` | Reload |

Other runner sounds (countdown, pickups, damage, drone hum) are synthesized
at runtime with Web Audio in `src/audio/createRunnerAudio.js`.
