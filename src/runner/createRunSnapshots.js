/**
 * Random "photo mode" snapshots during a run.
 *
 * At random moments of a run the game asks for a capture; the render loop
 * copies the WebGPU canvas right after post.render() (same task, so the
 * swap-chain texture is still readable) into a small 2D canvas. A reservoir
 * keeps a uniform random sample of MAX_SHOTS frames; at game over one is
 * picked for the share-ready photo card (see ui/runner/shareCard.js).
 */

const MAX_SHOTS = 4;
const SHOT_MAX_WIDTH = 1280;
const FIRST_SHOT = [4, 12];
const SHOT_GAP = [7, 20];

function randomIn([min, max]) {
  return min + Math.random() * (max - min);
}

export function createRunSnapshots({ maxShots = MAX_SHOTS } = {}) {
  const shots = [];
  let seen = 0;
  let runTime = 0;
  let nextAt = randomIn(FIRST_SHOT);
  let pending = null;
  let chosen = null;

  /** New run: forget the previous run's frames. */
  function reset() {
    shots.length = 0;
    seen = 0;
    runTime = 0;
    nextAt = randomIn(FIRST_SHOT);
    pending = null;
    chosen = null;
  }

  /**
   * @param {number} delta  run-time delta (only while running)
   * @param {() => object} getMoment  caption data at capture time
   */
  function update(delta, getMoment) {
    runTime += delta;
    if (runTime >= nextAt && !pending) {
      pending = getMoment();
      nextAt = runTime + randomIn(SHOT_GAP);
    }
  }

  /** Force a capture on the next frame (e.g. the fatal moment of a short run). */
  function request(moment) {
    pending = moment;
  }

  /** Called by the render loop right after the frame is rendered. */
  function captureIfPending(sourceCanvas) {
    if (!pending || !sourceCanvas?.width) {
      return;
    }
    const moment = pending;
    pending = null;
    const scale = Math.min(1, SHOT_MAX_WIDTH / sourceCanvas.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sourceCanvas.width * scale);
    canvas.height = Math.round(sourceCanvas.height * scale);
    const ctx = canvas.getContext("2d");
    try {
      ctx.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
    } catch (error) {
      console.warn("[snapshot] Capture failed:", error);
      return;
    }
    const shot = { canvas, moment };
    // Reservoir sampling: every captured frame has the same chance to stay.
    seen += 1;
    if (shots.length < maxShots) {
      shots.push(shot);
    } else {
      const slot = Math.floor(Math.random() * seen);
      if (slot < maxShots) {
        shots[slot] = shot;
      }
    }
  }

  /** Pick a random shot for the game-over card (different one each call). */
  function pickRandom() {
    if (!shots.length) {
      chosen = null;
      return null;
    }
    const candidates = shots.length > 1 ? shots.filter((shot) => shot !== chosen) : shots;
    chosen = candidates[Math.floor(Math.random() * candidates.length)];
    return chosen;
  }

  return {
    reset,
    update,
    request,
    captureIfPending,
    pickRandom,
    getChosen: () => chosen,
    count: () => shots.length,
    wantsCapture: () => pending !== null,
  };
}
