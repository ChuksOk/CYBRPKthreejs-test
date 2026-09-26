import "./aboutPanel.css";
import { isMobileLayout, onMobileLayoutChange } from "../../platform/deviceLayout.js";
import {
  AUTHOR_NAME,
  AUTHOR_URL,
  BASE_PROJECT_CREDIT,
  GAME_TAGLINE,
  GAME_TITLE,
  STORY,
} from "../../app/credits.js";

const CLOSE_ICON = `
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      d="M18 6L6 18M6 6L18 18"
      stroke="currentColor"
      stroke-width="2.25"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
`;

export function createAboutPanel({ state } = {}) {
  const root = document.createElement("div");
  root.className = "about-overlay";
  root.hidden = true;
  const year = new Date().getFullYear();
  const studioHost = AUTHOR_URL.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const controls = [
    ["A / D", "Switch lane"],
    ["Space", "Jump"],
    ["S", "Slide"],
    ["Mouse", "Aim"],
    ["Click", "Fire"],
    ["R", "Reload"],
    ["1–4 / Q", "Weapons"],
    ["E", "Special"],
  ];
  const touchControls = [
    ["Swipe ← →", "Switch lane"],
    ["Swipe ↑", "Jump"],
    ["Swipe ↓", "Slide"],
    ["Auto", "Aim"],
    ["FIRE", "Hold to shoot"],
    ["SPECIAL", "When charged"],
  ];
  const controlRows = (rows) =>
    rows.map(([key, label]) => `<li><kbd>${key}</kbd><span>${label}</span></li>`).join("");

  root.innerHTML = `
    <div class="ab-card" role="dialog" aria-modal="true" aria-labelledby="ab-title">
      <button type="button" class="close-button-panel ab-close" aria-label="Close">
        ${CLOSE_ICON}
      </button>

      <header class="ab-hero">
        <span class="ab-kicker">${STORY.year} · A break on ${STORY.world}</span>
        <h2 class="ab-title" id="ab-title">${GAME_TITLE}</h2>
        <p class="ab-tagline">${GAME_TAGLINE}</p>
      </header>

      <div class="ab-grid">
        <section class="ab-main">
          <p class="ab-lead">
            ${STORY.premise} ${STORY.goal}
          </p>
          <p class="ab-text">
            You are ${STORY.player}. Sprint the neon streets of the simulation, switch
            lanes, vault barriers, slide under beams and shoot down the drones the game
            sends to catch you. Every run builds on the last: pick upgrades at each sector
            gate, take down carrier bosses, complete missions, climb 50 ranks and spend
            energy in the Armory. The weather and the time of day shift as the sim runs.
          </p>

          <dl class="ab-stats">
            <div><dt>Weapons</dt><dd>4</dd></div>
            <div><dt>Drone classes</dt><dd>4</dd></div>
            <div><dt>Upgrades</dt><dd>13</dd></div>
            <div><dt>Ranks</dt><dd>50</dd></div>
          </dl>

          <div class="ab-section">
            <h3 class="ab-h">Controls</h3>
            <ul class="ab-keys ab-keys--desktop">${controlRows(controls)}</ul>
            <ul class="ab-keys ab-keys--mobile">${controlRows(touchControls)}</ul>
          </div>
        </section>

        <aside class="ab-side">
          <div class="ab-studio">
            <span class="ab-kicker">Developed by</span>
            <p class="ab-studio-name">${AUTHOR_NAME}</p>
            <p class="ab-text">Game design, combat systems, drones, weapons and interface.</p>
            <a class="ab-cta about-link-author" href="${AUTHOR_URL}" target="_blank" rel="noopener noreferrer">
              <span>Visit ${studioHost}</span><span aria-hidden="true">↗</span>
            </a>
          </div>

          <div class="ab-section">
            <h3 class="ab-h">Built with</h3>
            <ul class="ab-chips">
              <li>Three.js WebGPU</li><li>TSL shaders</li><li>Web Audio</li><li>Vite</li>
            </ul>
          </div>

          <div class="ab-section">
            <h3 class="ab-h">Recommended</h3>
            <p class="ab-small about-recommended about-recommended--desktop">
              Chrome or Edge (latest) with WebGPU · discrete GPU or Apple M2+ · 16 GB RAM · headphones.
            </p>
            <p class="ab-small about-recommended about-recommended--mobile">
              iPhone 15+ or a 2023 Android flagship · Chrome (latest) with WebGPU · landscape · headphones.
            </p>
          </div>
        </aside>
      </div>

      <footer class="ab-footer">
        <p>© ${year} ${AUTHOR_NAME}. All rights reserved.</p>
        <p class="ab-credit">${BASE_PROJECT_CREDIT} Sound: Kenney (CC0). Fonts: Barlow Condensed &amp; JetBrains Mono (OFL).</p>
      </footer>
    </div>
  `;

  root.addEventListener("click", (event) => {
    if (event.target === root) {
      close();
    }
  });

  const closeButton = root.querySelector(".close-button-panel");
  const desktopRecommended = root.querySelector(".about-recommended--desktop");
  const mobileRecommended = root.querySelector(".about-recommended--mobile");

  function syncRecommendedVisibility() {
    const mobile = isMobileLayout();
    desktopRecommended.hidden = mobile;
    mobileRecommended.hidden = !mobile;
    root.classList.toggle("ab-is-mobile", mobile);
  }

  syncRecommendedVisibility();
  const unsubscribeLayout = onMobileLayoutChange(syncRecommendedVisibility);

  function open() {
    root.classList.remove("about-overlay--force-hidden");
    syncRecommendedVisibility();
    root.hidden = false;
  }

  function close() {
    root.hidden = true;
    state?.closePanel();
  }

  closeButton.addEventListener("click", close);


  function onKeyDown(event) {
    if (event.key === "Escape" && !root.hidden) {
      close();
    }
  }

  document.addEventListener("keydown", onKeyDown);

  state?.subscribe(({ openedPanel }) => {
    if (openedPanel === "about") {
      open();
    } else if (!root.hidden) {
      root.hidden = true;
    }
  });

  function setForceHidden(hidden) {
    if (hidden && !root.hidden) {
      return;
    }

    root.classList.toggle("about-overlay--force-hidden", hidden);
  }

  document.body.appendChild(root);

  return {
    root,
    open,
    close,
    setForceHidden,
    destroy() {
      unsubscribeLayout?.();
      document.removeEventListener("keydown", onKeyDown);
      root.remove();
    },
  };
}
