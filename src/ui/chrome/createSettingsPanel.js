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

function renderMoebiusSection(moebius) {
  if (!moebius) {
    return "";
  }
  const presets = moebius.presets
    .map(
      (preset) => `
      <button type="button" class="settings-preset-btn settings-moebius-preset" data-moebius-preset="${preset.id}" aria-pressed="false" title="${preset.hint}">
        ${preset.label}
      </button>`,
    )
    .join("");
  const groups = [...new Set(moebius.options.map((option) => option.group))];
  const body = groups
    .map((group) => {
      const options = moebius.options.filter((option) => option.group === group);
      if (group === "Palette") {
        return `
          <p class="settings-gfx-group">${group}</p>
          <div class="settings-swatch-grid">
            ${options
              .map(
                (option) => `
              <label class="settings-swatch">
                <input type="color" data-moebius-key="${option.key}" aria-label="${option.label}" />
                <span>${option.label}</span>
              </label>`,
              )
              .join("")}
          </div>`;
      }
      return `
        <p class="settings-gfx-group">${group}</p>
        ${options
          .map(
            (option) => `
          <label class="settings-gfx-row settings-gfx-row--range">
            <span class="settings-gfx-text">
              <span class="settings-gfx-title">${option.label}</span>
              <span class="settings-gfx-value" data-moebius-value="${option.key}"></span>
            </span>
            <input type="range" class="settings-gfx-range" data-moebius-key="${option.key}"
              min="${option.min}" max="${option.max}" step="${option.step}" aria-label="${option.label}" />
          </label>`,
          )
          .join("")}`;
    })
    .join("");
  return `
          <div class="settings-moebius">
            <p class="settings-gfx-hint">Comic style presets (applies in Moebius mode)</p>
            <div class="settings-preset-row settings-preset-row--wrap" role="group" aria-label="Comic style preset">
              ${presets}
            </div>
            <details class="settings-gfx-advanced">
              <summary>
                <span>Tune comic style</span>
                <span class="settings-gfx-preset-label" data-moebius-preset-label></span>
              </summary>
              <div class="settings-gfx-list">
                ${body}
                <button type="button" class="settings-mini-btn" data-moebius-reset>Reset comic style</button>
              </div>
            </details>
          </div>`;
}

function renderAudioSection(audio) {
  if (!audio) {
    return "";
  }
  const row = (key, label, hint) => `
          <label class="settings-gfx-row settings-gfx-row--range">
            <span class="settings-gfx-text">
              <span class="settings-gfx-title">${label}</span>
              <span class="settings-gfx-value" data-audio-value="${key}"></span>
            </span>
            <input type="range" class="settings-gfx-range" min="0" max="1" step="0.01" data-audio-key="${key}" aria-label="${label}" />
            <span class="settings-gfx-hint">${hint}</span>
          </label>`;
  return `
        <div class="settings-divider" role="separator"></div>

        <div class="settings-section">
          <p class="settings-section-title">Audio</p>
          ${row("music", "Music volume", "Soundtrack and synth score")}
          ${row("sfx", "Sound effects", "Weapons, drones, engines, rain ambience")}
        </div>`;
}

function renderGameplaySection(gameplay) {
  if (!gameplay?.showAimAssist) {
    return "";
  }
  return `
        <div class="settings-divider" role="separator"></div>

        <div class="settings-section">
          <p class="settings-section-title">Gameplay</p>
          <label class="settings-gfx-row">
            <span class="settings-gfx-text">
              <span class="settings-gfx-title">Aim assist (mouse)</span>
              <span class="settings-gfx-hint">Gently pulls your aim toward the most urgent drone · toggle in-run with T</span>
            </span>
            <input type="checkbox" class="settings-toggle-input" data-gameplay-key="aimAssist" aria-label="Aim assist" />
            <span class="settings-toggle" aria-hidden="true"></span>
          </label>
          <label class="settings-gfx-row settings-gfx-row--range">
            <span class="settings-gfx-text">
              <span class="settings-gfx-title">Aim assist strength</span>
              <span class="settings-gfx-value" data-gameplay-value="aimAssistStrength"></span>
            </span>
            <input type="range" class="settings-gfx-range" min="0.1" max="1" step="0.05" data-gameplay-key="aimAssistStrength" aria-label="Aim assist strength" />
          </label>
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
  getVisualStyle = () => "neon",
  onVisualStyleChange,
  moebius = null,
  gameplay = null,
  audio = null,
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
          <label class="settings-option settings-option--style">
            <span class="settings-option-text">
              <span class="settings-option-title">Moebius comic mode</span>
              <span class="settings-gfx-hint">Cel-shaded graphic-novel look: ink lines, bold flat color, hatching</span>
            </span>
            <input type="checkbox" class="settings-toggle-input" data-visual-style aria-label="Moebius comic mode" />
            <span class="settings-toggle" aria-hidden="true"></span>
          </label>
          ${renderMoebiusSection(moebius)}
        </div>

        ${renderAudioSection(audio)}

        ${renderGraphicsSection(graphics)}

        ${renderGameplaySection(gameplay)}

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
          Resets look, visual style, comic style, graphics and gameplay preferences and turns off development mode
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
  const styleToggle = root.querySelector("[data-visual-style]");
  const moebiusPresetButtons = [...root.querySelectorAll("[data-moebius-preset]")];
  const moebiusInputs = [...root.querySelectorAll("[data-moebius-key]")];
  const moebiusPresetLabel = root.querySelector("[data-moebius-preset-label]");
  const gameplayInputs = [...root.querySelectorAll("[data-gameplay-key]")];
  const audioInputs = [...root.querySelectorAll("[data-audio-key]")];

  function syncAudio() {
    if (!audio) {
      return;
    }
    const values = { music: audio.getMusic(), sfx: audio.getSfx() };
    for (const input of audioInputs) {
      const key = input.dataset.audioKey;
      input.value = String(values[key]);
      const label = root.querySelector(`[data-audio-value="${key}"]`);
      if (label) {
        label.textContent = `${Math.round(values[key] * 100)}%`;
      }
    }
  }

  function formatMoebius(key, value) {
    const option = moebius?.options.find((entry) => entry.key === key);
    return option?.format ? option.format(Number(value)) : String(value);
  }

  function syncMoebius() {
    if (!moebius) {
      return;
    }
    const values = moebius.getValues();
    const presetId = moebius.getPreset();
    for (const button of moebiusPresetButtons) {
      const selected = button.dataset.moebiusPreset === presetId;
      button.classList.toggle("settings-preset-btn--active", selected);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    }
    if (moebiusPresetLabel) {
      moebiusPresetLabel.textContent =
        presetId === "custom" ? "Custom" : moebius.presets.find((p) => p.id === presetId)?.label ?? "";
    }
    for (const input of moebiusInputs) {
      const key = input.dataset.moebiusKey;
      input.value = String(values[key]);
      const label = root.querySelector(`[data-moebius-value="${key}"]`);
      if (label) {
        label.textContent = formatMoebius(key, values[key]);
      }
    }
  }

  function syncGameplay() {
    if (!gameplay) {
      return;
    }
    const values = gameplay.get();
    for (const input of gameplayInputs) {
      const key = input.dataset.gameplayKey;
      if (input.type === "checkbox") {
        input.checked = Boolean(values[key]);
      } else {
        input.value = String(values[key]);
        const label = root.querySelector(`[data-gameplay-value="${key}"]`);
        if (label) {
          label.textContent = `${Math.round(values[key] * 100)}%`;
        }
      }
    }
  }
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
    styleToggle.checked = getVisualStyle() === "moebius";
    syncMoebius();
    syncGameplay();
    syncAudio();
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

  for (const button of moebiusPresetButtons) {
    button.addEventListener("click", () => {
      moebius?.setPreset(button.dataset.moebiusPreset);
      // A preset is only visible in Moebius mode: switch it on.
      if (getVisualStyle() !== "moebius") {
        onVisualStyleChange?.("moebius");
        styleToggle.checked = true;
      }
      syncMoebius();
    });
  }

  for (const input of moebiusInputs) {
    // Uniform updates are cheap: apply live while dragging.
    input.addEventListener("input", () => {
      const key = input.dataset.moebiusKey;
      moebius?.set(key, input.type === "color" ? input.value : Number(input.value));
      const label = root.querySelector(`[data-moebius-value="${key}"]`);
      if (label) {
        label.textContent = formatMoebius(key, input.value);
      }
      if (moebiusPresetLabel) {
        moebiusPresetLabel.textContent = "Custom";
      }
      for (const button of moebiusPresetButtons) {
        button.classList.remove("settings-preset-btn--active");
        button.setAttribute("aria-pressed", "false");
      }
    });
  }

  root.querySelector("[data-moebius-reset]")?.addEventListener("click", () => {
    moebius?.reset();
    syncMoebius();
  });

  for (const input of audioInputs) {
    input.addEventListener("input", () => {
      const value = Number(input.value);
      if (input.dataset.audioKey === "music") {
        audio?.setMusic(value);
      } else {
        audio?.setSfx(value);
      }
      syncAudio();
    });
  }

  for (const input of gameplayInputs) {
    input.addEventListener(input.type === "checkbox" ? "change" : "input", () => {
      gameplay?.set(input.dataset.gameplayKey, input.type === "checkbox" ? input.checked : Number(input.value));
      syncGameplay();
    });
  }

  styleToggle.addEventListener("change", () => {
    onVisualStyleChange?.(styleToggle.checked ? "moebius" : "neon");
  });

  devToggle.addEventListener("change", () => {
    onDevelopmentModeChange?.(devToggle.checked);
  });

  restartButton.addEventListener("click", () => {
    const confirmed = window.confirm(
      "Reset configs? Look, comic style, graphics and gameplay preferences will return to default and development mode will turn off.",
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
    syncMoebius,
    syncGameplay,
    syncAudio,
    destroy() {
      document.removeEventListener("keydown", onKeyDown);
      root.remove();
    },
  };
}
