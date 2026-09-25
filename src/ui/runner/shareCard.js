import { GAME_TITLE, GAME_TITLE_LINES, AUTHOR_NAME, AUTHOR_URL } from "../../app/credits.js";

/**
 * Draws the game-over ticket as a 1080×1350 PNG (score, distance, build,
 * date) and hands it to the Web Share API; falls back to a download.
 */
const W = 1080;
const H = 1350;
const C = {
  acid: "#d9ff3b",
  cobalt: "#3b5cf0",
  cobalt2: "#5d87f6",
  paper: "#e9ebee",
  ink: "#0c0e13",
  pink: "#ff4f74",
};

function notch(ctx, x, y, w, h, n) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w - n, y);
  ctx.lineTo(x + w, y + n);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + n, y + h);
  ctx.lineTo(x, y + h - n);
  ctx.closePath();
}

function dots(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  for (let py = y + 6; py < y + h; py += 18) {
    for (let px = x + 6; px < x + w; px += 18) {
      ctx.fillRect(px, py, 2, 2);
    }
  }
}

function barcode(ctx, x, y, w, h, seed) {
  let s = seed * 9301 + 49297;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  let px = x;
  ctx.fillStyle = C.ink;
  while (px < x + w) {
    const bw = rand() < 0.3 ? 6 : rand() < 0.6 ? 4 : 2;
    ctx.fillRect(px, y, bw, h);
    px += bw + (rand() < 0.5 ? 3 : 6);
  }
}

export async function drawShareCard({ score, distance, kills, cause, build = [], daily = false, rank = 1 }) {
  await document.fonts?.ready;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const display = (size) => `800 ${size}px "Barlow Condensed", sans-serif`;
  const mono = (size) => `700 ${size}px "JetBrains Mono", monospace`;

  ctx.fillStyle = C.ink;
  ctx.fillRect(0, 0, W, H);
  dots(ctx, 0, 0, W, H, "rgba(255,255,255,0.08)");

  // Main ticket body.
  notch(ctx, 60, 60, W - 120, 900, 40);
  ctx.fillStyle = C.cobalt;
  ctx.fill();
  ctx.save();
  ctx.clip();
  dots(ctx, 60, 60, W - 120, 900, "rgba(255,255,255,0.18)");
  ctx.fillStyle = C.cobalt2;
  ctx.fillRect(60, 640, W - 120, 320);
  ctx.restore();

  ctx.fillStyle = C.ink;
  ctx.font = mono(24);
  ctx.fillText(daily ? "DAILY RUN" : "RUN PASS", 100, 120);
  ctx.fillText(new Date().toISOString().slice(0, 10), 420, 120);
  ctx.fillText(`RANK ${rank}`, 760, 120);
  ctx.font = display(80);
  ctx.fillText("↘", 920, 140);

  // Result tag.
  notch(ctx, 100, 170, 460, 330, 28);
  ctx.fillStyle = C.acid;
  ctx.fill();
  ctx.fillStyle = C.pink;
  ctx.fillRect(100, 170, 460, 16);
  ctx.fillStyle = C.ink;
  ctx.font = mono(22);
  ctx.fillText("SCORE:", 128, 230);
  ctx.font = display(170);
  ctx.fillText(String(score).padStart(6, "0"), 120, 400);
  ctx.font = mono(22);
  ctx.fillText(cause.slice(0, 30), 128, 470);

  // Stat boxes.
  const stats = [
    ["DISTANCE", `${Math.floor(distance)}M`],
    ["DRONES DOWN", String(kills)],
  ];
  stats.forEach(([label, value], i) => {
    const y = 170 + i * 170;
    notch(ctx, 600, y, 380, 150, 18);
    ctx.fillStyle = "rgba(12,14,19,0.9)";
    ctx.fill();
    ctx.fillStyle = C.acid;
    ctx.font = mono(20);
    ctx.fillText(label, 626, y + 40);
    ctx.fillStyle = C.paper;
    ctx.font = display(88);
    ctx.fillText(value, 622, y + 128);
  });

  // Build chips.
  ctx.fillStyle = C.ink;
  ctx.font = mono(22);
  ctx.fillText("BUILD", 100, 560);
  let bx = 100;
  let by = 580;
  ctx.font = mono(22);
  for (const name of build.length ? build : ["STOCK"]) {
    const w = ctx.measureText(name).width + 28;
    if (bx + w > W - 100) {
      bx = 100;
      by += 50;
    }
    ctx.fillStyle = C.ink;
    ctx.fillRect(bx, by, w, 40);
    ctx.fillStyle = C.paper;
    ctx.fillText(name, bx + 14, by + 28);
    bx += w + 10;
  }

  ctx.fillStyle = C.ink;
  // Two-line lockup, shrunk to fit the ticket width.
  let titleSize = 120;
  ctx.font = display(titleSize);
  const widest = Math.max(...GAME_TITLE_LINES.map((line) => ctx.measureText(line).width));
  titleSize = Math.min(titleSize, Math.floor((titleSize * (W - 220)) / widest));
  ctx.font = display(titleSize);
  ctx.fillText(GAME_TITLE_LINES[0], 100, 900 - titleSize * 0.86);
  ctx.fillStyle = C.acid;
  ctx.fillText(GAME_TITLE_LINES[1], 100, 900);

  // Stub.
  notch(ctx, 60, 990, W - 120, 300, 30);
  ctx.fillStyle = C.acid;
  ctx.fill();
  ctx.setLineDash([14, 10]);
  ctx.lineWidth = 4;
  ctx.strokeStyle = C.ink;
  ctx.beginPath();
  ctx.moveTo(80, 990);
  ctx.lineTo(W - 80, 990);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = C.ink;
  ctx.font = display(64);
  ctx.fillText("CAN YOU BEAT IT?", 100, 1080);
  ctx.font = mono(22);
  ctx.fillText(`BY ${AUTHOR_NAME.toUpperCase()} · ${AUTHOR_URL.replace(/^https?:\/\//, "").replace(/\/$/, "").toUpperCase()}`, 100, 1120);
  barcode(ctx, 100, 1150, W - 200, 100, score % 97 + 5);

  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

/** Web Share API with the image attached; falls back to a download. */
export async function shareImage(blob, filename, text) {
  if (!blob) {
    return false;
  }
  const file = new File([blob], filename, { type: blob.type || "image/png" });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text, title: GAME_TITLE });
      return true;
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      return true;
    }
  }
  downloadBlob(blob, filename);
  return true;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function shareRun(stats) {
  const blob = await drawShareCard(stats);
  const text = `I scored ${stats.score} (${Math.floor(stats.distance)} m, ${stats.kills} drones) in ${GAME_TITLE}${stats.daily ? " — Daily Run" : ""}.`;
  return shareImage(blob, `low-gamma-redux-${stats.score}.png`, text);
}

/** Draws `source` into the box, cropped to cover it (like CSS object-fit). */
function drawCover(ctx, source, x, y, w, h) {
  const scale = Math.max(w / source.width, h / source.height);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(source, (source.width - sw) / 2, (source.height - sh) / 2, sw, sh, x, y, w, h);
}

/**
 * Photo card: a random in-run snapshot (createRunSnapshots) framed as a
 * 1080×1350 portrait post with the moment and the final result.
 * @param {{ canvas: HTMLCanvasElement, moment: object }} shot
 * @param {object} stats  final run stats (score, distance, kills, daily)
 */
export async function drawPhotoCard(shot, { score, distance, kills, daily = false }) {
  await document.fonts?.ready;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const display = (size) => `800 ${size}px "Barlow Condensed", sans-serif`;
  const mono = (size) => `700 ${size}px "JetBrains Mono", monospace`;
  const moment = shot.moment ?? {};

  ctx.fillStyle = C.ink;
  ctx.fillRect(0, 0, W, H);

  // Photo with a notched acid frame.
  const px = 40;
  const py = 40;
  const pw = W - 80;
  const ph = 1030;
  notch(ctx, px - 8, py - 8, pw + 16, ph + 16, 36);
  ctx.fillStyle = C.acid;
  ctx.fill();
  ctx.save();
  notch(ctx, px, py, pw, ph, 30);
  ctx.clip();
  drawCover(ctx, shot.canvas, px, py, pw, ph);
  // Scanline + vignette pass so it reads as a captured frame.
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  for (let sy = py; sy < py + ph; sy += 4) {
    ctx.fillRect(px, sy, pw, 1);
  }
  const vignette = ctx.createLinearGradient(0, py + ph - 260, 0, py + ph);
  vignette.addColorStop(0, "rgba(12,14,19,0)");
  vignette.addColorStop(1, "rgba(12,14,19,0.85)");
  ctx.fillStyle = vignette;
  ctx.fillRect(px, py + ph - 260, pw, 260);
  ctx.restore();

  // Top-left REC tag + timestamp.
  ctx.fillStyle = C.pink;
  ctx.beginPath();
  ctx.arc(px + 44, py + 50, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = C.paper;
  ctx.font = mono(24);
  ctx.fillText("REC", px + 66, py + 59);
  ctx.textAlign = "right";
  ctx.fillText(`${Math.floor(moment.distance ?? 0)} M · SECTOR ${moment.sector ?? 1}`, px + pw - 30, py + 59);
  ctx.textAlign = "left";

  // Moment caption over the vignette.
  ctx.fillStyle = C.acid;
  ctx.font = display(76);
  ctx.fillText(moment.label ?? "MID-RUN", px + 34, py + ph - 88);
  ctx.fillStyle = C.paper;
  ctx.font = mono(22);
  const detail = [
    moment.combo > 1 ? `x${moment.combo.toFixed(1)} COMBO` : null,
    `${moment.kills ?? 0} DRONES`,
    moment.weather ?? null,
    `${Math.round(moment.speed ?? 0)} KM/H`,
  ]
    .filter(Boolean)
    .join(" · ");
  ctx.fillText(detail, px + 38, py + ph - 42);

  // Result strip.
  const sy = py + ph + 40;
  ctx.fillStyle = C.paper;
  ctx.font = mono(22);
  ctx.fillText(daily ? "DAILY RUN · FINAL" : "FINAL", 60, sy + 26);
  ctx.font = display(120);
  ctx.fillStyle = C.acid;
  ctx.fillText(String(score).padStart(6, "0"), 54, sy + 142);
  ctx.textAlign = "right";
  ctx.fillStyle = C.paper;
  ctx.font = display(52);
  ctx.fillText(`${Math.floor(distance)} M · ${kills} DRONES`, W - 60, sy + 70);
  ctx.font = display(40);
  ctx.fillStyle = C.cobalt2;
  ctx.fillText(GAME_TITLE.toUpperCase(), W - 60, sy + 130);
  ctx.font = mono(18);
  ctx.fillStyle = "rgba(233,235,238,0.55)";
  ctx.fillText(AUTHOR_URL.replace(/^https?:\/\//, "").replace(/\/$/, "").toUpperCase(), W - 60, sy + 170);
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(233,235,238,0.55)";
  ctx.fillText(new Date().toISOString().slice(0, 10), 60, sy + 170);

  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

export async function sharePhoto(shot, stats) {
  const blob = await drawPhotoCard(shot, stats);
  const text = `Caught mid-run in ${GAME_TITLE}: ${stats.score} pts, ${Math.floor(stats.distance)} m.`;
  return shareImage(blob, `low-gamma-redux-photo-${stats.score}.png`, text);
}

export async function savePhoto(shot, stats) {
  const blob = await drawPhotoCard(shot, stats);
  if (blob) {
    downloadBlob(blob, `low-gamma-redux-photo-${stats.score}.png`);
  }
}
