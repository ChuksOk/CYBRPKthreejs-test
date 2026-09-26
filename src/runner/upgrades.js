/**
 * In-run upgrades: at every sector gate the run pauses and the player picks
 * one of three random cards (Vampire-Survivors-style build crafting). Each
 * card mutates the shared `mods` object read by weapon / specials / game.
 */

export function createRunMods() {
  return {
    fireRate: 1,
    mag: 1,
    damage: 1,
    reload: 1,
    pierce: false,
    railExplosive: false,
    shieldRegen: 1,
    secondWind: 0,
    magnet: false,
    chargeRate: 1,
    maxCharges: 1,
    allyTwin: false,
    seekerSplit: false,
  };
}

export const UPGRADES = [
  { id: "rapid", name: "RAPID CYCLE", desc: "+25% fire rate", max: 3, apply: (m) => { m.fireRate *= 1.25; } },
  { id: "mags", name: "EXTENDED MAGS", desc: "+40% magazine size", max: 2, apply: (m) => { m.mag *= 1.4; } },
  { id: "hollow", name: "HOLLOW POINTS", desc: "+20% damage", max: 3, apply: (m) => { m.damage *= 1.2; } },
  { id: "pierce", name: "PIERCING ROUNDS", desc: "Shots punch through into a second drone", max: 1, apply: (m) => { m.pierce = true; } },
  { id: "railboom", name: "RAIL DETONATOR", desc: "VX-12 rail hits explode", max: 1, apply: (m) => { m.railExplosive = true; }, requires: (ctx) => ctx.hasRail },
  { id: "hands", name: "QUICK HANDS", desc: "Reload 35% faster", max: 2, apply: (m) => { m.reload *= 1.35; } },
  { id: "capacitor", name: "CAPACITOR", desc: "Shield regenerates 2× faster", max: 2, apply: (m) => { m.shieldRegen *= 2; } },
  { id: "wind", name: "SECOND WIND", desc: "Survive one fatal hit", max: 1, apply: (m) => { m.secondWind += 1; } },
  { id: "magnet", name: "ENERGY MAGNET", desc: "Pull energy in from every lane", max: 1, apply: (m) => { m.magnet = true; } },
  { id: "battery", name: "SPECIAL BATTERY", desc: "Special charges 30% faster", max: 2, apply: (m) => { m.chargeRate *= 1.3; } },
  { id: "double", name: "DOUBLE CHARGE", desc: "Hold two specials at once", max: 1, apply: (m) => { m.maxCharges = 2; } },
  { id: "twin", name: "TWIN GUNS", desc: "Ally drone fires twice as fast", max: 1, apply: (m) => { m.allyTwin = true; }, requires: (ctx) => ctx.special === "ally" },
  { id: "cluster", name: "CLUSTER SEEKER", desc: "Seeker splits into three", max: 1, apply: (m) => { m.seekerSplit = true; }, requires: (ctx) => ctx.special === "seeker" },
];

/**
 * @param {Record<string, number>} taken  upgrade id → times taken
 * @param {object} ctx  { special, hasRail }
 * @param {() => number} random
 */
export function rollUpgradeChoices(taken, ctx, random = Math.random) {
  const pool = UPGRADES.filter((u) => (taken[u.id] ?? 0) < u.max && (!u.requires || u.requires(ctx)));
  const picks = [];
  while (picks.length < 3 && pool.length) {
    picks.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  }
  return picks;
}
