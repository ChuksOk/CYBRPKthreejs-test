import * as THREE from "three/webgpu";
import {
  Fn,
  abs,
  clamp,
  float,
  floor,
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
 * Moebius / ligne-claire graphic-novel look as one post node (no material
 * swaps, so every object in the scene — city, drones, viewmodel — gets it).
 *
 * 1. Ink outlines: log-depth discontinuities (silhouettes) + a luminance
 *    Sobel on the scene colour (creases, panel lines), faded with distance.
 * 2. Cel shading: luminance quantised in perceptual space into flat bands,
 *    hue kept, then pulled toward a pastel Moebius ramp (teal shadow →
 *    dusty rose → sand → cream).
 * 3. Cross-hatching in the two darkest bands (screen-space diagonals).
 * 4. Pastel aerial haze with distance, warm paper tone + fibre grain.
 *
 * Cost: 5 depth + (optionally) 8 colour fetches per pixel, full-res; the
 * colour-edge taps are skipped when `colorEdges` is false (mobile).
 */

function linearColor(hex) {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}

export function createMoebiusStyle({ scenePass, camera, colorEdges = true }) {
  const depthTexture = scenePass.getTextureNode("depth");
  const colorTexture = scenePass.getTextureNode("output");

  const near = uniform(camera.near).onFrameUpdate(() => camera.near);
  const far = uniform(camera.far).onFrameUpdate(() => camera.far);

  const uniforms = {
    lineWidth: uniform(1.15),
    depthEdge: uniform(0.045),
    colorEdge: uniform(0.2),
    lineFadeStart: uniform(55),
    lineFadeEnd: uniform(140),
    bands: uniform(4),
    exposure: uniform(1.28),
    lift: uniform(0.08),
    paletteMix: uniform(0.34),
    saturation: uniform(1.4),
    hatchSpacing: uniform(6),
    hatchStrength: uniform(0.55),
    hazeStart: uniform(40),
    hazeEnd: uniform(170),
    hazeAmount: uniform(0.42),
    paperAmount: uniform(0.35),
    bloomAmount: uniform(0.85),
    ink: uniform(linearColor(0x1a130e)),
    shadow: uniform(linearColor(0x2e5470)),
    mid: uniform(linearColor(0xd08a73)),
    light: uniform(linearColor(0xeccf98)),
    highlight: uniform(linearColor(0xfff1d6)),
    haze: uniform(linearColor(0xf2c9a6)),
    skyTop: uniform(linearColor(0x7fc4c8)),
    skyHorizon: uniform(linearColor(0xf7d9a6)),
    paper: uniform(linearColor(0xf6ead2)),
  };

  const texel = vec2(1).div(screenSize).mul(uniforms.lineWidth);

  const viewDepthAt = (uv) => perspectiveDepthToViewZ(depthTexture.sample(uv).r, near, far).negate();
  const lumaAt = (uv) => luminance(colorTexture.sample(uv).rgb);

  /** 0..1 ink coverage at this pixel. */
  const inkLines = Fn(() => {
    const uv = screenUV;
    const center = viewDepthAt(uv);
    const logC = log(max(center, 0.01));
    const offsets = [vec2(1, 0), vec2(-1, 0), vec2(0, 1), vec2(0, -1)];
    let depthDelta = float(0);
    for (const offset of offsets) {
      const d = log(max(viewDepthAt(uv.add(offset.mul(texel))), 0.01));
      depthDelta = max(depthDelta, abs(d.sub(logC)));
    }
    let line = smoothstep(uniforms.depthEdge, uniforms.depthEdge.mul(2.2), depthDelta);

    if (colorEdges) {
      // Sobel on luminance (perceptual) for interior contour lines.
      const l = (x, y) => pow(lumaAt(uv.add(vec2(x, y).mul(texel))), 0.4545);
      const tl = l(-1, 1);
      const t = l(0, 1);
      const tr = l(1, 1);
      const ml = l(-1, 0);
      const mr = l(1, 0);
      const bl = l(-1, -1);
      const b = l(0, -1);
      const br = l(1, -1);
      const gx = tr.add(mr.mul(2)).add(br).sub(tl).sub(ml.mul(2)).sub(bl);
      const gy = tl.add(t.mul(2)).add(tr).sub(bl).sub(b.mul(2)).sub(br);
      const grad = gx.mul(gx).add(gy.mul(gy)).sqrt();
      line = max(line, smoothstep(uniforms.colorEdge, uniforms.colorEdge.mul(1.8), grad).mul(0.85));
    }

    const fade = float(1).sub(smoothstep(uniforms.lineFadeStart, uniforms.lineFadeEnd, center));
    return line.mul(fade.mul(0.75).add(0.25));
  });

  /** Pastel ramp by perceptual lightness. */
  const paletteRamp = Fn(([l]) => {
    const a = mix(uniforms.shadow, uniforms.mid, smoothstep(0.08, 0.42, l));
    const b = mix(a, uniforms.light, smoothstep(0.4, 0.72, l));
    return mix(b, uniforms.highlight, smoothstep(0.72, 0.95, l));
  });

  /**
   * @param {import("three/tsl").Node} beauty      scene colour (vec4, AO/rain applied)
   * @param {import("three/tsl").Node|null} bloom  bloom contribution or null
   */
  function apply(beauty, bloom = null) {
    return Fn(() => {
      const rgb = beauty.rgb;

      // Perceptual lightness, lifted: Moebius pages are bright.
      const luma = max(luminance(rgb), 0.0001);
      const chroma = rgb.div(luma);
      const lp = clamp(pow(luma, 0.4545).mul(uniforms.exposure).add(uniforms.lift), 0, 1);
      // Flat bands with a hair of softness so band edges don't shimmer.
      const scaled = lp.mul(uniforms.bands);
      const band = floor(scaled);
      const soft = smoothstep(0.42, 0.58, fract(scaled));
      const q = clamp(band.add(soft).div(uniforms.bands), 0, 1);
      const qLinear = pow(q, 2.2);

      // Keep hue, flatten value; then pull toward the pastel ramp.
      const cel = clamp(chroma.mul(qLinear), 0, 1);
      const celSat = mix(vec3(luminance(cel)), cel, uniforms.saturation);
      let color = mix(celSat, paletteRamp(q), uniforms.paletteMix);

      // Aerial perspective toward a warm pastel sky.
      const viewDepth = viewDepthAt(screenUV);
      const haze = smoothstep(uniforms.hazeStart, uniforms.hazeEnd, viewDepth).mul(uniforms.hazeAmount);
      color = mix(color, uniforms.haze, haze);
      // Sky: a flat two-tone gradient (teal → sand), as in the comics.
      const sky = step(far.mul(0.985), viewDepth);
      const skyColor = mix(uniforms.skyHorizon, uniforms.skyTop, smoothstep(0.45, 1, screenUV.y.oneMinus()));
      color = mix(color, mix(skyColor, celSat, 0.18), sky);

      // Cross-hatching (pixel space) in the dark bands, fading into haze.
      const px = screenUV.mul(screenSize);
      const diagA = fract(px.x.add(px.y).div(uniforms.hatchSpacing));
      const diagB = fract(px.x.sub(px.y).div(uniforms.hatchSpacing.mul(1.3)));
      const strokeA = float(1).sub(step(0.22, diagA));
      const strokeB = float(1).sub(step(0.2, diagB));
      const darkA = float(1).sub(smoothstep(0.3, 0.42, q));
      const darkB = float(1).sub(smoothstep(0.12, 0.24, q));
      const hatch = max(strokeA.mul(darkA), strokeB.mul(darkB))
        .mul(float(1).sub(haze))
        .mul(sky.oneMinus())
        .mul(uniforms.hatchStrength);
      color = mix(color, uniforms.ink, hatch);

      // Paper: warm multiply + fibre grain.
      const fibre = mx_noise_float(vec3(px.mul(0.35), 0)).mul(0.5).add(0.5);
      const grain = mx_noise_float(vec3(px.mul(1.7), 3)).mul(0.035);
      color = mix(color, color.mul(uniforms.paper), uniforms.paperAmount).mul(float(0.97).add(fibre.mul(0.05))).add(grain);

      // Ink on top, then neon glow over the ink so signage stays vivid.
      color = mix(color, uniforms.ink, inkLines());
      if (bloom) {
        color = color.add(bloom.rgb.mul(uniforms.bloomAmount));
      }
      return vec4(color, beauty.a);
    })();
  }

  return { uniforms, apply };
}
