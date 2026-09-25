/**
 * Run randomness. Normal runs use Math.random; the Daily Run swaps in a
 * seeded generator (same seed for everyone on a given date) so the obstacle
 * layout, pickups and drone waves are identical for every player that day.
 */
let generator = Math.random;
// Independent stream for drone waves, so combat outcomes (which change how
// often the drone spawner rolls) never shift the obstacle layout.
let droneGenerator = Math.random;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Local calendar date, e.g. "2026-09-25". */
export function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function setRunSeed(seedText) {
  generator = seedText ? mulberry32(hashString(`neon-run:${seedText}`)) : Math.random;
  droneGenerator = seedText ? mulberry32(hashString(`neon-drones:${seedText}`)) : Math.random;
}

/** Drone-wave stream (see above). */
export function rrDrone() {
  return droneGenerator();
}

export function rr() {
  return generator();
}

export function rrRange(min, max) {
  return min + generator() * (max - min);
}

export function rrPick(list) {
  return list[Math.floor(generator() * list.length)];
}

export function rrWeighted(entries, random = generator) {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = random() * total;
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll <= 0) {
      return entry.value;
    }
  }
  return entries[entries.length - 1].value;
}

export function rrShuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(generator() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
