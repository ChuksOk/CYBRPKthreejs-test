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
.xr-html.xr-transparent, .xr-html.xr-transparent > .xr-body { background: transparent !important; }
.xr-html.xr-transparent::before, .xr-html.xr-transparent::after,
.xr-html.xr-transparent > .xr-body::before, .xr-html.xr-transparent > .xr-body::after { display: none !important; }
`;

const dataUrlCache = new Map();

/** Reject after `ms` so one stuck asset / decode can never wedge the HUD. */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function toDataUrl(url) {
  if (url.startsWith("data:")) {
    return url;
  }
  if (!dataUrlCache.has(url)) {
    dataUrlCache.set(
      url,
      withTimeout(fetch(url), 4000, `fetch ${url}`)
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

/** `src: url(a.woff2) format("woff2"), url(a.woff) …` → just the woff2 source. */
function woff2Only(src) {
  const sources = src.split(/,(?![^(]*\))/).map((part) => part.trim());
  return sources.find((part) => /woff2/i.test(part)) ?? sources[0] ?? src;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") {
      depth += 1;
    } else if (c === ")") {
      depth -= 1;
    } else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Classes a selector needs present to match (`null` = can't tell, always
 * keep). A rule can only match the current DOM if every positive class of
 * one of its selectors exists in the snapshot.
 */
function requiredClasses(selector) {
  if (/:(is|where|has|matches)\(/.test(selector)) {
    return null;
  }
  const positive = selector.replace(/:not\([^)]*\)/g, "");
  return Array.from(positive.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g), (m) => m[1]);
}

function familyName(value) {
  return value.trim().replace(/^["']|["']$/g, "").toLowerCase();
}

/**
 * Parse one CSSOM rule into the snapshot model:
 *   { font, family, text } | { text, alternatives } | { head, items }
 * with root selectors retargeted and url()s resolved.
 */
function parseRule(rule, base, urls, out) {
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
    parseSheet(rule.styleSheet, rule.styleSheet.href || base, urls, out);
    return;
  }
  const kind = rule.constructor?.name;
  // Animations are frozen in snapshots.
  if (kind === "CSSKeyframesRule") {
    return;
  }
  // @font-face: one format is enough (Chromium reads woff2) — the icon font
  // alone ships ~1 MB of ttf + woff otherwise.
  if (kind === "CSSFontFaceRule" && rule.style) {
    const declarations = Array.from(rule.style, (name) => {
      const value = rule.style.getPropertyValue(name);
      return `${name}:${name === "src" ? woff2Only(value) : value}`;
    }).join(";");
    out.push({ font: true, family: familyName(rule.style.getPropertyValue("font-family")), text: resolve(`@font-face{${declarations}}`) });
    return;
  }
  if (rule.selectorText !== undefined && rule.style) {
    const selector = rewriteSelector(rule.selectorText);
    const alternatives = splitTopLevel(rule.selectorText).map(requiredClasses);
    let nested = "";
    if (rule.cssRules?.length) {
      // CSS nesting: keep the children verbatim with the parent.
      nested = Array.from(rule.cssRules, (child) => resolve(child.cssText)).join("");
    }
    out.push({ text: `${selector}{${resolve(rule.style.cssText)}${nested}}`, alternatives });
    return;
  }
  if (rule.cssRules && (rule.media || rule.conditionText !== undefined)) {
    const items = [];
    for (const child of Array.from(rule.cssRules)) {
      parseRule(child, base, urls, items);
    }
    out.push({ head: rule.cssText.slice(0, rule.cssText.indexOf("{")), items });
    return;
  }
  out.push({ text: resolve(rule.cssText), alternatives: [null] });
}

function parseSheet(sheet, base, urls, out) {
  let rules;
  try {
    rules = sheet.cssRules;
  } catch {
    return; // cross-origin sheet (e.g. a CDN font) — skip
  }
  for (const rule of Array.from(rules)) {
    parseRule(rule, base, urls, out);
  }
}

function inlineUrls(items, data) {
  for (const item of items) {
    if (item.items) {
      inlineUrls(item.items, data);
    } else if (item.text.includes('url("')) {
      item.text = item.text.replace(/url\("([^"]+)"\)/g, (match, url) => (data.get(url) ? `url("${data.get(url)}")` : match));
    }
  }
}

/** Only the rules that can match the snapshot, and only the fonts it uses. */
function buildCss(items, classes, families) {
  let text = "";
  for (const item of items) {
    if (item.items) {
      const inner = buildCss(item.items, classes, families);
      if (inner) {
        text += `${item.head}{${inner}}`;
      }
    } else if (item.font) {
      if (families.has(item.family)) {
        text += item.text;
      }
    } else if (item.alternatives.some((needed) => needed === null || needed.every((name) => classes.has(name)))) {
      text += item.text;
    }
  }
  return text;
}

/** Class names and font families present in a subtree (+ page root classes). */
function collectUsage(root) {
  const classes = new Set(["xr-html", "xr-body"]);
  const families = new Set();
  const add = (element) => {
    for (const name of element.classList) {
      classes.add(name);
    }
    for (const family of getComputedStyle(element).fontFamily.split(",")) {
      families.add(familyName(family));
    }
  };
  for (const element of [document.documentElement, document.body]) {
    for (const name of element.classList) {
      classes.add(name);
    }
  }
  add(root);
  for (const element of root.querySelectorAll("*")) {
    add(element);
  }
  return { classes, families };
}

export function createDomSnapshotter() {
  let model = null;
  let preparing = null;
  let stage = "idle";

  /** Parse and inline the page CSS (once; call again after new styles load). */
  function prepare({ force = false } = {}) {
    if (preparing && !force) {
      return preparing;
    }
    preparing = (async () => {
      const urls = new Set();
      const items = [];
      for (const sheet of Array.from(document.styleSheets)) {
        parseSheet(sheet, sheet.href || window.location.href, urls, items);
      }
      const inlined = await Promise.all(Array.from(urls, async (url) => [url, await toDataUrl(url)]));
      inlineUrls(items, new Map(inlined.filter(([, data]) => data)));
      model = items;
      return model;
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
    await withTimeout(Promise.all(jobs), 5000, "snapshot images");

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
  /**
   * @param {{ scale?: number, skip?: string, transparent?: boolean }} [options]
   *   transparent: drop the page (html / body) background, for cropped cards.
   */
  async function snapshot(element, canvas, { scale = 1.5, skip = null, transparent = false } = {}) {
    stage = "prepare";
    if (!model) {
      await withTimeout(prepare(), 8000, "snapshot prepare");
    }
    stage = "clone";
    const usage = collectUsage(element);
    const width = Math.max(1, Math.round(window.innerWidth));
    const height = Math.max(1, Math.round(window.innerHeight));
    // document.body → its children go straight into the wrapper body div.
    const isBody = element === document.body;
    const clone = await cloneForSnapshot(element, skip);

    const htmlEl = document.documentElement;
    const bodyEl = document.body;
    const wrapper = document.createElementNS(XHTML_NS, "div");
    wrapper.setAttribute("class", `xr-html ${transparent ? "xr-transparent " : ""}${htmlEl.className}`.trim());
    wrapper.setAttribute(
      "style",
      `${htmlEl.getAttribute("style") ?? ""};position:relative;width:${width}px;height:${height}px;overflow:hidden;` +
        (transparent ? "background:transparent !important;" : ""),
    );
    const style = document.createElementNS(XHTML_NS, "style");
    style.textContent = buildCss(model, usage.classes, usage.families) + SNAPSHOT_CSS;
    wrapper.appendChild(style);
    const body = document.createElementNS(XHTML_NS, "div");
    body.setAttribute("class", `xr-body ${bodyEl.className}`.trim());
    body.setAttribute(
      "style",
      `${bodyEl.getAttribute("style") ?? ""};margin:0;width:100%;height:100%;` + (transparent ? "background:transparent !important;" : ""),
    );
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
      // Sized in CSS px so vw / vh / media queries resolve exactly as on the
      // live page; drawImage rasterizes the vector image at `scale`.
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<foreignObject x="0" y="0" width="${width}" height="${height}">${markup}</foreignObject></svg>`;

    const image = new Image();
    stage = "decode";
    // `load`, not decode(): decode() can stall while the page is in the
    // background (the flat page often is, behind the headset); drawImage
    // decodes synchronously anyway.
    const loaded = new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("snapshot image failed to load"));
    });
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await withTimeout(loaded, 6000, "snapshot load");
    stage = "draw";

    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { width, height, scale };
  }

  return { prepare, snapshot, isReady: () => model !== null, getStage: () => stage };
}
