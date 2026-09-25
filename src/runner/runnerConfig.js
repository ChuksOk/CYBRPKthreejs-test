/**
 * Runner tuning. World units are meters; the run axis is +X down the main
 * alley (z ≈ 10–40 between the building rows, street floor ≈ -5.5).
 *
 * The slab [SEGMENT_START_X, SEGMENT_START_X + SEGMENT_LENGTH] was picked so
 * both seams fall on gaps between buildings on the straight part of the
 * street (see docs/techniques/endless-runner.md).
 */
export const RUNNER = {
  segmentStartX: -140,
  segmentLength: 212,

  /** Lane centers (z). Index 0 is the runner's left (-Z when facing +X). */
  laneZ: [19, 22.5, 26],
  floorY: -5.5,
  eyeHeight: 1.55,
  slideEyeHeight: 0.75,
  startX: -128,

  startSpeed: 9,
  maxSpeed: 21,
  /** Distance (m) at which difficulty reaches 1. */
  difficultyDistance: 3000,

  laneChangeSpeed: 11,
  jumpVelocity: 6.2,
  gravity: 18,
  slideDuration: 0.75,

  /** Aim limits relative to the run heading (radians). */
  maxYaw: (70 * Math.PI) / 180,
  minPitch: (-35 * Math.PI) / 180,
  maxPitch: (60 * Math.PI) / 180,

  /** Ground texture tile — segmentLength must be an integer multiple. */
  groundTile: 212 / 8,

  // Sky Run (flying car power-up): wider lanes, three altitude tiers above
  // the street floor, chase camera offsets.
  flightLaneZ: [14.5, 22.5, 30.5],
  flightAltitudes: [4.5, 8.5, 12.5],
  chaseDistance: 7.2,
  chaseHeight: 2.3,
  flightSpeedBoost: 1.3,
  flightHull: 100,

  maxHealth: 100,
  maxShield: 60,
  shieldRechargeDelay: 3.5,
  shieldRechargeRate: 22,
};

/** Layer for the first-person rifle (kept out of AO / reflection / height passes). */
export const VIEWMODEL_LAYER = 5;
