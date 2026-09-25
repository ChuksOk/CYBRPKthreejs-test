import { GAME_TITLE, AUTHOR_NAME } from "../../app/credits.js";

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
  ctx.font = display(150);
  ctx.fillText(GAME_TITLE.toUpperCase(), 100, 900);

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
  ctx.fillText(`BY ${AUTHOR_NAME.toUpperCase()}`, 100, 1120);
  barcode(ctx, 100, 1150, W - 200, 100, score % 97 + 5);

  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

export async function shareRun(stats) {
  const blob = await drawShareCard(stats);
  if (!blob) {
    return false;
  }
  const file = new File([blob], `neon-run-${stats.score}.png`, { type: "image/png" });
  const text = `I scored ${stats.score} (${Math.floor(stats.distance)} m, ${stats.kills} drones) in ${GAME_TITLE}${stats.daily ? " — Daily Run" : ""}.`;
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
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}
