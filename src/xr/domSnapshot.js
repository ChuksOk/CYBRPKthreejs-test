/**
 * DOM → image rasterizer for the VR HUD.
 *
 * DOM overlays are invisible inside an immersive WebXR session, so the
 * headset shows *pictures of the real flat UI* instead of a re-drawn copy:
 * the element is cloned, wrapped in an SVG <foreignObject> together with the
 * page's own CSS (fonts and images inlined as data URLs), and decoded as an
 * image. Chromium (Quest Browser) renders foreignObject with full CSS —
 * clip-path, gradients, custom properties, web fonts — so the ticket design
 * matches the flat game pixel for pixel.
 *
 * - `prepare()` gathers + rewrites every same-origin stylesheet once
 *   (`html` / `body` / `:root` selectors are retargeted to wrapper divs, since
 *   the snapshot has no real <html>), and inlines url() resources.
 * - `snapshot(element)` rasterizes one subtree at the live viewport size, so
 *   the layout (and getBoundingClientRect crops) match the live page.
 *
 * Keep snapshots event-driven or throttled: each one re-parses the CSS.
 */

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const ROOT_SELECTOR = /(^|[\s>+~,(])(html|:root)(?=$|[\s>+~,.:#[)])/g;
const BODY_SELECTOR = /(^|[\s>+~,(])body(?=$|[\s>+~,.:#[)])/g;
const URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

// Snapshots are stills: freeze entry animations / transitions at their base
// (final) style and hide the pointer-only affordances.
const SNAPSHOT_CSS = `
.xr-html *, .xr-html *::before, .xr-html *::after {
  animation: none !important;
  transition: none !important;
  caret-color: transparent !important;
}
.xr-html .xr-enter-button { display: none !important; }
.xr-html .is-xr-hover { outline: 3px solid #d9ff3b !important; outline-offset: 2px; }
`;

const dataUrlCache = new Map();

async function toDataUrl(url) {
  if (url.startsWith("data:")) {
    return url;
  }
  if (!dataUrlCache.has(url)) {
    dataUrlCache.set(
      url,
      fetch(url)
        .then((response) => (response.ok ? response.blob() : null))
        .then(
          (blob) =>
            blob &&
            new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => resolve(null);
              reader.readAsDataURL(blob);
            }),
        )
        .catch(() => null),
    );
  }
  return dataUrlCache.get(url);
}

function rewriteSelector(selector) {
  return selector.replace(ROOT_SELECTOR, "$1.xr-html").replace(BODY_SELECTOR, "$1.xr-body");
}

/** Serialize one CSSOM rule, retargeting root selectors and resolving url()s. */
function serializeRule(rule, base, urls) {
  const resolve = (text) =>
    text.replace(URL_PATTERN, (match, quote, raw) => {
      if (raw.startsWith("data:") || raw.startsWith("#")) {
        return match;
      }
      let absolute;
      try {
        absolute = new URL(raw, base).href;
      } catch {
        return match;
      }
      urls.add(absolute);
      return `url("${absolute}")`;
    });

  // CSSImportRule: inline the imported sheet (resolved against its own URL).
  if (rule.styleSheet) {
    return serializeSheet(rule.styleSheet, rule.styleSheet.href || base, urls);
  }
  if (rule.selectorText !== undefined && rule.style) {
    const nested = rule.cssRules?.length
      ? Array.from(rule.cssRules, (child) => serializeRule(child, base, urls)).join("")
      : "";
    return `${rewriteSelector(rule.selectorText)}{${resolve(rule.style.cssText)}${nested}}`;
  }
  if (rule.cssRules && (rule.media || rule.conditionText !== undefined)) {
    const inner = Array.from(rule.cssRules, (child) => serializeRule(child, base, urls)).join("");
    const head = rule.cssText.slice(0, rule.cssText.indexOf("{"));
    return `${head}{${inner}}`;
  }
  return resolve(rule.cssText);
}

function serializeSheet(sheet, base, urls) {
  let rules;
  try {
    rules = sheet.cssRules;
  } catch {
    return ""; // cross-origin sheet (e.g. a CDN font) — skip
  }
  return Array.from(rules, (rule) => serializeRule(rule, base, urls)).join("\n");
}

export function createDomSnapshotter() {
  let css = null;
  let preparing = null;

  /** Collect and inline the page CSS (once; call again after new styles load). */
  function prepare({ force = false } = {}) {
    if (preparing && !force) {
      return preparing;
    }
    preparing = (async () => {
      const urls = new Set();
      let text = "";
      for (const sheet of Array.from(document.styleSheets)) {
        text += serializeSheet(sheet, sheet.href || window.location.href, urls);
        text += "\n";
      }
      const inlined = await Promise.all(Array.from(urls, async (url) => [url, await toDataUrl(url)]));
      for (const [url, data] of inlined) {
        if (data) {
          text = text.split(`url("${url}")`).join(`url("${data}")`);
        }
      }
      css = text + SNAPSHOT_CSS;
      return css;
    })();
    return preparing;
  }

  /** Clone with live form / canvas / image state baked in. */
  async function cloneForSnapshot(element, skip) {
    const clone = element.cloneNode(true);
    // Clone and source share structure, so equal filters keep indices aligned.
    const keep = (node) => !skip || !node.closest(skip);
    const pick = (root, selector) => Array.from(root.querySelectorAll(selector)).filter(keep);
    const sources = pick(element, "input, textarea, select, canvas, img");
    const targets = pick(clone, "input, textarea, select, canvas, img");
    const jobs = [];
    sources.forEach((source, index) => {
      const target = targets[index];
      if (!target) {
        return;
      }
      if (source instanceof HTMLInputElement) {
        if (source.checked) {
          target.setAttribute("checked", "");
        } else {
          target.removeAttribute("checked");
        }
        target.setAttribute("value", source.value);
      } else if (source instanceof HTMLSelectElement) {
        target.querySelectorAll("option").forEach((option, i) => {
          option.toggleAttribute("selected", i === source.selectedIndex);
        });
      } else if (source instanceof HTMLTextAreaElement) {
        target.textContent = source.value;
      } else if (source instanceof HTMLCanvasElement) {
        const img = document.createElement("img");
        try {
          img.src = source.toDataURL();
        } catch {
          // Tainted canvas — leave it blank.
        }
        img.className = source.className;
        img.setAttribute("style", source.getAttribute("style") ?? "");
        img.width = source.width;
        img.height = source.height;
        target.replaceWith(img);
      } else if (source instanceof HTMLImageElement && source.currentSrc) {
        jobs.push(
          toDataUrl(source.currentSrc).then((data) => {
            if (data) {
              target.setAttribute("src", data);
            } else {
              target.removeAttribute("src");
            }
            target.removeAttribute("srcset");
          }),
        );
      }
    });
    await Promise.all(jobs);

    // Scroll positions are live state, not markup: shift scrolled content.
    const scrolledSources = [element, ...pick(element, "*")];
    const scrolledTargets = [clone, ...pick(clone, "*")];
    scrolledSources.forEach((source, index) => {
      const target = scrolledTargets[index];
      if (!target || (source.scrollTop === 0 && source.scrollLeft === 0)) {
        return;
      }
      target.style.overflow = "hidden";
      for (const child of target.children) {
        child.style.translate = `${-source.scrollLeft}px ${-source.scrollTop}px`;
      }
    });
    if (skip) {
      for (const node of clone.querySelectorAll(skip)) {
        node.remove();
      }
    }
    return clone;
  }

  /**
   * Rasterize `element` (laid out at the live viewport size) into `canvas`.
   * @returns {Promise<{ width: number, height: number, scale: number }>}
   */
  async function snapshot(element, canvas, { scale = 1.5, skip = null } = {}) {
    if (!css) {
      await prepare();
    }
    const width = Math.max(1, Math.round(window.innerWidth));
    const height = Math.max(1, Math.round(window.innerHeight));
    // document.body → its children go straight into the wrapper body div.
    const isBody = element === document.body;
    const clone = await cloneForSnapshot(element, skip);

    const htmlEl = document.documentElement;
    const bodyEl = document.body;
    const wrapper = document.createElementNS(XHTML_NS, "div");
    wrapper.setAttribute("class", `xr-html ${htmlEl.className}`.trim());
    wrapper.setAttribute(
      "style",
      `${htmlEl.getAttribute("style") ?? ""};position:relative;width:${width}px;height:${height}px;overflow:hidden;`,
    );
    const style = document.createElementNS(XHTML_NS, "style");
    style.textContent = css;
    wrapper.appendChild(style);
    const body = document.createElementNS(XHTML_NS, "div");
    body.setAttribute("class", `xr-body ${bodyEl.className}`.trim());
    body.setAttribute("style", `${bodyEl.getAttribute("style") ?? ""};margin:0;width:100%;height:100%;background:transparent;`);
    if (isBody) {
      body.append(...clone.childNodes);
    } else {
      body.appendChild(clone);
    }
    wrapper.appendChild(body);

    for (const node of body.querySelectorAll("script, noscript")) {
      node.remove();
    }
    const markup = new XMLSerializer().serializeToString(wrapper);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" viewBox="0 0 ${width} ${height}">` +
      `<foreignObject x="0" y="0" width="${width}" height="${height}">${markup}</foreignObject></svg>`;

    const image = new Image();
    image.decoding = "async";
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await image.decode();

    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { width, height, scale };
  }

  return { prepare, snapshot, isReady: () => css !== null };
}
