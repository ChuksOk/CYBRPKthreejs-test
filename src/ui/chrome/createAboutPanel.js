import "./aboutPanel.css";
import { isMobileLayout, onMobileLayoutChange } from "../../platform/deviceLayout.js";
import { SOURCE_CODE_URL } from "../core/externalLinks.js";
import {
  AUTHOR_NAME,
  AUTHOR_URL,
  BASE_PROJECT_CREDIT,
  GAME_TITLE,
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
  root.innerHTML = `
    <button type="button" class="close-button-panel" aria-label="Close">
      ${CLOSE_ICON}
    </button>

    <div class="about-content">
      <div class="about-body">
        <div class="about-brand">
          <p class="about-brand-title">${GAME_TITLE}</p>
          <small class="about-brand-subtitle">A GAME BY ${AUTHOR_NAME.toUpperCase()}</small>
        </div>
        <div class="about-copy">
          <div class="about-copy-col">
            <p class="about-lead">
              ${GAME_TITLE} is a first-person endless runner and shooter set in a
              rain-soaked cyberpunk alley under drone curfew. Run the street, switch
              lanes, jump barriers, slide under beams and shoot the GIGI drone fleet
              out of the sky.
            </p>
            <p class="about-lead">
              Four VX-series weapons, three drone classes and an endless tiled city,
              all rendered live in the browser with Three.js WebGPU and TSL shaders.
            </p>
          </div>
          <div class="about-copy-col">
            <p class="about-lead">
              Designed and built by ${AUTHOR_NAME}: game design, runner and combat
              systems, drones, weapons and the ticket-style interface.
            </p>
            <p class="about-lead about-lead--credit">
              ${BASE_PROJECT_CREDIT} Sound effects: Kenney (CC0). Fonts: Barlow
              Condensed &amp; JetBrains Mono (OFL).
            </p>
          </div>
        </div>
      </div>

      <div class="about-footer">
        <div class="about-buttons">
          <button type="button" class="refresh-button-panel about-link-author">
            ${AUTHOR_NAME}
          </button>
          <button type="button" class="refresh-button-panel about-link-source">
            Source code
          </button>
        </div>
        <p class="about-model-credits">
          © ${new Date().getFullYear()} ${AUTHOR_NAME}
        </p>
        <p class="about-recommended about-recommended--desktop">
          <span class="about-recommended-title">Recommended setup</span>
          GPU power and 16 GB RAM are what matter most. Mac: M2 or newer.
          PC: discrete GPU, 16 GB RAM.
          Chrome or Edge (latest) · WebGPU required · 1080p fullscreen (4K scales down automatically).
          A/D lanes · Space jump · S slide · mouse aim · click fire · 1–4 / Q weapons · headphones recommended.
        </p>
        <p class="about-recommended about-recommended--mobile">
          <span class="about-recommended-title">Recommended setup</span>
          iPhone 15 or newer · Android: 2023 flagship or newer (Snapdragon 8 Gen 2 / equivalent, 8 GB RAM).
          Chrome (latest) · WebGPU required · landscape orientation.
          Swipe left side to move · drag right side to aim · tap weapon chip to switch · headphones recommended.
        </p>
      </div>
    </div>
  `;

  const closeButton = root.querySelector(".close-button-panel");
  const authorButton = root.querySelector(".about-link-author");
  const sourceButton = root.querySelector(".about-link-source");
  const desktopRecommended = root.querySelector(".about-recommended--desktop");
  const mobileRecommended = root.querySelector(".about-recommended--mobile");

  function syncRecommendedVisibility() {
    const mobile = isMobileLayout();
    desktopRecommended.hidden = mobile;
    mobileRecommended.hidden = !mobile;
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

  authorButton.addEventListener("click", () => {
    window.open(AUTHOR_URL, "_blank", "noopener,noreferrer");
  });

  sourceButton.addEventListener("click", () => {
    window.open(SOURCE_CODE_URL, "_blank", "noopener,noreferrer");
  });

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
