import * as THREE from "three/webgpu";
import { VIEWMODEL_LAYER } from "../runner/runnerConfig.js";

/**
 * In-run VR HUD: the flat HUD's cards (score ticket, orders, vitals, ammo +
 * special, weapon chips, Sky Run hull, carrier bar, banner, prompt, toasts,
 * mission stamp, now playing) re-painted natively on small canvases.
 *
 * - Values are read straight from the live flat HUD DOM (text, classes, bar
 *   transforms) — the exact strings the flat game shows, no layout reads —
 *   so the VR HUD never drifts from the flat one.
 * - The look follows src/ui/runner/runnerHud.css: acid / cobalt / paper /
 *   ink / pink, notched corners, dot grids, barcodes, Barlow Condensed
 *   numerals + JetBrains Mono labels.
 * - A card repaints only when its values change (≤ 10 Hz), so a run costs a
 *   few small texture uploads per second instead of DOM rasterization.
 *
 * Cards are body-locked on an arc around the head, grouped like the flat
 * screen corners but pulled in to ±30° so nothing sits in the periphery.
 */

const ACID = "#d9ff3b";
const COBALT = "#3b5cf0";
const COBALT_2 = "#5d87f6";
const PAPER = "#e9ebee";
const PAPER_2 = "#cfd3d9";
const INK = "#0c0e13";
const GREY = "#8b919c";
const PINK = "#ff4f74";
const CYAN = "#2ff0ff";
const READY = "#5dff3a";
const DISPLAY = "'Barlow Condensed', 'Orbitron', sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";

/** Canvas pixels per CSS px (sharpness in the headset). */
const DENSITY = 3;
/** Metres per CSS px on the arc. */
const METRES_PER_PX = 0.0019;
const ARC_RADIUS = 1.6;
const EYE_Y = 1.55;
const REPAINT_INTERVAL = 0.1;

// ── Small helpers ─────────────────────────────────────────────────────────
const text = (root, selector) => root?.querySelector(selector)?.textContent?.trim() ?? "";
const has = (root, selector, className) => Boolean(root?.querySelector(selector)?.classList.contains(className));
function scaleX(element) {
  const match = /scaleX\(\s*([-\d.e]+)/.exec(element?.style?.transform ?? "");
  return match ? THREE.MathUtils.clamp(Number(match[1]), 0, 1) : 0;
}

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

const dotPatterns = new Map();
function dots(ctx, color) {
  if (!dotPatterns.has(color)) {
    const tile = document.createElement("canvas");
    tile.width = 9 * DENSITY;
    tile.height = 9 * DENSITY;
    const t = tile.getContext("2d");
    t.fillStyle = color;
    t.beginPath();
    t.arc(DENSITY, DENSITY, DENSITY * 1.05, 0, Math.PI * 2);
    t.fill();
    dotPatterns.set(color, tile);
  }
  return ctx.createPattern(dotPatterns.get(color), "repeat");
}

function label(ctx, value, x, y, { size = 9, weight = 700, color = INK, align = "left", font = MONO, spacing = 0.14 } = {}) {
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  if ("letterSpacing" in ctx) {
    ctx.letterSpacing = `${(spacing * size).toFixed(2)}px`;
  }
  ctx.fillText(String(value).toUpperCase(), x, y);
  if ("letterSpacing" in ctx) {
    ctx.letterSpacing = "0px";
  }
}

function barcode(ctx, x, y, w, h, seed = 7, color = INK) {
  ctx.fillStyle = color;
  let cx = x;
  let s = seed;
  while (cx < x + w) {
    s = (s * 9301 + 49297) % 233280;
    const bar = 1 + (s % 3);
    const gap = 1 + ((s >> 3) % 2);
    ctx.fillRect(cx, y, bar, h);
    cx += bar + gap;
  }
}

function segmentedBar(ctx, x, y, w, h, t, color) {
  for (let sx = 0; sx < w; sx += 10) {
    const segW = Math.min(8, w - sx);
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(x + sx, y, segW, h);
    const filled = THREE.MathUtils.clamp((t * w - sx) / segW, 0, 1);
    if (filled > 0) {
      ctx.fillStyle = color;
      ctx.fillRect(x + sx, y, segW * filled, h);
    }
  }
}

// ── Card painters: read(root) → data, draw(ctx, data) at CSS px scale ─────
const CARDS = [
  {
    id: "ticket",
    size: [250, 152],
    place: { yaw: 27, y: 0.2 },
    read(root) {
      const card = root.querySelector(".rh-ticket");
      if (!card) {
        return null;
      }
      const strip = Array.from(card.querySelectorAll(".t-strip span"), (node) => node.textContent.trim());
      return {
        strip,
        score: text(card, ".rh-score-value"),
        dist: text(card, ".rh-dist"),
        speed: text(card, ".rh-speed"),
        combo: text(card, ".rh-combo"),
        hot: has(card, ".t-combo", "is-hot"),
        code: text(card, ".t-code"),
      };
    },
    draw(ctx, d, [w, h]) {
      notch(ctx, 0, 0, w, h, 14);
      ctx.clip();
      ctx.fillStyle = ACID;
      ctx.fillRect(0, 0, w, h);
      // Strip
      ctx.fillStyle = COBALT;
      ctx.fillRect(0, 0, w, 20);
      ctx.fillStyle = PINK;
      ctx.fillRect(0, 20, w, 3);
      const [a = "", b = "", c = ""] = d.strip;
      label(ctx, a, 12, 14, { color: PAPER, spacing: 0.16 });
      label(ctx, b, w / 2, 14, { color: PAPER, align: "center", spacing: 0.16 });
      label(ctx, c, w - 12, 14, { color: PAPER, align: "right", spacing: 0.16 });
      // Body
      ctx.fillStyle = dots(ctx, "rgba(12,14,19,0.28)");
      ctx.fillRect(0, 23, w, 94);
      label(ctx, "SCORE:", 12, 36);
      label(ctx, d.score, 10, 82, { font: DISPLAY, weight: 800, size: 50, spacing: 0.01 });
      ctx.fillStyle = INK;
      ctx.fillRect(12, 87, w - 24, 1.5);
      const cols = [
        ["DIST.", d.dist, "M"],
        ["SPEED", d.speed, "KM/H"],
        ["COMBO", d.combo, ""],
      ];
      const colW = (w - 24) / 3;
      cols.forEach(([name, value, unit], i) => {
        const x = 12 + i * colW + (i ? 7 : 0);
        if (i) {
          ctx.fillStyle = "rgba(12,14,19,0.35)";
          ctx.fillRect(12 + i * colW, 91, 1, 24);
        }
        label(ctx, name, x, 99, { size: 8 });
        label(ctx, value, x, 115, { font: DISPLAY, weight: 800, size: 20, spacing: 0, color: i === 2 && d.hot ? PINK : INK });
        if (unit) {
          ctx.globalAlpha = 0.7;
          label(ctx, unit, x + ctx.measureText(value).width + 3, 115, { size: 7 });
          ctx.globalAlpha = 1;
        }
      });
      // Stub
      ctx.fillStyle = PAPER;
      ctx.fillRect(0, 120, w, h - 120);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(0, 120.75);
      ctx.lineTo(w, 120.75);
      ctx.stroke();
      ctx.setLineDash([]);
      barcode(ctx, 12, 127, 92, 18, 11);
      label(ctx, d.code, 114, 141, { spacing: 0.2 });
    },
  },
  {
    id: "orders",
    size: [250, 150],
    place: { yaw: 29, y: -0.1 },
    read(root) {
      const card = root.querySelector(".rh-orders");
      if (!card?.classList.contains("has-missions")) {
        return null;
      }
      return {
        head: text(card, ".o-head .t-meta"),
        count: text(card, ".o-count"),
        rows: Array.from(card.querySelectorAll(".o-row"), (row) => ({
          text: text(row, ".o-text"),
          num: text(row, ".o-num"),
          bar: scaleX(row.querySelector(".o-bar i")),
          done: row.classList.contains("is-done"),
          near: row.classList.contains("is-near"),
        })).slice(0, 3),
      };
    },
    draw(ctx, d, [w, h]) {
      notch(ctx, 0, 0, w, h, 8);
      ctx.clip();
      ctx.fillStyle = "rgba(12,14,19,0.86)";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = ACID;
      ctx.fillRect(0, 0, 4, h);
      label(ctx, d.head || "ORDERS //", 14, 18, { color: ACID });
      label(ctx, d.count, w - 10, 20, { font: DISPLAY, weight: 800, size: 16, spacing: 0.04, color: ACID, align: "right" });
      d.rows.forEach((row, i) => {
        const y = 30 + i * 38;
        ctx.save();
        ctx.translate(20, y + 9);
        ctx.rotate(Math.PI / 4);
        ctx.strokeStyle = row.done ? ACID : row.near ? PINK : GREY;
        ctx.lineWidth = 2;
        if (row.done || row.near) {
          ctx.fillStyle = row.done ? ACID : PINK;
          ctx.fillRect(-4, -4, 8, 8);
        } else {
          ctx.strokeRect(-4, -4, 8, 8);
        }
        ctx.restore();
        ctx.font = `600 15px ${DISPLAY}`;
        let t = row.text.toUpperCase();
        while (ctx.measureText(t).width > w - 100 && t.length > 4) {
          t = `${t.slice(0, -2)}…`;
        }
        label(ctx, t, 33, y + 14, { font: DISPLAY, weight: 600, size: 15, spacing: 0.02, color: PAPER });
        label(ctx, row.num, w - 10, y + 14, { size: 11, color: PAPER_2, align: "right", spacing: 0 });
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.fillRect(33, y + 21, w - 43, 4);
        ctx.fillStyle = row.done ? ACID : row.near ? PINK : COBALT_2;
        ctx.fillRect(33, y + 21, (w - 43) * row.bar, 4);
      });
    },
  },
  {
    id: "vitals",
    size: [290, 76],
    place: { yaw: 22, y: -0.4 },
    read(root) {
      const card = root.querySelector(".rh-vitals");
      if (!card) {
        return null;
      }
      return {
        head: Array.from(card.querySelectorAll(".v-head span"), (node) => node.textContent.trim()),
        shield: text(card, ".rh-shield-num"),
        health: text(card, ".rh-health-num"),
        shieldT: scaleX(card.querySelector(".v-bar.shield i")),
        healthT: scaleX(card.querySelector(".v-bar.health i")),
        critical: card.classList.contains("is-critical"),
      };
    },
    draw(ctx, d, [w, h]) {
      notch(ctx, 0, 0, w, h, 14);
      ctx.clip();
      ctx.fillStyle = d.critical ? "#2a0f16" : INK;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = dots(ctx, "rgba(255,255,255,0.22)");
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = d.critical ? PINK : ACID;
      ctx.fillRect(0, 0, 5, h);
      const [a = "", b = ""] = d.head;
      label(ctx, a, 17, 18, { color: GREY });
      label(ctx, b, w - 12, 18, { color: GREY, align: "right" });
      const rows = [
        ["SHIELD", d.shieldT, d.shield, COBALT_2],
        ["INTEGRITY", d.healthT, d.health, d.critical ? PINK : ACID],
      ];
      rows.forEach(([name, t, value, color], i) => {
        const y = 38 + i * 23;
        label(ctx, name, 17, y + 5, { font: DISPLAY, weight: 600, size: 14, spacing: 0.08, color: PAPER });
        segmentedBar(ctx, 101, y - 6, w - 101 - 58, 12, t, color);
        label(ctx, value, w - 12, y + 6, { font: DISPLAY, weight: 800, size: 18, spacing: 0, color: PAPER, align: "right" });
      });
    },
  },
  {
    id: "chips",
    size: [212, 40],
    place: { yaw: -24, y: -0.16 },
    read(root) {
      const chips = Array.from(root.querySelectorAll(".rh-chip"), (chip) => ({
        n: text(chip, "b"),
        code: text(chip, "span"),
        name: text(chip, "em"),
        active: chip.classList.contains("is-active"),
        locked: chip.classList.contains("is-locked"),
      }));
      return chips.length ? { chips } : null;
    },
    draw(ctx, d, [w, h]) {
      const chipW = (w - 4 * (d.chips.length - 1)) / d.chips.length;
      d.chips.forEach((chip, i) => {
        const x = i * (chipW + 4);
        ctx.save();
        notch(ctx, x, 0, chipW, h, 8);
        ctx.clip();
        ctx.globalAlpha = chip.active ? 1 : 0.72;
        ctx.fillStyle = chip.active ? ACID : "rgba(12,14,19,0.82)";
        ctx.fillRect(x, 0, chipW, h);
        if (chip.active) {
          ctx.fillStyle = PINK;
          ctx.fillRect(x, 0, chipW, 3);
        }
        const color = chip.active ? INK : PAPER;
        label(ctx, chip.locked ? `${chip.n} ⌧` : chip.n, x + 6, 20, { font: DISPLAY, weight: 800, size: 16, spacing: 0, color });
        label(ctx, chip.code, x + 6, 30, { size: 8, spacing: 0.08, color });
        ctx.globalAlpha *= 0.7;
        label(ctx, chip.name, x + 6, 38, { size: 7, spacing: 0.1, color });
        ctx.restore();
      });
    },
  },
  {
    id: "ammo",
    size: [210, 132],
    place: { yaw: -21, y: -0.38 },
    read(root) {
      const card = root.querySelector(".rh-ammo");
      if (!card) {
        return null;
      }
      const ticks = card.querySelectorAll(".a-mag i");
      return {
        name: text(card, ".rh-weapon-name"),
        code: text(card, ".rh-weapon-code"),
        ammo: text(card, ".rh-ammo-num"),
        mag: text(card, ".rh-mag"),
        status: text(card, ".rh-ammo-status"),
        low: card.classList.contains("is-low"),
        overclock: card.classList.contains("is-overclock"),
        ticks: ticks.length,
        on: card.querySelectorAll(".a-mag i.on").length,
        reload: scaleX(card.querySelector(".a-reload i")),
        special: text(card, ".a-special-name"),
        specialT: scaleX(card.querySelector(".a-special-bar i")),
        ready: has(card, ".a-special", "is-ready"),
        key: text(card, ".a-special-key"),
      };
    },
    draw(ctx, d, [w, h]) {
      notch(ctx, 0, 0, w, h, 14);
      ctx.clip();
      const body = d.overclock ? ACID : PAPER;
      ctx.fillStyle = body;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = INK;
      ctx.fillRect(0, 0, w, 20);
      label(ctx, d.name, 12, 14, { color: ACID, spacing: 0.18 });
      label(ctx, d.code, w - 12, 14, { color: ACID, align: "right", spacing: 0.18 });
      ctx.fillStyle = dots(ctx, "rgba(12,14,19,0.28)");
      ctx.fillRect(0, 20, w, 56);
      label(ctx, d.ammo, 10, 70, { font: DISPLAY, weight: 800, size: 54, spacing: 0 });
      ctx.font = `800 54px ${DISPLAY}`;
      const ammoW = ctx.measureText(d.ammo).width;
      label(ctx, d.mag, 14 + ammoW, 70, { font: DISPLAY, weight: 600, size: 18, spacing: 0, color: GREY });
      ctx.font = `700 9px ${MONO}`;
      const statusW = ctx.measureText(d.status).width + 14;
      ctx.fillStyle = d.overclock ? COBALT : d.low ? PINK : INK;
      ctx.fillRect(w - 12 - statusW, 52, statusW, 14);
      label(ctx, d.status, w - 12 - statusW / 2, 62, { color: PAPER, align: "center" });
      // Magazine ticks
      const count = Math.max(1, d.ticks);
      const tickW = (w - 24 - 2 * (count - 1)) / count;
      for (let i = 0; i < count; i++) {
        ctx.fillStyle = i < d.on ? INK : "rgba(12,14,19,0.15)";
        ctx.fillRect(12 + i * (tickW + 2), 82, tickW, 9);
      }
      ctx.fillStyle = "rgba(12,14,19,0.1)";
      ctx.fillRect(12, 95, w - 24, 4);
      ctx.fillStyle = PINK;
      ctx.fillRect(12, 95, (w - 24) * d.reload, 4);
      // Special
      label(ctx, d.special, 12, 116, {});
      ctx.font = `700 9px ${MONO}`;
      const nameW = ctx.measureText(d.special).width + 18;
      const keyW = ctx.measureText(d.key).width + 8;
      const barX = 12 + nameW;
      const barW = w - 12 - keyW - 6 - barX;
      ctx.fillStyle = "rgba(12,14,19,0.12)";
      ctx.fillRect(barX, 110, barW, 5);
      ctx.fillStyle = d.ready ? READY : COBALT;
      ctx.fillRect(barX, 110, barW * d.specialT, 5);
      ctx.fillStyle = d.ready ? READY : INK;
      ctx.fillRect(w - 12 - keyW, 106, keyW, 13);
      label(ctx, d.key, w - 12 - keyW / 2, 116, { color: d.ready ? INK : PAPER, align: "center", spacing: 0 });
    },
  },
  {
    id: "flight",
    size: [360, 58],
    place: { yaw: 0, y: -0.5 },
    read(root) {
      const card = root.querySelector(".rh-flight");
      if (!card?.classList.contains("is-visible")) {
        return null;
      }
      return {
        head: text(card, ".fl-head .t-meta"),
        mark: text(card, ".fl-mark"),
        mult: text(card, ".fl-mult"),
        time: text(card, ".fl-time"),
        hull: scaleX(card.querySelector(".fl-bar i")),
        num: text(card, ".fl-num"),
        low: card.classList.contains("is-low"),
      };
    },
    draw(ctx, d, [w, h]) {
      notch(ctx, 0, 0, w, h, 8);
      ctx.clip();
      ctx.fillStyle = "rgba(12,14,19,0.86)";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = CYAN;
      ctx.fillRect(0, 0, 3, h);
      label(ctx, d.head, 12, 17, { color: CYAN });
      ctx.font = `700 9px ${MONO}`;
      const headW = ctx.measureText(d.head).width + 8;
      label(ctx, d.mark, 12 + headW, 17, { color: ACID });
      const markW = ctx.measureText(d.mark).width + 8;
      ctx.font = `800 14px ${DISPLAY}`;
      const multW = ctx.measureText(d.mult).width + 10;
      ctx.fillStyle = ACID;
      ctx.fillRect(12 + headW + markW, 6, multW, 15);
      label(ctx, d.mult, 17 + headW + markW, 18, { font: DISPLAY, weight: 800, size: 14, spacing: 0 });
      label(ctx, d.time, w - 12, 17, { color: GREY, align: "right" });
      ctx.fillStyle = "rgba(255,255,255,0.1)";
      ctx.fillRect(12, 26, w - 24, 9);
      if (d.low) {
        ctx.fillStyle = PINK;
      } else {
        const gradient = ctx.createLinearGradient(12, 0, w - 12, 0);
        gradient.addColorStop(0, CYAN);
        gradient.addColorStop(1, ACID);
        ctx.fillStyle = gradient;
      }
      ctx.fillRect(12, 26, (w - 24) * d.hull, 9);
      label(ctx, "HULL", 12, 50, { color: PAPER });
      label(ctx, d.num, w - 12, 52, { font: DISPLAY, weight: 800, size: 20, spacing: 0, color: PAPER, align: "right" });
    },
  },
  {
    id: "boss",
    size: [420, 42],
    place: { yaw: 0, y: 0.46 },
    read(root) {
      const card = root.querySelector(".rh-boss");
      if (!card?.classList.contains("is-on")) {
        return null;
      }
      return {
        head: Array.from(card.querySelectorAll(".rb-head span"), (node) => node.textContent.trim()),
        hp: scaleX(card.querySelector(".rb-bar i")),
        open: card.classList.contains("is-open"),
      };
    },
    draw(ctx, d, [w, h]) {
      notch(ctx, 0, 0, w, h, 8);
      ctx.clip();
      ctx.fillStyle = "rgba(12,14,19,0.86)";
      ctx.fillRect(0, 0, w, h);
      const [a = "", b = ""] = d.head;
      label(ctx, a, 10, 17, { color: PAPER });
      label(ctx, b, w - 10, 17, { color: d.open ? ACID : PAPER, align: "right" });
      ctx.fillStyle = "rgba(233,235,238,0.12)";
      ctx.fillRect(10, 24, w - 20, 10);
      ctx.fillStyle = d.open ? ACID : "#e040fb";
      ctx.fillRect(10, 24, (w - 20) * d.hp, 10);
    },
  },
  {
    id: "banner",
    size: [420, 48],
    place: { yaw: 0, y: 0.3 },
    read(root) {
      const card = root.querySelector(".rh-banner");
      if (!card?.classList.contains("is-on")) {
        return null;
      }
      return { text: text(card, ".b-text"), code: text(card, ".b-code") };
    },
    draw(ctx, d, [w, h]) {
      ctx.font = `800 36px ${DISPLAY}`;
      const textW = ctx.measureText(d.text.toUpperCase()).width + 24 + d.text.length * 2;
      ctx.font = `700 9px ${MONO}`;
      const codeW = ctx.measureText(d.code).width + 24;
      const total = 44 + textW + codeW;
      const x0 = (w - total) / 2;
      ctx.save();
      notch(ctx, x0, 0, total, h, 8);
      ctx.clip();
      ctx.fillStyle = INK;
      ctx.fillRect(x0, 0, 44, h);
      label(ctx, "→", x0 + 22, 34, { font: DISPLAY, weight: 800, size: 26, spacing: 0, color: ACID, align: "center" });
      ctx.fillStyle = ACID;
      ctx.fillRect(x0 + 44, 0, textW, h);
      label(ctx, d.text, x0 + 56, 37, { font: DISPLAY, weight: 800, size: 36, spacing: 0.06 });
      ctx.fillStyle = COBALT;
      ctx.fillRect(x0 + 44 + textW, 0, codeW, h);
      label(ctx, d.code, x0 + 44 + textW + 12, 28, { color: PAPER });
      ctx.restore();
    },
  },
  {
    id: "toasts",
    size: [420, 96],
    place: { yaw: 0, y: 0.13 },
    read(root) {
      const toasts = Array.from(root.querySelectorAll(".rh-toast:not(.is-out)"), (node) => ({
        meta: text(node, ".t-meta"),
        text: text(node, "b"),
      })).slice(-3);
      const stamp = root.querySelector(".rh-mission.is-on");
      if (stamp) {
        toasts.unshift({ meta: text(stamp, ".rm-label"), text: `${text(stamp, ".rm-title")} · ${text(stamp, ".rm-text")}` });
      }
      return toasts.length ? { toasts: toasts.slice(0, 3) } : null;
    },
    draw(ctx, d, [w]) {
      d.toasts.forEach((toast, i) => {
        ctx.font = `700 9px ${MONO}`;
        const metaW = ctx.measureText(toast.meta).width;
        ctx.font = `800 18px ${DISPLAY}`;
        let t = toast.text;
        while (ctx.measureText(t).width > w - metaW - 50 && t.length > 4) {
          t = `${t.slice(0, -2)}…`;
        }
        const tw = metaW + ctx.measureText(t).width + 38;
        const x = (w - tw) / 2;
        const y = i * 32;
        ctx.save();
        notch(ctx, x, y, tw, 28, 8);
        ctx.clip();
        ctx.fillStyle = ACID;
        ctx.fillRect(x, y, tw, 28);
        label(ctx, toast.meta, x + 14, y + 18, {});
        label(ctx, t, x + 24 + metaW, y + 20, { font: DISPLAY, weight: 800, size: 18, spacing: 0 });
        ctx.restore();
      });
    },
  },
  {
    id: "prompt",
    size: [460, 52],
    place: { yaw: 0, y: -0.3 },
    read(root) {
      const card = root.querySelector(".rh-prompt");
      if (!card?.classList.contains("is-on")) {
        return null;
      }
      return { meta: text(card, ".t-meta"), text: text(card, "b") };
    },
    draw(ctx, d, [w, h]) {
      ctx.font = `800 26px ${DISPLAY}`;
      const tw = Math.min(w, ctx.measureText(d.text.toUpperCase()).width + 32 + d.text.length * 1.6);
      const x = (w - tw) / 2;
      notch(ctx, x, 0, tw, h, 8);
      ctx.clip();
      ctx.fillStyle = ACID;
      ctx.fillRect(x, 0, tw, h);
      label(ctx, d.meta, w / 2, 17, { align: "center" });
      label(ctx, d.text, w / 2, 43, { font: DISPLAY, weight: 800, size: 26, spacing: 0.06, align: "center" });
    },
  },
  {
    id: "music",
    size: [250, 44],
    place: { yaw: 27, y: 0.43 },
    read(root) {
      const card = root.querySelector(".rh-music");
      if (!card?.classList.contains("is-visible")) {
        return null;
      }
      return { state: text(card, ".rmu-state"), title: text(card, ".rmu-title"), progress: scaleX(card.querySelector(".rmu-progress i")) };
    },
    draw(ctx, d, [w, h]) {
      notch(ctx, 0, 0, w, h, 8);
      ctx.clip();
      ctx.fillStyle = "rgba(12,14,19,0.86)";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = ACID;
      ctx.fillRect(0, 0, 4, h);
      label(ctx, `♪ ${d.state}`, 14, 16, { color: ACID });
      ctx.font = `800 17px ${DISPLAY}`;
      let t = d.title.toUpperCase();
      while (ctx.measureText(t).width > w - 28 && t.length > 4) {
        t = `${t.slice(0, -2)}…`;
      }
      label(ctx, t, 14, 35, { font: DISPLAY, weight: 800, size: 17, spacing: 0, color: PAPER });
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.fillRect(14, h - 5, w - 28, 2);
      ctx.fillStyle = ACID;
      ctx.fillRect(14, h - 5, (w - 28) * d.progress, 2);
    },
  },
];

export function createXRHudCards({ domHud }) {
  const group = new THREE.Group();
  group.name = "xr-hud-cards";
  group.visible = false;

  // Web fonts must be loaded before the first paint (canvas won't wait).
  const fontsReady = Promise.all(
    [`800 50px ${DISPLAY}`, `600 15px ${DISPLAY}`, `700 9px ${MONO}`, `500 9px ${MONO}`].map((font) =>
      document.fonts?.load(font).catch(() => null),
    ),
  );
  let fontsLoaded = false;
  fontsReady.then(() => {
    fontsLoaded = true;
    for (const card of cards) {
      card.signature = "";
    }
  });

  const cards = CARDS.map((spec) => {
    const [w, h] = spec.size;
    const canvas = document.createElement("canvas");
    canvas.width = w * DENSITY;
    canvas.height = h * DENSITY;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.anisotropy = 4;
    const material = new THREE.MeshBasicNodeMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w * METRES_PER_PX, h * METRES_PER_PX), material);
    mesh.name = `xr-hud-${spec.id}`;
    mesh.renderOrder = 1000;
    mesh.frustumCulled = false;
    mesh.layers.set(VIEWMODEL_LAYER);
    mesh.visible = false;
    // Body-locked on the arc, turned to face the head.
    const yaw = THREE.MathUtils.degToRad(spec.place.yaw);
    mesh.position.set(-Math.sin(yaw) * ARC_RADIUS, EYE_Y + spec.place.y, -Math.cos(yaw) * ARC_RADIUS);
    mesh.rotation.set(-spec.place.y * 0.35, yaw, 0, "YXZ");
    group.add(mesh);
    return { spec, canvas, ctx: canvas.getContext("2d"), texture, mesh, signature: "" };
  });

  let wait = 0;

  function paint(card, data) {
    const { ctx, canvas, spec } = card;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(DENSITY, 0, 0, DENSITY, 0, 0);
    ctx.save();
    spec.draw(ctx, data, spec.size);
    ctx.restore();
    card.texture.needsUpdate = true;
  }

  /** @param {boolean} visible  in-run (cards) vs menus (page panel) */
  function update(delta, visible) {
    group.visible = visible;
    if (!visible) {
      return;
    }
    wait -= delta;
    if (wait > 0) {
      return;
    }
    wait = REPAINT_INTERVAL;
    const root = domHud?.root;
    // Same visibility as the flat HUD (runner-hud.is-visible).
    const hudShown = Boolean(root?.classList.contains("is-visible"));
    for (const card of cards) {
      const data = hudShown ? card.spec.read(root) : null;
      card.mesh.visible = Boolean(data) && fontsLoaded;
      if (!data || !fontsLoaded) {
        continue;
      }
      const signature = JSON.stringify(data);
      if (signature !== card.signature) {
        card.signature = signature;
        paint(card, data);
      }
    }
  }

  function dispose() {
    for (const card of cards) {
      card.texture.dispose();
      card.mesh.geometry.dispose();
      card.mesh.material.dispose();
    }
  }

  return { group, update, dispose };
}
