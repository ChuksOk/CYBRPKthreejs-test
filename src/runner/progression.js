import { todayKey } from "./rng.js";

/**
 * Persistent meta-progression (localStorage): shard bank, Armory unlocks and
 * tiers, cosmetics, missions + XP rank, daily streak, local records and the
 * first-run tutorial flag. Everything degrades gracefully if storage is
 * unavailable (private mode): progress simply lasts for the session.
 */

const STORAGE_KEY = "neon-run-progress-v1";
const MAX_RANK = 50;

/** Armory: guns (index into WEAPONS), permanent tiers, cosmetics. */
export const ARMORY = {
  weapons: [
    { index: 1, code: "VX-09", name: "SMG", cost: 400 },
    { index: 2, code: "VX-12", name: "RAIL", cost: 900 },
    { index: 3, code: "VX-14", name: "HEAVY", cost: 1500 },
  ],
  tiers: [
    { id: "armor", name: "ARMOR PLATING", desc: "+10 max shield", max: 5, base: 250 },
    { id: "damage", name: "HOT LOADS", desc: "+6% weapon damage", max: 5, base: 300 },
    { id: "magnet", name: "SHARD MAGNET", desc: "+pickup range", max: 4, base: 200 },
    { id: "charge", name: "PRE-CHARGE", desc: "+15% special at start", max: 4, base: 250 },
    // Sky Run car (Quadra) upgrades — shown under SKY CAR in the Armory.
    { id: "carHull", group: "car", name: "REINFORCED CHASSIS", desc: "+20% car hull", max: 5, base: 300 },
    { id: "carGuns", group: "car", name: "CAR CANNONS", desc: "+10% damage while flying", max: 5, base: 300 },
    { id: "carRepair", group: "car", name: "AUTO-REPAIR", desc: "+3 hull/s when not hit", max: 4, base: 350 },
    { id: "carPermit", group: "car", name: "SKY PERMIT", desc: "Sky Run appears sooner", max: 3, base: 400 },
  ],
  tracers: [
    { id: "green", name: "NEON GREEN", hex: 0x5dff3a, cost: 0 },
    { id: "cyan", name: "ICE CYAN", hex: 0x22d3ee, cost: 300 },
    { id: "pink", name: "HOT PINK", hex: 0xff4f74, cost: 300 },
    { id: "gold", name: "GOLD RUSH", hex: 0xffc21a, cost: 600 },
  ],
  blasts: [
    { id: "fire", name: "FIREBALL", hex: 0xff9a3c, cost: 0 },
    { id: "plasma", name: "PLASMA", hex: 0x5dff3a, cost: 500 },
    { id: "void", name: "VOID", hex: 0xb86bff, cost: 500 },
  ],
};

export function tierCost(tier, level) {
  return tier.base * (level + 1);
}

/** Mission templates. `run` = within one run, `total` = cumulative. */
const MISSION_POOL = [
  { id: "kills", scope: "run", stat: "kills", text: (n) => `Down ${n} drones in one run`, base: 8, step: 3 },
  { id: "gunships", scope: "run", stat: "gunshipKills", text: (n) => `Down ${n} gunships in one run`, base: 2, step: 1 },
  { id: "kamikaze", scope: "run", stat: "kamikazeKills", text: (n) => `Shoot ${n} kamikazes before they hit`, base: 3, step: 1 },
  { id: "slides", scope: "run", stat: "slides", text: (n) => `Slide under ${n} beams in one run`, base: 6, step: 3 },
  { id: "jumps", scope: "run", stat: "barriersJumped", text: (n) => `Jump ${n} barriers in one run`, base: 6, step: 3 },
  { id: "clean", scope: "run", stat: "cleanDistance", text: (n) => `Run ${n} m without taking damage`, base: 400, step: 150 },
  { id: "distance", scope: "run", stat: "distance", text: (n) => `Reach ${n} m in one run`, base: 800, step: 300 },
  { id: "nearmiss", scope: "run", stat: "nearMisses", text: (n) => `Pull off ${n} close calls in one run`, base: 4, step: 2 },
  { id: "shards", scope: "run", stat: "shards", text: (n) => `Collect ${n} shards in one run`, base: 40, step: 15 },
  { id: "specials", scope: "total", stat: "specialsUsed", text: (n) => `Use your special ${n} times`, base: 3, step: 2 },
  { id: "boss", scope: "total", stat: "bossKills", text: (n) => `Destroy ${n} carrier${n > 1 ? "s" : ""}`, base: 1, step: 1 },
  { id: "totalkills", scope: "total", stat: "kills", text: (n) => `Down ${n} drones in total`, base: 40, step: 20 },
];

function defaults() {
  return {
    shards: 0,
    lifetimeShards: 0,
    unlockedWeapons: [0],
    tiers: { armor: 0, damage: 0, magnet: 0, charge: 0, carHull: 0, carGuns: 0, carRepair: 0, carPermit: 0 },
    tracers: ["green"],
    tracer: "green",
    blasts: ["fire"],
    blast: "fire",
    xp: 0,
    rank: 1,
    missions: [],
    missionsCompleted: 0,
    streak: { last: "", count: 0 },
    records: [],
    daily: { date: "", best: 0 },
    tutorialDone: false,
    runs: 0,
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return { ...defaults(), ...JSON.parse(raw) };
    }
  } catch {
    // Storage unavailable / corrupted — start fresh.
  }
  return defaults();
}

export function xpForRank(rank) {
  return 120 + (rank - 1) * 45;
}

export function createProgression() {
  const data = load();

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // ignore
    }
  }

  function makeMission(template) {
    const level = Math.floor((data.missionsCompleted + data.rank) / 3);
    const target = template.base + template.step * level;
    return {
      id: template.id,
      scope: template.scope,
      stat: template.stat,
      target,
      progress: 0,
      text: template.text(target),
      xp: 60 + level * 10,
      shards: 60 + level * 15,
    };
  }

  function refillMissions() {
    const active = new Set(data.missions.map((m) => m.id));
    const pool = MISSION_POOL.filter((m) => !active.has(m.id));
    while (data.missions.length < 3 && pool.length) {
      const index = Math.floor(Math.random() * pool.length);
      data.missions.push(makeMission(pool.splice(index, 1)[0]));
    }
  }

  refillMissions();
  save();

  /** Live mission progress during a run (for toasts). Returns newly completed. */
  function trackRun(runStats) {
    const done = [];
    for (const mission of data.missions) {
      if (mission.done) {
        continue;
      }
      const value = mission.scope === "run" ? runStats[mission.stat] ?? 0 : (mission.base ?? 0) + (runStats[mission.stat] ?? 0);
      mission.live = Math.min(mission.target, Math.floor(value));
      if (value >= mission.target) {
        mission.done = true;
        done.push(mission);
      }
    }
    return done;
  }

  function beginRun() {
    for (const mission of data.missions) {
      mission.base = mission.scope === "total" ? mission.progress : 0;
      mission.live = mission.progress;
    }
  }

  function addXp(amount) {
    const rankUps = [];
    data.xp += amount;
    while (data.rank < MAX_RANK && data.xp >= xpForRank(data.rank)) {
      data.xp -= xpForRank(data.rank);
      data.rank += 1;
      rankUps.push(data.rank);
    }
    return rankUps;
  }

  /** Streak: consecutive local days with at least one run. */
  function touchStreak() {
    const today = todayKey();
    if (data.streak.last === today) {
      return data.streak.count;
    }
    const yesterday = todayKey(new Date(Date.now() - 86400000));
    data.streak.count = data.streak.last === yesterday ? data.streak.count + 1 : 1;
    data.streak.last = today;
    return data.streak.count;
  }

  function streakMultiplier() {
    return 1 + Math.min(Math.max(0, data.streak.count - 1), 6) * 0.1;
  }

  /**
   * Settle a finished run: bank shards (× streak), XP, missions, records.
   * @returns summary for the game-over ticket
   */
  function endRun(stats) {
    data.runs += 1;
    const streak = touchStreak();
    const multiplier = streakMultiplier();
    const completed = [];
    for (const mission of data.missions) {
      const value = mission.scope === "run" ? stats[mission.stat] ?? 0 : (mission.progress ?? 0) + (stats[mission.stat] ?? 0);
      mission.progress = Math.min(mission.target, Math.floor(value));
      if (value >= mission.target) {
        completed.push(mission);
      }
    }
    data.missions = data.missions.filter((m) => !completed.includes(m));
    data.missionsCompleted += completed.length;

    const missionShards = completed.reduce((sum, m) => sum + m.shards, 0);
    const earned = Math.round((stats.shards + Math.floor(stats.distance / 25) + stats.kills * 2) * multiplier) + missionShards;
    data.shards += earned;
    data.lifetimeShards += earned;

    const xp = Math.round(stats.distance / 10 + stats.kills * 4 + stats.score / 200) + completed.reduce((s, m) => s + m.xp, 0);
    const rankUps = addXp(xp);

    const record = {
      score: stats.score,
      distance: Math.round(stats.distance),
      kills: stats.kills,
      date: todayKey(),
      daily: Boolean(stats.daily),
    };
    data.records.push(record);
    data.records.sort((a, b) => b.score - a.score);
    data.records = data.records.slice(0, 10);
    let dailyBest = false;
    if (stats.daily) {
      if (data.daily.date !== todayKey()) {
        data.daily = { date: todayKey(), best: 0 };
      }
      if (stats.score > data.daily.best) {
        data.daily.best = stats.score;
        dailyBest = true;
      }
    }

    refillMissions();
    save();
    return { earned, multiplier, streak, xp, rankUps, completed, dailyBest, recordRank: data.records.indexOf(record) + 1 };
  }

  function spend(amount) {
    if (data.shards < amount) {
      return false;
    }
    data.shards -= amount;
    save();
    return true;
  }

  function buyWeapon(index) {
    const item = ARMORY.weapons.find((w) => w.index === index);
    if (!item || data.unlockedWeapons.includes(index) || !spend(item.cost)) {
      return false;
    }
    data.unlockedWeapons.push(index);
    save();
    return true;
  }

  function buyTier(id) {
    const tier = ARMORY.tiers.find((t) => t.id === id);
    const level = data.tiers[id] ?? 0;
    if (!tier || level >= tier.max || !spend(tierCost(tier, level))) {
      return false;
    }
    data.tiers[id] = level + 1;
    save();
    return true;
  }

  function buyOrEquip(kind, id) {
    const list = kind === "tracer" ? ARMORY.tracers : ARMORY.blasts;
    const owned = kind === "tracer" ? data.tracers : data.blasts;
    const item = list.find((x) => x.id === id);
    if (!item) {
      return false;
    }
    if (!owned.includes(id)) {
      if (!spend(item.cost)) {
        return false;
      }
      owned.push(id);
    }
    data[kind] = id;
    save();
    return true;
  }

  function setTutorialDone() {
    data.tutorialDone = true;
    save();
  }

  return {
    data,
    save,
    beginRun,
    trackRun,
    endRun,
    buyWeapon,
    buyTier,
    buyOrEquip,
    setTutorialDone,
    isWeaponUnlocked: (index) => data.unlockedWeapons.includes(index),
    tracerHex: () => (ARMORY.tracers.find((t) => t.id === data.tracer) ?? ARMORY.tracers[0]).hex,
    blastHex: () => (ARMORY.blasts.find((b) => b.id === data.blast) ?? ARMORY.blasts[0]).hex,
    streakMultiplier,
    todayDailyBest: () => (data.daily.date === todayKey() ? data.daily.best : 0),
  };
}
