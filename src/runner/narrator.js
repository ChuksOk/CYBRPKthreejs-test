import { STORY } from "../app/credits.js";

/**
 * The narrator. The person at the keyboard plays *as* Anaiis, and Anaiis is
 * playing LOW GAMMA on a break in 2223. The game's own lines (start ticket,
 * banners, pause) speak about her in the third person; the game-over
 * session log is Anaiis herself, first person, roasting her own run.
 *
 * Pure text builders: no DOM, no game state beyond the numbers passed in.
 * Lines are picked from pools keyed to what actually happened in the run,
 * and the last pick per pool is avoided so back-to-back runs read fresh.
 */

const NAME = STORY.player;
const lastPick = new Map();

function pick(key, options) {
  const pool = options.filter(Boolean);
  if (pool.length === 0) {
    return "";
  }
  if (pool.length === 1) {
    return pool[0];
  }
  const previous = lastPick.get(key);
  const fresh = pool.filter((line) => line !== previous);
  const choice = fresh[Math.floor(Math.random() * fresh.length)];
  lastPick.set(key, choice);
  return choice;
}

const m = (value) => `${Math.floor(value)} m`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) {
    return plural(s, "second");
  }
  const minutes = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${minutes} min ${rest} s` : plural(minutes, "minute");
}

/*
 * Session log: Anaiis's own first-person post-mortem, self-deprecating.
 * Everything else the game says about her stays third person.
 */

/** How the run ended, as a clause that completes "… before ___" / "Then ___". */
function causeClause(cause, detail) {
  switch (cause) {
    case "KAMIKAZE IMPACT":
      return pick("cause-kamikaze", [
        "a kamikaze drone hugged me. Aggressively",
        "a drone gave up on shooting me and just came over in person",
        "a kamikaze drone made me its entire personality",
      ]);
    case "HIT A PARKED CAR":
      return pick("cause-car", [
        "I ran face-first into a parked car. It was parked. It had been parked the whole time",
        "I lost a fight with a car that was not moving",
        "I discovered Old Earth cars are very solid, using my face",
      ]);
    case "CLOTHESLINED":
      return pick("cause-beam", [
        "I forgot sliding exists. The beam did not",
        "a beam met my neck. I had one job, and the job was pressing S",
        "I tried to limbo a steel beam standing upright",
      ]);
    case "TRIPPED A BARRIER":
      return pick("cause-barrier", [
        "I tripped over a barrier. The one thing in this game that doesn't move",
        "I jumped a little too late, which is also how I do everything else",
        "a knee-high barrier humbled me in front of nobody",
      ]);
    default: {
      const source = (detail ?? "").split(" · ")[0];
      const gunship = /GUNSHIP|CARRIER/i.test(source);
      return pick("cause-shot", [
        "I stood exactly where the bolt was going. Great instincts",
        "the drones figured out I only ever dodge left",
        gunship ? "a gunship shot me like it had somewhere better to be" : "I tanked one bolt too many, like a champion of standing still",
        "I tried dodging with confidence instead of skill",
      ]);
    }
  }
}

/** One line about how she played, from the most notable stat. */
function observation(run) {
  const notes = [];
  if (run.bossKills > 0) {
    notes.push([5, pick("obs-boss", [
      `I did take down ${run.bossKills > 1 ? `${run.bossKills} carriers` : "a carrier"}, which I'll be mentioning at every opportunity.`,
      "Dropped a whole carrier. Then immediately forgot how legs work.",
    ])]);
  }
  if (run.flights > 0) {
    notes.push([4, pick("obs-flight", [
      "Got handed a flying car and drove it like a shopping trolley.",
      "I stole a hover car and crashed it, because I'm nothing if not consistent.",
    ])]);
  }
  if (run.kills >= 20) {
    notes.push([4, pick("obs-kills-high", [
      `${run.kills} drones down. The game's probably just letting me win, right?`,
      `Shot ${run.kills} drones. Missed roughly all the others.`,
    ])]);
  } else if (run.kills >= 6) {
    notes.push([2, pick("obs-kills", [
      `${run.kills} drones down. Mostly on purpose.`,
      `Got ${run.kills} drones. The rest were just being polite.`,
    ])]);
  } else if (run.kills === 0 && run.distance > 150) {
    notes.push([3, pick("obs-pacifist", [
      "Didn't shoot a single drone. I'm calling it a pacifist run. It was not a pacifist run.",
      "Zero drones down. I was holding the gun mostly as a fashion choice.",
    ])]);
  }
  if (run.nearMisses >= 5) {
    notes.push([3, pick("obs-near", [
      `${plural(run.nearMisses, "close call")}. That's not skill, that's panic with good timing.`,
      `I nearly died ${run.nearMisses} times before actually committing to it.`,
    ])]);
  }
  if (run.cleanDistance >= 500) {
    notes.push([3, `${m(run.cleanDistance)} without a scratch. Then I remembered I'm me.`]);
  }
  if (run.energy >= 60) {
    notes.push([2, pick("obs-energy", [
      `Grabbed ${run.energy} energy. I'll spend it on something I regret.`,
      `${run.energy} energy collected, which is more than I have in real life.`,
    ])]);
  }
  if (run.missionsDone > 0) {
    notes.push([3, `Somehow closed out ${plural(run.missionsDone, "order")} along the way. Someone be proud of me.`]);
  }
  if (run.distance < 150) {
    notes.push([6, pick("obs-short", [
      "That run was shorter than my attention span, which is saying something.",
      "The music hadn't even started. Neither had I, apparently.",
    ])]);
  }
  if (!notes.length) {
    notes.push([1, pick("obs-plain", [
      `${formatDuration(run.time)} of ${run.weather ? run.weather.toLowerCase() : "neon"} and concrete. I'd generously call it a jog.`,
      `I ran ${formatDuration(run.time)} through a city nobody alive has walked, and mostly looked at my feet.`,
    ])]);
  }
  notes.sort((a, b) => b[0] - a[0]);
  // Mostly the headline stat, sometimes the runner-up, so logs vary.
  const index = notes.length > 1 && Math.random() < 0.3 ? 1 : 0;
  return notes[index][1];
}

/** How this run sits in her history, plus the break around the game. */
function closer(run) {
  const hour = new Date().getHours();
  const lines = [];
  if (run.newBest) {
    lines.push(pick("close-best", [
      "New personal best! Nobody tell work how long this break has been.",
      "Furthest I've ever gone. Peak me. It's all downhill from here.",
      "A new record, which mostly proves how bad the old one was.",
    ]));
  } else if (run.best > 0 && run.score >= run.best * 0.85) {
    lines.push(pick("close-near", [
      `${Math.max(1, run.best - run.score)} points off my best. So close I can taste the disappointment.`,
      "Almost my record. Almost is kind of my brand.",
    ]));
  } else if (run.best > 0) {
    lines.push(pick("close-far", [
      `My best is ${run.best}. Whoever did that was much cooler than me.`,
      "Nowhere near my best. Past me is embarrassed for present me.",
    ]));
  }
  if (hour >= 0 && hour < 5 && Math.random() < 0.6) {
    lines.push(pick("close-late", [
      `It's past midnight in ${STORY.year}. This is the last one. (It is not the last one.)`,
      "It's very late. I'm fine. My eyes are fine. One more.",
    ]));
  } else if (run.runs >= 12) {
    lines.push(pick("close-runs", [
      `Run ${run.runs}. This break has become a lifestyle.`,
      `That was run ${run.runs}. I'm learning the game. Slowly. Painfully.`,
    ]));
  } else if (lines.length < 1 || Math.random() < 0.5) {
    lines.push(pick("close-generic", [
      "One more. Just one. I have said this before.",
      "I can hear the game laughing at me.",
      "Fine. Again. But this time with dignity.",
    ]));
  }
  return lines.join(" ");
}

/**
 * Game-over narration: headline + Anaiis's first-person session log.
 * @param {object} run  { distance, score, kills, cause, detail, sector, time,
 *   nearMisses, cleanDistance, energy, flights, bossKills, missionsDone,
 *   newBest, best, runs, daily, weather, dayLabel }
 * @returns {{ kicker: string, title: string[], log: string[], stamp: string, author: string }}
 */
export function narrateGameOver(input) {
  const run = { ...input, score: Math.floor(input.score ?? 0), best: Math.floor(input.best ?? 0), distance: Math.floor(input.distance ?? 0) };
  const clause = causeClause(run.cause, run.detail);
  const where = run.sector > 1 ? ` in sector ${run.sector}` : "";
  const opener = pick("open", [
    `Made it ${m(run.distance)} into Old Earth${where} before ${clause}.`,
    `${cap(m(run.distance))}${where}. Then ${clause}.`,
    `${formatDuration(run.time)} in, ${clause}. Final tally: ${m(run.distance)}.`,
  ]);
  const distance = `${String(run.distance).padStart(4, "0")}M`;
  const title = run.newBest ? ["RECORD", distance] : [pick("title", ["CAUGHT", "CAUGHT", "TAGGED", "FOUND HER"]), distance];
  const kicker = pick("kicker", ["IT'S OVER", "GAME OVER!", "YOU LOST"]);
  const stamp = `${run.daily ? "DAILY · " : ""}RUN ${String(run.runs).padStart(3, "0")} · ${(run.dayLabel ?? "NIGHT").toUpperCase()}${run.weather ? ` · ${run.weather.toUpperCase()}` : ""}`;
  return { kicker, title, log: [cap(opener), observation(run), closer(run)].filter(Boolean), stamp, author: NAME.toUpperCase() };
}

/** Start ticket: one line about where she stands before the next dive. */
export function narrateStart({ runs = 0, bestDistance = 0, best = 0 } = {}) {
  if (runs === 0) {
    return `First dive. ${NAME} has heard Old Earth was loud. She is about to find out how loud.`;
  }
  return pick("start", [
    bestDistance > 0 ? `Her furthest run so far is ${m(bestDistance)}. The game remembers the exact spot.` : null,
    best > 0 ? `${NAME}'s best stands at ${best}. The game is not worried. Yet.` : null,
    `${runs} ${runs === 1 ? "run" : "runs"} in. The drones have started recognising her silhouette.`,
    "The simulation keeps the street warm between her breaks.",
  ]);
}

/** Short third-person banners for in-run beats. */
export const NARRATOR = {
  dive: () => pick("dive", [`${NAME.toUpperCase()} DIVES IN`, `${NAME.toUpperCase()} IS IN`, "THE SIM HAS HER"]),
  again: () => pick("again", [`${NAME.toUpperCase()} GOES AGAIN`, "ONE MORE, SHE SAYS", "BACK IN THE LOOP"]),
  warmedUp: () => `${NAME.toUpperCase()} HAS THE BASICS`,
  pause: () => pick("pause", [
    `${NAME} stepped away from her break. The game holds the frame.`,
    "The sim is paused. Old Earth waits, mid-raindrop.",
    `${NAME} looked away. The drones politely freeze.`,
  ]),
};

export { cap };
