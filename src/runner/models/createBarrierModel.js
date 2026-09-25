import { createPartKit } from "./modelKit.js";
import { concrete, emissive, gunmetal, hazard } from "./materials.js";

/**
 * Jersey barrier spanning one lane (≈2.9 m along Z, 0.8 m tall) with a
 * reflective hazard band, lifting eyes and acid reflector studs.
 */
export function createBarrierModel() {
  const kit = createPartKit();
  const width = 2.9;
  // Side profile (X = run axis, Y = up), extruded across the lane (Z).
  kit.profile("concrete", [
    [-0.3, 0], [0.3, 0], [0.3, 0.07], [0.12, 0.3], [0.08, 0.8], [-0.08, 0.8], [-0.12, 0.3], [-0.3, 0.07],
  ], width, { bevel: 0.02 });
  // Hazard band on the approach face.
  kit.box("hazard", [0.02, 0.16, width * 0.96], { position: [-0.105, 0.58, 0], rotation: [0, 0, -0.08], radius: 0.004 });
  // Reflector studs.
  for (let i = -3; i <= 3; i++) {
    kit.box("reflector", [0.012, 0.04, 0.09], { position: [-0.093, 0.42, i * 0.38], rotation: [0, 0, -0.08], radius: 0.004 });
  }
  // Lifting eyes on top.
  for (const z of [-0.9, 0.9]) {
    kit.torus("metal", 0.04, 0.008, { position: [0, 0.82, z], rotation: [0, Math.PI / 2, 0], tubular: 16 });
  }
  return kit.build({
    concrete: concrete(),
    hazard: hazard({ scale: 9 }),
    reflector: emissive(0xd9ff3b, 3),
    metal: gunmetal({ tint: 0x3a3a38, roughness: 0.5 }),
  }, { name: "barrier", castShadow: true });
}
