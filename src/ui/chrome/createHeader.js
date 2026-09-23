import "./header.css";
import { SOURCE_CODE_URL } from "../core/externalLinks.js";
import { phosphorGearSix, phosphorGithubLogo, phosphorInfo } from "../core/phosphorIcons.js";
import { createHudPanel } from "../walk/createHudPanel.js";

export function createHeader({ state, onOpenSettings, onOpenAbout } = {}) {
  const root = document.createElement("div");
  // Hidden until revealAppUi — coordinator mounts later in init.
  root.className = "app-header app-header--force-hidden";
  root.setAttribute("data-ui-block-look", "true");
  root.innerHTML = `
    <div class="app-header-brand"></div>
    <div class="app-header-actions">
      <button type="button" class="app-header-about-btn" aria-label="About">
        <span class="app-header-action-icon">${phosphorInfo}</span>
        <span class="app-header-about-label">ABOUT</span>
      </button>
      <button type="button" class="app-header-about-btn app-header-source-btn" aria-label="Source code">
        <span class="app-header-action-icon">${phosphorGithubLogo}</span>
        <span class="app-header-source-label">SOURCE</span>
      </button>
      <button type="button" class="app-header-action-btn app-header-icon-btn app-header-settings-btn" aria-label="Settings">
        <span class="app-header-action-icon">${phosphorGearSix}</span>
      </button>
    </div>
  `;

  const brandSlot = root.querySelector(".app-header-brand");
  const hud = createHudPanel();
  brandSlot.appendChild(hud.root);

  const settingsButton = root.querySelector(".app-header-settings-btn");
  const aboutButton = root.querySelector(".app-header-about-btn:not(.app-header-source-btn)");
  const sourceButton = root.querySelector(".app-header-source-btn");

  settingsButton.addEventListener("click", (event) => {
    event.stopPropagation();
    state?.showAllUi?.();
    state?.openPanel("settings");
    onOpenSettings?.();
  });

  aboutButton.addEventListener("click", (event) => {
    event.stopPropagation();
    state?.showAllUi?.();
    state?.openPanel("about");
    onOpenAbout?.();
  });

  sourceButton.addEventListener("click", (event) => {
    event.stopPropagation();
    state?.showAllUi?.();
    window.open(SOURCE_CODE_URL, "_blank", "noopener,noreferrer");
  });

  document.body.appendChild(root);

  function show() {
    root.classList.add("show");
  }

  function hide() {
    root.classList.remove("show");
  }

  function setForceHidden(hidden) {
    root.classList.toggle("app-header--force-hidden", hidden);
  }

  return { root, show, hide, setForceHidden, bindWalkControls: hud.bindWalkControls, updateHud: hud.update };
}
