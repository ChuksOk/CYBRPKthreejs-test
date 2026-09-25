import * as THREE from "three/webgpu";
import {
  Fn,
  abs,
  clamp,
  float,
  fract,
  log,
  luminance,
  max,
  mix,
  mx_noise_float,
  perspectiveDepthToViewZ,
  pow,
  screenSize,
  screenUV,
  smoothstep,
  step,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";

/**
 * Moebius / ligne-claire graphic-novel look, tuned after Shedworks' Sable:
 * clean even ink lines, big flat colour fields in two or three bright tones,
 * cool lilac shadows against warm sand light, and a pale aerial haze that
 * swallows distance (lines included). One post node, no material swaps, so
 * the city, drones and viewmodel all get it.
 *
 * 1. Lines
 *    - silhouettes: outer log-depth steps (drawn on the far pixel, so thin
 *      things keep their fill);
 *    - creases: Laplacian of inverse depth (1/z is linear across a plane in
 *      screen space, so it is ~0 on flat walls and spikes at corners,
 *      window reveals, ledges) — geometry lines without texture noise;
 *    - strong albedo boundaries (luminance Sobel, desktop only);
 *    - glowing shapes (laser tracers, neon) get a thin ring over the bloom.
 *    Line width scales with resolution; distant lines fade into the haze
 *    colour rather than just thinning out.
 * 2. Flat shading: the scene colour is lightly smoothed (texture speckle →
 *    flat fields), its perceptual lightness mapped onto four hard-edged,
 *    compressed-bright levels, hue kept, shadows tinted cool and lights
 *    warm, grey surfaces pulled toward a pastel ramp.
 * 3. Sparse fine hatching only in the deepest band; clean sky gradient;
 *    faint paper grain to avoid banding.
 * 4. Day–night: `setDaylight(0..1)` blends day / night palettes, sky, haze
 *    and exposure (night keeps Sable's luminous dusk rather than going black).
 *
 * Cost: 5 depth + 5–9 emissive + (desktop) 8 colour fetches per pixel,
 * full-res; `colorEdges: false` (mobile) drops the colour taps.
 */

function linearColor(hex) {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}

export function createMoebiusStyle({ scenePass, camera, colorEdges = true }) {
  const depthTexture = scenePass.getTextureNode("depth");
  const colorTexture = scenePass.getTextureNode("output");
  const emissiveTexture = scenePass.getTextureNode("emissive");

  const near = uniform(camera.near).onFrameUpdate(() => camera.near);
  const far = uniform(camera.far).onFrameUpdate(() => camera.far);

  const uniforms = {
    daylight: uniform(0.6),
    // Lines.
    lineWidth: uniform(1),
    depthEdge: uniform(0.04),
    creaseEdge: uniform(0.018),
    creaseFadeEnd: uniform(70),
    colorEdge: uniform(0.42),
    // Tone flattening: how much of the wide-footprint average replaces the
    // pixel's own lightness (kills texture speckle at band edges).
    toneFlatten: uniform(0.92),
    lineFadeStart: uniform(45),
    lineFadeEnd: uniform(150),
    // Tone.
    exposureDay: uniform(1.12),
    exposureNight: uniform(1.5),
    liftDay: uniform(0.04),
    liftNight: uniform(0.1),
    saturation: uniform(1.45),
    paletteMixGrey: uniform(0.4),
    paletteMixColor: uniform(0.12),
    shadowTint: uniform(new THREE.Vector3(0.84, 0.9, 1.16)),
    lightTint: uniform(new THREE.Vector3(1.06, 1.0, 0.9)),
    // Detail.
    hatchSpacing: uniform(4.5),
    hatchStrength: uniform(0.32),
    hazeStart: uniform(30),
    hazeEnd: uniform(160),
    hazeAmount: uniform(0.62),
    grain: uniform(0.018),
    bloomAmount: uniform(0.38),
    glowOutlineWidth: uniform(1),
    glowOutline: uniform(0.9),
    ink: uniform(linearColor(0x16120f)),
    // Day palette: periwinkle / lilac shadows, terracotta mids, sand lights,
    // bone highlights; cyan → pale-cyan → cream sky; pale haze.
    dayShadow: uniform(linearColor(0x7a88c8)),
    dayShadow2: uniform(linearColor(0xa497cf)),
    dayMid: uniform(linearColor(0xe39a78)),
    dayLight: uniform(linearColor(0xf1d6a0)),
    dayHighlight: uniform(linearColor(0xfcf6e8)),
    daySkyTop: uniform(linearColor(0x46acd6)),
    daySkyMid: uniform(linearColor(0xa4dade)),
    daySkyHorizon: uniform(linearColor(0xfae6bd)),
    dayHaze: uniform(linearColor(0xd9eae8)),
    // Night palette: Sable's luminous blue dusk — indigo shadows, mauve mids,
    // rose lights; deep teal-blue sky with a dusky rose horizon.
    nightShadow: uniform(linearColor(0x2f3a7c)),
    nightShadow2: uniform(linearColor(0x4c4d96)),
    nightMid: uniform(linearColor(0x8a6aa6)),
    nightLight: uniform(linearColor(0xc9a2b6)),
    nightHighlight: uniform(linearColor(0xeee0da)),
    nightSkyTop: uniform(linearColor(0x14245a)),
    nightSkyMid: uniform(linearColor(0x33498e)),
    nightSkyHorizon: uniform(linearColor(0xa77aa6)),
    nightHaze: uniform(linearColor(0x5d64a4)),
  };

  // ~1 px at 1080p, scaled with resolution so lines keep their weight.
  const lineScale = max(float(1), screenSize.y.div(1080)).mul(uniforms.lineWidth);
  const texel = vec2(1).div(screenSize).mul(lineScale);

  const viewDepthAt = (uv) => perspectiveDepthToViewZ(depthTexture.sample(uv).r, near, far).negate();
  const colorAt = (uv) => colorTexture.sample(uv).rgb;
  const glowMaskAt = (uv) => smoothstep(0.12, 0.35, luminance(emissiveTexture.sample(uv).rgb));
  /** Day / night palette entry blended by daylight. */
  const palette = (name) => mix(uniforms[`night${name}`], uniforms[`day${name}`], uniforms.daylight);

  /** Thin ink ring just outside glowing shapes (laser beams, neon). */
  const glowOutline = Fn(() => {
    const uv = screenUV;
    const pixel = vec2(1).div(screenSize).mul(uniforms.glowOutlineWidth).mul(lineScale);
    const taps = [vec2(1, 0), vec2(-1, 0), vec2(0, 1), vec2(0, -1)];
    if (colorEdges) {
      taps.push(vec2(0.7, 0.7), vec2(-0.7, 0.7), vec2(0.7, -0.7), vec2(-0.7, -0.7));
    }
    let around = float(0);
    for (const tap of taps) {
      around = max(around, glowMaskAt(uv.add(tap.mul(pixel))));
    }
    return clamp(around.sub(glowMaskAt(uv)), 0, 1);
  });

  /**
   * @param {import("three/tsl").Node} beauty      scene colour (vec4, AO/rain applied)
   * @param {import("three/tsl").Node|null} bloom  bloom contribution or null
   */
  function apply(beauty, bloom = null) {
    return Fn(() => {
      const uv = screenUV;

      // ── Depth: silhouettes + creases ──────────────────────────────────
      const zC = viewDepthAt(uv);
      const zR = viewDepthAt(uv.add(vec2(texel.x, 0)));
      const zL = viewDepthAt(uv.sub(vec2(texel.x, 0)));
      const zU = viewDepthAt(uv.add(vec2(0, texel.y)));
      const zD = viewDepthAt(uv.sub(vec2(0, texel.y)));

      const sky = step(far.mul(0.985), zC);
      const logC = log(max(zC, 0.01));
      const silhouette = max(
        max(logC.sub(log(max(zR, 0.01))), logC.sub(log(max(zL, 0.01)))),
        max(logC.sub(log(max(zU, 0.01))), logC.sub(log(max(zD, 0.01)))),
      );
      let line = smoothstep(uniforms.depthEdge, uniforms.depthEdge.mul(2), silhouette);

      const iz = (z) => float(1).div(max(z, 0.01));
      const izC = iz(zC);
      const lap = max(
        abs(iz(zR).add(iz(zL)).sub(izC.mul(2))),
        abs(iz(zU).add(iz(zD)).sub(izC.mul(2))),
      ).div(izC);
      const creaseFade = float(1).sub(smoothstep(uniforms.creaseFadeEnd.mul(0.6), uniforms.creaseFadeEnd, zC));
      line = max(line, smoothstep(uniforms.creaseEdge, uniforms.creaseEdge.mul(2.2), lap).mul(creaseFade).mul(0.9));

      // ── Colour: light smoothing (+ Sobel on desktop) ─────────────────
      let rgb = beauty.rgb;
      let toneLuma = null;
      if (colorEdges) {
        const tl = colorAt(uv.add(vec2(texel.x.negate(), texel.y)));
        const tc = colorAt(uv.add(vec2(0, texel.y)));
        const tr = colorAt(uv.add(texel));
        const ml = colorAt(uv.sub(vec2(texel.x, 0)));
        const mr = colorAt(uv.add(vec2(texel.x, 0)));
        const bl = colorAt(uv.sub(texel));
        const bc = colorAt(uv.sub(vec2(0, texel.y)));
        const br = colorAt(uv.add(vec2(texel.x, texel.y.negate())));
        // Texture speckle → flat fields (weighted 3×3, centre-heavy).
        const blurred = tl.add(tr).add(bl).add(br)
          .add(tc.add(ml).add(mr).add(bc).mul(2))
          .add(rgb.mul(4))
          .div(16);
        rgb = blurred;
        // Wide footprint (≈5 px diagonals) for the tone decision only.
        const w = texel.mul(5);
        const wide = colorAt(uv.add(w))
          .add(colorAt(uv.sub(w)))
          .add(colorAt(uv.add(vec2(w.x, w.y.negate()))))
          .add(colorAt(uv.add(vec2(w.x.negate(), w.y))))
          .add(blurred.mul(4))
          .div(8);
        toneLuma = mix(luminance(blurred), luminance(wide), uniforms.toneFlatten);
        const l = (c) => pow(luminance(c), 0.4545);
        const gx = l(tr).add(l(mr).mul(2)).add(l(br)).sub(l(tl)).sub(l(ml).mul(2)).sub(l(bl));
        const gy = l(tl).add(l(tc).mul(2)).add(l(tr)).sub(l(bl)).sub(l(bc).mul(2)).sub(l(br));
        const grad = gx.mul(gx).add(gy.mul(gy)).sqrt();
        // Albedo boundaries only on geometry (no cloud scribbles in the sky).
        line = max(line, smoothstep(uniforms.colorEdge, uniforms.colorEdge.mul(1.6), grad).mul(0.6).mul(sky.oneMinus()));
      }

      // ── Flat tones ────────────────────────────────────────────────────
      const exposure = mix(uniforms.exposureNight, uniforms.exposureDay, uniforms.daylight);
      const lift = mix(uniforms.liftNight, uniforms.liftDay, uniforms.daylight);
      const luma = max(luminance(rgb), 0.0001);
      const chroma = rgb.div(luma);
      const lp = clamp(pow(max(toneLuma ?? luma, 0.0001), 0.4545).mul(exposure).add(lift), 0, 1);
      // Hard-edged steps (small soft zone for AA / texture) onto compressed,
      // bright levels.
      const stepAt = (edge) => smoothstep(edge - 0.035, edge + 0.035, lp);
      let level = float(0.3);
      level = mix(level, float(0.52), stepAt(0.16));
      level = mix(level, float(0.74), stepAt(0.4));
      level = mix(level, float(0.93), stepAt(0.72));
      const lit = stepAt(0.4); // 0 = shadow side, 1 = light side
      const levelLinear = pow(level, 2.2);

      // Keep hue; tint shadows cool and light warm; saturate.
      const cel = clamp(chroma.mul(levelLinear), 0, 1).mul(mix(uniforms.shadowTint, uniforms.lightTint, lit));
      const celSat = clamp(mix(vec3(luminance(cel)), cel, uniforms.saturation), 0, 1);
      // Grey surfaces take the pastel ramp (by level), coloured ones keep hue.
      const ramp = mix(
        mix(mix(palette("Shadow"), palette("Shadow2"), smoothstep(0.35, 0.5, level)), palette("Mid"), smoothstep(0.5, 0.7, level)),
        mix(palette("Light"), palette("Highlight"), smoothstep(0.8, 0.95, level)),
        smoothstep(0.7, 0.8, level),
      );
      const srcSat = clamp(chroma.sub(vec3(1)).abs().dot(vec3(0.5)), 0, 1);
      const paletteMix = mix(uniforms.paletteMixGrey, uniforms.paletteMixColor, smoothstep(0.08, 0.45, srcSat));
      let color = mix(celSat, ramp, paletteMix);

      // Sparse fine hatching in the deepest band only.
      const px = uv.mul(screenSize).div(lineScale);
      const deep = float(1).sub(stepAt(0.16));
      const hatchLine = float(1).sub(step(0.2, fract(px.x.add(px.y).div(uniforms.hatchSpacing))));
      const hatch = hatchLine.mul(deep).mul(uniforms.hatchStrength);

      // ── Atmosphere + sky ──────────────────────────────────────────────
      const hazeColor = palette("Haze");
      const haze = smoothstep(uniforms.hazeStart, uniforms.hazeEnd, zC).mul(uniforms.hazeAmount);
      color = mix(color, uniforms.ink, hatch.mul(haze.oneMinus()));
      color = mix(color, hazeColor, haze);

      const skyT = uv.y.oneMinus();
      const skyGradient = mix(
        mix(palette("SkyHorizon"), palette("SkyMid"), smoothstep(0.38, 0.6, skyT)),
        palette("SkyTop"),
        smoothstep(0.6, 0.98, skyT),
      );
      // Keep a whisper of the real sky (cloud shapes) under the gradient.
      color = mix(color, mix(skyGradient, celSat, 0.16), sky);

      // Faint grain so large flat fields don't band.
      color = color.add(mx_noise_float(vec3(px.mul(1.3), 5)).mul(uniforms.grain));

      // ── Ink ───────────────────────────────────────────────────────────
      // Lines lighten into the haze with distance (aerial perspective).
      const lineFade = smoothstep(uniforms.lineFadeStart, uniforms.lineFadeEnd, zC);
      const inkColor = mix(uniforms.ink, hazeColor, lineFade.mul(0.75));
      // Never ink over glowing pixels (neon, laser cores). Skyline
      // silhouettes land on sky pixels and stay; the haze colour lightens them.
      const inkAmount = line.mul(glowMaskAt(uv).oneMinus()).mul(float(1).sub(lineFade.mul(0.35)));
      color = mix(color, inkColor, inkAmount);

      if (bloom) {
        color = color.add(bloom.rgb.mul(uniforms.bloomAmount));
      }
      color = mix(color, uniforms.ink, glowOutline().mul(uniforms.glowOutline));
      return vec4(color, beauty.a);
    })();
  }

  /** 0 = night, 1 = full day (from the runner's day–night cycle). */
  function setDaylight(value) {
    uniforms.daylight.value = Math.max(0, Math.min(1, value));
  }

  return { uniforms, apply, setDaylight };
}
