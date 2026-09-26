import { STORY } from "../app/credits.js";

/**
 * The narrator: LOW GAMMA itself, watching its one player. The person at the
 * keyboard plays *as* Anaiis, and Anaiis is playing LOW GAMMA on a break in
 * 2223, so the game always speaks about her in the third person: dry,
 * observant, a little proud of its drones, and quietly aware that the "Old
 * Earth" it renders is a costume.
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

/** How the run ended, as a clause that completes "… before ___". */
function causeClause(cause, detail) {
  switch (cause) {
    case "KAMIKAZE IMPACT":
      return pick("cause-kamikaze", [
        "a kamikaze drone traded itself for her run",
        "one of its drones stopped shooting and simply arrived",
        "a kamikaze drone decided the fastest route to her was through her",
      ]);
    case "HIT A PARKED CAR":
      return pick("cause-car", [
        "a parked car, faithfully rendered down to the rust, refused to move",
        "she met a parked car at full sprint. The car won on seniority",
        "Old Earth's love of parking on the street finally caught up with her",
      ]);
    case "CLOTHESLINED":
      return pick("cause-beam", [
        "a steel beam arrived at exactly neck height",
        "she chose not to slide, and the beam chose not to negotiate",
        "a hanging beam taught her the S key the hard way",
      ]);
    case "TRIPPED A BARRIER":
      return pick("cause-barrier", [
        "a barrier caught her trailing foot",
        "she misjudged one barrier by a few centimetres. The sim measures in centimetres",
        "a concrete barrier ended the conversation",
      ]);
    default: {
      const source = (detail ?? "").split(" · ")[0];
      const gunship = /GUNSHIP|CARRIER/i.test(source);
      return pick("cause-shot", [
        gunship ? "a gunship finally found the range" : "a drone bolt found the one gap in her footwork",
        "its drones finally agreed on where she was going to be",
        "one bolt too many landed",
        gunship ? "the heavy drones stopped being polite" : "the swarm closed the last open lane",
      ]);
    }
  }
}

/** One observation about how she played, from the most notable stat. */
function observation(run) {
  const notes = [];
  if (run.bossKills > 0) {
    notes.push([5, pick("obs-boss", [
      `She brought down ${run.bossKills > 1 ? `${run.bossKills} carriers` : "a carrier"}, the heaviest argument the game knows how to make.`,
      "She dropped a carrier out of the sky. The game has filed that away.",
    ])]);
  }
  if (run.flights > 0) {
    notes.push([4, pick("obs-flight", [
      "At one point she commandeered a hover car and took the fight to the rooftops. The game allowed it, briefly.",
      "She even stole a Quadra and flew it through the canyon. Somewhere a physics engineer smiled.",
    ])]);
  }
  if (run.kills >= 20) {
    notes.push([4, pick("obs-kills-high", [
      `${run.kills} of its drones went down along the way. The game is starting to send them in pairs.`,
      `She dropped ${run.kills} drones. The game is taking notes, and it takes very good notes.`,
    ])]);
  } else if (run.kills >= 6) {
    notes.push([2, pick("obs-kills", [
      `She downed ${run.kills} drones on the way, each one a small, satisfying objection.`,
      `${run.kills} drones down. Not a massacre. A statement.`,
    ])]);
  } else if (run.kills === 0 && run.distance > 150) {
    notes.push([3, pick("obs-pacifist", [
      "She never fired at a single drone. Pacifism, or a very focused break.",
      "Not one drone shot down. She came here to run, apparently.",
    ])]);
  }
  if (run.nearMisses >= 5) {
    notes.push([3, pick("obs-near", [
      `${plural(run.nearMisses, "close call")}. She treats the edge of a lane as a suggestion.`,
      `She shaved past danger ${run.nearMisses} times. The game counted every one.`,
    ])]);
  }
  if (run.cleanDistance >= 500) {
    notes.push([3, `For ${m(run.cleanDistance)} straight, nothing so much as grazed her.`]);
  }
  if (run.energy >= 60) {
    notes.push([2, pick("obs-energy", [
      `She pocketed ${run.energy} energy on the way, and has plans for it.`,
      `${run.energy} energy collected. The Armory will be hearing from her.`,
    ])]);
  }
  if (run.missionsDone > 0) {
    notes.push([3, `She also closed out ${plural(run.missionsDone, "order")} the game had left lying around for her.`]);
  }
  if (run.distance < 150) {
    notes.push([6, pick("obs-short", [
      "It was over before the first song found its chorus.",
      "The sim had barely finished loading the street.",
    ])]);
  }
  if (!notes.length) {
    notes.push([1, pick("obs-plain", [
      `${formatDuration(run.time)} of ${run.weather ? run.weather.toLowerCase() : "neon"} and concrete, and she kept her feet for most of it.`,
      `She ran ${formatDuration(run.time)} through a city nobody alive has ever walked.`,
    ])]);
  }
  notes.sort((a, b) => b[0] - a[0]);
  // Mostly the headline stat, sometimes the runner-up, so logs vary.
  const index = notes.length > 1 && Math.random() < 0.3 ? 1 : 0;
  return notes[index][1];
}

/** How this run sits in her history, plus the frame around the frame. */
function closer(run) {
  const hour = new Date().getHours();
  const lines = [];
  if (run.newBest) {
    lines.push(pick("close-best", [
      "That is further than she has ever gone. The game quietly adjusts its difficulty curve.",
      `A new personal best. Somewhere in ${STORY.year}, a short break is getting longer.`,
      "New record. The game will remember that she can do this.",
    ]));
  } else if (run.best > 0 && run.score >= run.best * 0.85) {
    lines.push(pick("close-near", [
      `${Math.max(1, run.best - run.score)} points short of her best. She knows exactly where it slipped.`,
      "Close to her record. Close enough to make the next run inevitable.",
    ]));
  } else if (run.best > 0) {
    lines.push(pick("close-far", [
      `Her best still stands at ${run.best}. The game likes its odds.`,
      "Not her best. The game has seen her best, and it is keeping an eye out for it.",
    ]));
  }
  if (hour >= 0 && hour < 5 && Math.random() < 0.6) {
    lines.push(pick("close-late", [
      `It is past midnight in ${STORY.year}. She will say this is the last one.`,
      "It is very late. The break has quietly become the evening.",
    ]));
  } else if (run.runs >= 12) {
    lines.push(pick("close-runs", [
      `That was run ${run.runs}. The break has stopped being a break.`,
      `Run ${run.runs}. She is learning the game, and it is learning her.`,
    ]));
  } else if (lines.length < 1 || Math.random() < 0.5) {
    lines.push(pick("close-generic", [
      "The game resets the street and waits. It is good at waiting.",
      `Old Earth folds back into its loop. ${NAME} is already reaching for restart.`,
      "The sim holds her place at the start line.",
    ]));
  }
  return lines.join(" ");
}

/**
 * Game-over narration.
 * @param {object} run  { distance, score, kills, cause, detail, sector, time,
 *   nearMisses, cleanDistance, energy, flights, bossKills, missionsDone,
 *   newBest, best, runs, daily, weather, dayLabel }
 * @returns {{ kicker: string, title: string[], log: string[], stamp: string }}
 */
export function narrateGameOver(input) {
  const run = { ...input, score: Math.floor(input.score ?? 0), best: Math.floor(input.best ?? 0), distance: Math.floor(input.distance ?? 0) };
  const clause = causeClause(run.cause, run.detail);
  const where = run.sector > 1 ? ` in sector ${run.sector}` : "";
  const opener = pick("open", [
    `${NAME} made it ${m(run.distance)} into Old Earth${where} before ${clause}.`,
    `${m(run.distance)}. That is how far ${NAME} got${where} before ${clause}.`,
    `${run.sector > 1 ? `Sector ${run.sector}, ` : ""}${formatDuration(run.time)} in: ${clause}. ${NAME} logged ${m(run.distance)}.`,
  ]);
  const title = run.newBest
    ? ["RECORD", `${String(Math.floor(run.distance)).padStart(4, "0")}M`]
    : [pick("title", ["CAUGHT", "CAUGHT", "TAGGED", "FOUND HER"]), `${String(Math.floor(run.distance)).padStart(4, "0")}M`];
  const kicker = run.newBest
    ? `THE GAME CAUGHT ${NAME.toUpperCase()}, EVENTUALLY`
    : pick("kicker", [
        `THE GAME CAUGHT ${NAME.toUpperCase()} AT`,
        `${NAME.toUpperCase()} WAS CAUGHT AT`,
        `LOW GAMMA CAUGHT UP WITH HER AT`,
      ]);
  const stamp = `${run.daily ? "DAILY · " : ""}RUN ${String(run.runs).padStart(3, "0")} · ${(run.dayLabel ?? "NIGHT").toUpperCase()}${run.weather ? ` · ${run.weather.toUpperCase()}` : ""}`;
  return { kicker, title, log: [opener, observation(run), closer(run)].filter(Boolean), stamp };
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
