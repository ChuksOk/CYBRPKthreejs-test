import { WEAPONS } from "../../weapon/weaponTypes.js";
import { ARMORY, tierCost, xpForRank } from "../../runner/progression.js";

/**
 * Meta screens (Armory, Missions, Records, upgrade picker, rewards block).
 * Pure HTML renderers in the ticket / label language; the HUD owns the
 * screen element and routes `data-action` clicks back to the game.
 */

const pad = (value, length) => String(Math.max(0, Math.floor(value))).padStart(length, "0");
const hex = (value) => `#${value.toString(16).padStart(6, "0")}`;

function shell(title, code, body, { back = "menu" } = {}) {
  return `
    <div class="meta-ticket">
      <div class="mt-head">
        <div class="tk-tag"><span class="t-meta">${code}</span><span class="mt-title">${title}</span></div>
        <button class="mt-back" data-action="${back}"><span>←</span><span>BACK</span></button>
      </div>
      <div class="mt-body">${body}</div>
    </div>`;
}

function shardChip(data) {
  return `<span class="mt-shards"><i></i><b>${pad(data.shards, 5)}</b><span class="t-meta">SHARDS</span></span>`;
}

export function renderArmory(data) {
  const weapons = ARMORY.weapons
    .map((item) => {
      const owned = data.unlockedWeapons.includes(item.index);
      const weapon = WEAPONS[item.index];
      return `<button class="mt-item${owned ? " is-owned" : ""}" data-action="buy" data-kind="weapon" data-id="${item.index}" ${owned ? "disabled" : ""}>
        <span class="t-meta">${item.code}</span><b>${weapon?.name ?? item.name}</b>
        <em>${owned ? "OWNED" : `${item.cost} ◆`}</em>
      </button>`;
    })
    .join("");
  const tierButtons = (list) => list
    .map((tier) => {
      const level = data.tiers[tier.id] ?? 0;
      const maxed = level >= tier.max;
      const pips = Array.from({ length: tier.max }, (_, i) => `<i class="${i < level ? "on" : ""}"></i>`).join("");
      return `<button class="mt-item mt-tier${maxed ? " is-owned" : ""}" data-action="buy" data-kind="tier" data-id="${tier.id}" ${maxed ? "disabled" : ""}>
        <span class="t-meta">${tier.desc}</span><b>${tier.name}</b>
        <span class="mt-pips">${pips}</span>
        <em>${maxed ? "MAX" : `${tierCost(tier, level)} ◆`}</em>
      </button>`;
    })
    .join("");
  const tiers = tierButtons(ARMORY.tiers.filter((tier) => !tier.group));
  const carTiers = tierButtons(ARMORY.tiers.filter((tier) => tier.group === "car"));
  const carLevel = ARMORY.tiers.filter((t) => t.group === "car").reduce((sum, t) => sum + (data.tiers[t.id] ?? 0), 0);
  const cosmetic = (kind, list, owned, equipped) =>
    list
      .map((item) => {
        const has = owned.includes(item.id);
        const on = equipped === item.id;
        return `<button class="mt-item mt-swatch${on ? " is-equipped" : ""}" data-action="buy" data-kind="${kind}" data-id="${item.id}">
          <i style="--sw:${hex(item.hex)}"></i><b>${item.name}</b>
          <em>${on ? "EQUIPPED" : has ? "EQUIP" : `${item.cost} ◆`}</em>
        </button>`;
      })
      .join("");
  return shell(
    "ARMORY",
    "REQUISITION //",
    `
      <div class="mt-row">${shardChip(data)}<span class="t-meta">EARN SHARDS BY RUNNING, SHOOTING &amp; MISSIONS</span></div>
      <h4 class="mt-h">WEAPONS <span class="t-meta">VX-06 CARBINE ISSUED</span></h4>
      <div class="mt-grid">${weapons}</div>
      <h4 class="mt-h">UPGRADES <span class="t-meta">PERMANENT</span></h4>
      <div class="mt-grid mt-grid--2">${tiers}</div>
      <h4 class="mt-h">SKY CAR <span class="t-meta">QUADRA MK-${carMark(carLevel)} · FLYING-CAR POWER-UP</span></h4>
      <div class="mt-grid mt-grid--2">${carTiers}</div>
      <h4 class="mt-h">TRACERS</h4>
      <div class="mt-grid mt-grid--4">${cosmetic("tracer", ARMORY.tracers, data.tracers, data.tracer)}</div>
      <h4 class="mt-h">EXPLOSIONS</h4>
      <div class="mt-grid">${cosmetic("blast", ARMORY.blasts, data.blasts, data.blast)}</div>`,
  );
}

/** Quadra mark from total car upgrade levels (MK-I … MK-V). */
export function carMark(level) {
  return ["I", "II", "III", "IV", "V"][Math.min(4, Math.floor(level / 4))];
}

function rankBlock(data) {
  const need = xpForRank(data.rank);
  const t = data.rank >= 50 ? 1 : data.xp / need;
  return `<div class="mt-rank">
    <div><span class="t-meta">RANK</span><b>${pad(data.rank, 2)}</b><span class="t-meta">/ 50</span></div>
    <div class="mt-xp"><i style="transform:scaleX(${t.toFixed(3)})"></i></div>
    <span class="t-meta">${data.rank >= 50 ? "MAX RANK" : `${Math.floor(data.xp)} / ${need} XP`}</span>
  </div>`;
}

export function renderMissions(data, streakMultiplier) {
  const missions = data.missions
    .map((m) => {
      const value = m.live ?? m.progress ?? 0;
      return `<div class="mt-mission${m.done ? " is-done" : ""}">
        <b>${m.text}</b>
        <div class="mt-xp"><i style="transform:scaleX(${Math.min(1, value / m.target).toFixed(3)})"></i></div>
        <span class="t-meta">${pad(value, 1)} / ${m.target} · +${m.xp} XP · +${m.shards} ◆</span>
      </div>`;
    })
    .join("");
  return shell(
    "MISSIONS",
    "ORDERS //",
    `
      ${rankBlock(data)}
      <div class="mt-row">
        <span class="mt-streak"><b>${data.streak.count || 0}</b><span class="t-meta">DAY STREAK · SHARDS ×${streakMultiplier.toFixed(1)}</span></span>
        <span class="t-meta">RUN ON CONSECUTIVE DAYS TO GROW THE BONUS (MAX ×1.6)</span>
      </div>
      <div class="mt-missions">${missions || '<span class="t-meta">ALL CLEAR</span>'}</div>`,
  );
}

export function renderRecords(data, dailyBest) {
  const rows = data.records
    .map(
      (r, i) => `<div class="mt-rec"><b>${pad(i + 1, 2)}</b><span>${pad(r.score, 6)}</span><span>${pad(r.distance, 4)}M</span><span>${pad(r.kills, 3)} KO</span><span class="t-meta">${r.date}${r.daily ? " · DAILY" : ""}</span></div>`,
    )
    .join("");
  return shell(
    "RECORDS",
    "LOCAL BOARD //",
    `
      <div class="mt-row"><span class="mt-streak"><b>${pad(dailyBest, 6)}</b><span class="t-meta">TODAY'S DAILY RUN BEST</span></span>
      <span class="t-meta">${data.runs} RUNS LOGGED</span></div>
      <div class="mt-recs">${rows || '<span class="t-meta">NO RUNS YET — GO SET ONE</span>'}</div>`,
  );
}

export function renderUpgradePicker({ choices, sector }) {
  const cards = choices
    .map(
      (u, i) => `<button class="up-card" data-action="upgrade" data-id="${u.id}">
        <kbd>${i + 1}</kbd>
        <span class="t-meta">MOD // ${u.id.toUpperCase()}</span>
        <b>${u.name}</b>
        <span class="up-desc">${u.desc}</span>
      </button>`,
    )
    .join("");
  return `
    <div class="up-wrap">
      <div class="up-head"><span class="t-meta">SECTOR ${pad(sector, 2)} GATE</span><b>CHOOSE A MOD</b><span class="t-meta">1 · 2 · 3 OR TAP</span></div>
      <div class="up-cards">${cards}</div>
    </div>`;
}

/** Rewards block on the game-over ticket. */
export function renderRewards(rewards, data) {
  if (!rewards) {
    return "";
  }
  const missions = rewards.completed.map((m) => `<li>✓ ${m.text}</li>`).join("");
  return `
    <div class="go-rewards">
      <div><span class="t-meta">SHARDS BANKED</span><b>+${rewards.earned}<em>◆</em></b><span class="t-meta">${rewards.multiplier > 1 ? `STREAK ×${rewards.multiplier.toFixed(1)}` : `TOTAL ${data.shards}`}</span></div>
      <div><span class="t-meta">XP</span><b>+${rewards.xp}</b><span class="t-meta">${rewards.rankUps.length ? `RANK UP → ${rewards.rankUps[rewards.rankUps.length - 1]}` : `RANK ${data.rank}`}</span></div>
      ${missions ? `<ul class="go-missions">${missions}</ul>` : ""}
    </div>`;
}
