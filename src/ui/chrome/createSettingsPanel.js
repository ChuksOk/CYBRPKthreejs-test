import "./settingsPanel.css";
import {
  phosphorArrowCounterClockwise,
  phosphorX,
} from "../core/phosphorIcons.js";

function renderLookButtons(lookOptions) {
  return lookOptions
    .map(
      (option) => `
      <button
        type="button"
        class="settings-look-btn"
        data-look-preset="${option.id}"
        aria-pressed="false"
      >
        <span class="settings-look-icon">${option.icon}</span>
        <span class="settings-look-label">${option.label}</span>
      </button>
    `,
    )
    .join("");
}

function renderGraphicsSection(graphics) {
  if (!graphics) {
    return "";
  }
  const presets = graphics.presets
    .map(
      (preset) => `
      <button type="button" class="settings-preset-btn" data-graphics-preset="${preset.id}" aria-pressed="false">
        ${preset.label}
      </button>`,
    )
    .join("");
  const rows = graphics.options
    .map((option) => {
      const locked = graphics.isLocked(option.key);
      if (option.type === "toggle") {
        return `
        <label class="settings-gfx-row${locked ? " is-locked" : ""}">
          <span class="settings-gfx-text">
            <span class="settings-gfx-title">${option.label}</span>
            ${option.hint ? `<span class="settings-gfx-hint">${option.hint}</span>` : ""}
            ${locked ? '<span class="settings-gfx-hint">Unavailable on this browser</span>' : ""}
          </span>
          <input type="checkbox" class="settings-toggle-input" data-graphics-key="${option.key}" aria-label="${option.label}" ${locked ? "disabled" : ""} />
          <span class="settings-toggle" aria-hidden="true"></span>
        </label>`;
      }
      const max = graphics.getRange(option.key)?.max ?? option.max;
      return `
        <label class="settings-gfx-row settings-gfx-row--range">
          <span class="settings-gfx-text">
            <span class="settings-gfx-title">${option.label}</span>
            <span class="settings-gfx-value" data-graphics-value="${option.key}"></span>
          </span>
          <input type="range" class="settings-gfx-range" data-graphics-key="${option.key}"
            min="${option.min}" max="${max}" step="${option.step}" aria-label="${option.label}" />
        </label>`;
    })
    .join("");
  return `
        <div class="settings-divider" role="separator"></div>

        <div class="settings-section">
          <p class="settings-section-title">Graphics</p>
          <div class="settings-preset-row" role="group" aria-label="Graphics quality">
            ${presets}
          </div>
          <details class="settings-gfx-advanced">
            <summary>
              <span>Advanced</span>
              <span class="settings-gfx-preset-label" data-graphics-preset-label></span>
            </summary>
            <div class="settings-gfx-list">
              ${rows}
            </div>
          </details>
        </div>`;
}

export function createSettingsPanel({
  state,
  lookOptions = [],
  defaultLookPreset = "neutral",
  getDevelopmentMode = () => false,
  onDevelopmentModeChange,
  getCurrentLookPreset = () => defaultLookPreset,
  onLookPresetChange,
  onRestart,
  graphics = null,
} = {}) {
  const root = document.createElement("div");
  root.className = "settings-overlay";
  root.setAttribute("data-ui-block-look", "true");
  root.hidden = true;
  root.innerHTML = `
    <div class="settings-glass" role="dialog" aria-modal="true" aria-label="Settings">
      <button type="button" class="settings-close" aria-label="Close">
        ${phosphorX}
      </button>

      <div class="settings-options">
        <div class="settings-section">
          <p class="settings-section-title">Look</p>
          <div class="settings-look-grid" role="group" aria-label="Color look">
            ${renderLookButtons(lookOptions)}
          </div>
        </div>

        ${renderGraphicsSection(graphics)}

        <div class="settings-divider" role="separator"></div>

        <label class="settings-option">
          <span class="settings-option-text">
            <span class="settings-option-title">Development mode</span>
          </span>
          <input
            type="checkbox"
            class="settings-toggle-input"
            data-development-mode
            aria-label="Development mode"
          />
          <span class="settings-toggle" aria-hidden="true"></span>
        </label>

        <div class="settings-divider" role="separator"></div>

        <button type="button" class="settings-restart-btn" data-restart>
          <span class="settings-restart-icon">${phosphorArrowCounterClockwise}</span>
          <span>Reset configs</span>
        </button>
        <p class="settings-restart-hint">
          Resets look and graphics preferences and turns off development mode
        </p>
      </div>
    </div>
  `;

  const glass = root.querySelector(".settings-glass");
  const closeButton = root.querySelector(".settings-close");
  const devToggle = root.querySelector("[data-development-mode]");
  const restartButton = root.querySelector("[data-restart]");
  const lookButtons = [...root.querySelectorAll("[data-look-preset]")];
  const lookOptionIds = new Set(lookOptions.map((option) => option.id));
  const presetButtons = [...root.querySelectorAll("[data-graphics-preset]")];
  const graphicsInputs = [...root.querySelectorAll("[data-graphics-key]")];
  const presetLabel = root.querySelector("[data-graphics-preset-label]");

  function syncGraphics() {
    if (!graphics) {
      return;
    }
    const values = graphics.getValues();
    const presetId = graphics.getPreset();
    for (const button of presetButtons) {
      const selected = button.dataset.graphicsPreset === presetId;
      button.classList.toggle("settings-preset-btn--active", selected);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    }
    if (presetLabel) {
      presetLabel.textContent =
        presetId === "custom"
          ? "Custom"
          : graphics.presets.find((preset) => preset.id === presetId)?.label ?? "";
    }
    for (const input of graphicsInputs) {
      const key = input.dataset.graphicsKey;
      const option = graphics.options.find((entry) => entry.key === key);
      if (input.type === "checkbox") {
        input.checked = Boolean(values[key]);
      } else {
        input.value = String(values[key]);
        const label = root.querySelector(`[data-graphics-value="${key}"]`);
        if (label) {
          label.textContent = option?.format ? option.format(Number(values[key])) : String(values[key]);
        }
      }
    }
  }

  function syncDevelopmentMode(enabled) {
    devToggle.checked = Boolean(enabled);
  }

  function syncLookPreset(presetId = getCurrentLookPreset()) {
    const activeId = lookOptionIds.has(presetId)
      ? presetId
      : defaultLookPreset;

    for (const button of lookButtons) {
      const selected = button.dataset.lookPreset === activeId;
      button.classList.toggle("settings-look-btn--active", selected);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    }
  }

  function open() {
    root.classList.remove("settings-overlay--force-hidden");
    syncDevelopmentMode(getDevelopmentMode());
    syncLookPreset();
    graphics?.syncFromProfile?.();
    syncGraphics();
    root.hidden = false;
  }

  function close() {
    root.hidden = true;
    state?.closePanel();
  }

  function setForceHidden(hidden) {
    if (hidden && !root.hidden) {
      return;
    }

    root.classList.toggle("settings-overlay--force-hidden", hidden);
  }

  root.addEventListener("pointerdown", () => {
    state?.showAllUi?.();
  });

  root.addEventListener("click", (event) => {
    if (event.target === root) {
      close();
    }
  });

  closeButton.addEventListener("click", close);

  glass.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  for (const button of lookButtons) {
    button.addEventListener("click", () => {
      const presetId = button.dataset.lookPreset;
      onLookPresetChange?.(presetId);
      syncLookPreset(presetId);
    });
  }

  for (const button of presetButtons) {
    button.addEventListener("click", () => {
      graphics?.setPreset(button.dataset.graphicsPreset);
      syncGraphics();
    });
  }

  for (const input of graphicsInputs) {
    const key = input.dataset.graphicsKey;
    if (input.type === "checkbox") {
      input.addEventListener("change", () => {
        graphics?.set(key, input.checked);
        syncGraphics();
      });
    } else {
      // Live value label while dragging; apply on release (pipeline rebuilds).
      input.addEventListener("input", () => {
        const option = graphics?.options.find((entry) => entry.key === key);
        const label = root.querySelector(`[data-graphics-value="${key}"]`);
        if (label) {
          label.textContent = option?.format ? option.format(Number(input.value)) : input.value;
        }
      });
      input.addEventListener("change", () => {
        graphics?.set(key, Number(input.value));
        syncGraphics();
      });
    }
  }

  devToggle.addEventListener("change", () => {
    onDevelopmentModeChange?.(devToggle.checked);
  });

  restartButton.addEventListener("click", () => {
    const confirmed = window.confirm(
      "Reset configs? Look and graphics preferences will return to default and development mode will turn off.",
    );
    if (!confirmed) {
      return;
    }

    onRestart?.();
    close();
  });

  function onKeyDown(event) {
    if (event.key === "Escape" && !root.hidden) {
      close();
    }
  }

  document.addEventListener("keydown", onKeyDown);

  state?.subscribe(({ openedPanel }) => {
    if (openedPanel === "settings") {
      open();
    } else if (!root.hidden) {
      root.hidden = true;
    }
  });

  document.body.appendChild(root);

  return {
    root,
    open,
    close,
    setForceHidden,
    syncDevelopmentMode,
    syncLookPreset,
    syncGraphics,
    destroy() {
      document.removeEventListener("keydown", onKeyDown);
      root.remove();
    },
  };
}
