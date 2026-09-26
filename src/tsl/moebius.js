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
 * 1. Ink outlines: outer log-depth silhouettes + a luminance Sobel on the
 *    scene colour (creases, panel lines). Lines thin with distance: a
 *    ~2 px ring on near objects, 1 px mid-ground, faint hairlines far
 *    away (judged by the object's depth, not the background's); never drawn
 *    over glowing pixels. Glowing shapes (laser tracers, neon, LEDs) get
 *    their own thin ink ring from the emissive buffer, drawn over the bloom
 *    so the halo can't wash it out.
 * 2. Cel shading: luminance quantised in perceptual space into flat bands,
 *    split-toned (violet shadows / warm lights), saturated, then pulled
 *    toward a Moebius ramp (ultramarine → violet → coral → saffron → mint
 *    cream) — strongly for grey surfaces, lightly for coloured ones.
 * 3. Cross-hatching in the two darkest bands (screen-space diagonals).
 * 4. Lavender aerial haze, turquoise → lavender → peach comic sky, warm
 *    paper tone + fibre grain.
 *
 * Cost: 9 depth + 5–9 emissive + (optionally) 8 colour fetches per pixel,
 * full-res; the colour-edge and diagonal glow taps are skipped when
 * `colorEdges` is false (mobile).
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
    lineWidth: uniform(1.15),
    depthEdge: uniform(0.045),
    colorEdge: uniform(0.2),
    // Distance-thinned ink: a thick (≈2.2 px) ring up close, a 1 px line in
    // the mid-ground, fading to a faint hairline far away.
    lineThickRadius: uniform(2.2),
    lineThickNear: uniform(3),
    lineThickFar: uniform(22),
    lineFadeStart: uniform(30),
    lineFadeEnd: uniform(130),
    lineFarOpacity: uniform(0.18),
    bands: uniform(4),
    exposure: uniform(1.2),
    lift: uniform(0.06),
    // Palette pull: strong on grey / low-chroma surfaces, light on things
    // that already have a colour, so the city goes Moebius-colourful while
    // signage and cars keep their hue.
    paletteMixGrey: uniform(0.66),
    paletteMixColor: uniform(0.1),
    saturation: uniform(2.1),
    splitTone: uniform(0.45),
    hatchSpacing: uniform(6),
    hatchStrength: uniform(0.4),
    hazeStart: uniform(40),
    hazeEnd: uniform(170),
    hazeAmount: uniform(0.26),
    paperAmount: uniform(0.07),
    bloomAmount: uniform(0.6),
    glowOutlineWidth: uniform(1),
    glowOutline: uniform(0.92),
    ink: uniform(linearColor(0x1a130e)),
    // Arzach / Airtight Garage ramp, full-strength (not pastel): deep
    // ultramarine and violet shadows, vermilion mids, saffron lights, warm
    // cream highlights.
    shadow: uniform(linearColor(0x1c24a8)),
    shadow2: uniform(linearColor(0x6a1fc4)),
    mid: uniform(linearColor(0xff3d24)),
    light: uniform(linearColor(0xffb300)),
    highlight: uniform(linearColor(0xfff0c2)),
    shadowTint: uniform(new THREE.Vector3(0.72, 0.84, 1.38)),
    lightTint: uniform(new THREE.Vector3(1.24, 1.05, 0.72)),
    haze: uniform(linearColor(0xe06ab8)),
    skyTop: uniform(linearColor(0x00a9d4)),
    skyMid: uniform(linearColor(0x8a5cf0)),
    skyHorizon: uniform(linearColor(0xff7a45)),
    paper: uniform(linearColor(0xfbf1dc)),
  };

  const texel = vec2(1).div(screenSize).mul(uniforms.lineWidth);

  const viewDepthAt = (uv) => perspectiveDepthToViewZ(depthTexture.sample(uv).r, near, far).negate();
  const lumaAt = (uv) => luminance(colorTexture.sample(uv).rgb);
  const glowMaskAt = (uv) => smoothstep(0.12, 0.35, luminance(emissiveTexture.sample(uv).rgb));

  /** 0..1 ink coverage at this pixel. */
  const inkLines = Fn(() => {
    const uv = screenUV;
    const center = viewDepthAt(uv);
    const logC = log(max(center, 0.01));
    const offsets = [vec2(1, 0), vec2(-1, 0), vec2(0, 1), vec2(0, -1)];
    // Outer silhouettes only: ink the far pixel next to a nearer one, so
    // lines sit around objects rather than eating into thin ones. Two
    // radii: 1 px everywhere, plus a wider ring kept only for near objects.
    // Width is judged by the object's depth (the nearest tap), not the
    // background pixel the line is drawn on.
    let depthDelta = float(0);
    let objectDepth = center;
    for (const offset of offsets) {
      const z = viewDepthAt(uv.add(offset.mul(texel)));
      objectDepth = objectDepth.min(z);
      depthDelta = max(depthDelta, logC.sub(log(max(z, 0.01))));
    }
    let wideDelta = float(0);
    let wideDepth = center;
    for (const offset of offsets) {
      const z = viewDepthAt(uv.add(offset.mul(texel).mul(uniforms.lineThickRadius)));
      wideDepth = wideDepth.min(z);
      wideDelta = max(wideDelta, logC.sub(log(max(z, 0.01))));
    }
    const thin = smoothstep(uniforms.depthEdge, uniforms.depthEdge.mul(2.2), depthDelta);
    const nearness = float(1).sub(smoothstep(uniforms.lineThickNear, uniforms.lineThickFar, wideDepth));
    const thick = smoothstep(uniforms.depthEdge, uniforms.depthEdge.mul(2.2), wideDelta).mul(nearness);
    let line = max(thin, thick);
    objectDepth = objectDepth.min(wideDepth);

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

    // Far lines become faint hairlines (sub-pixel width reads as opacity).
    const distant = smoothstep(uniforms.lineFadeStart, uniforms.lineFadeEnd, objectDepth);
    const opacity = mix(float(1), uniforms.lineFarOpacity, distant);
    // Glowing pixels (neon, laser cores) are never inked.
    return line.mul(opacity).mul(glowMaskAt(uv).oneMinus());
  });

  /** Thin ink ring just outside glowing shapes (laser beams, neon). */
  const glowOutline = Fn(() => {
    const uv = screenUV;
    const pixel = vec2(1).div(screenSize).mul(uniforms.glowOutlineWidth);
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

  /** Moebius colour ramp by perceptual lightness. */
  const paletteRamp = Fn(([l]) => {
    const s = mix(uniforms.shadow, uniforms.shadow2, smoothstep(0.05, 0.25, l));
    const a = mix(s, uniforms.mid, smoothstep(0.2, 0.46, l));
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

      // Keep hue, flatten value; then pull toward the Moebius ramp.
      const cel = clamp(chroma.mul(qLinear), 0, 1);
      // Split-tone: cool violet shadows, warm lights.
      const toned = cel.mul(mix(uniforms.shadowTint, uniforms.lightTint, q).mix(vec3(1), uniforms.splitTone.oneMinus()));
      const celSat = clamp(mix(vec3(luminance(toned)), toned, uniforms.saturation), 0, 1);
      // How colourful the source already is (0 = grey).
      const srcSat = clamp(chroma.sub(vec3(1)).abs().dot(vec3(0.5)), 0, 1);
      const paletteMix = mix(uniforms.paletteMixGrey, uniforms.paletteMixColor, smoothstep(0.08, 0.45, srcSat));
      let color = mix(celSat, paletteRamp(q), paletteMix);

      // Aerial perspective toward a lavender haze.
      const viewDepth = viewDepthAt(screenUV);
      const haze = smoothstep(uniforms.hazeStart, uniforms.hazeEnd, viewDepth).mul(uniforms.hazeAmount);
      color = mix(color, uniforms.haze, haze);
      // Sky: a flat two-tone gradient (teal → sand), as in the comics.
      const sky = step(far.mul(0.985), viewDepth);
      const skyT = screenUV.y.oneMinus();
      const skyColor = mix(
        mix(uniforms.skyHorizon, uniforms.skyMid, smoothstep(0.4, 0.62, skyT)),
        uniforms.skyTop,
        smoothstep(0.62, 0.95, skyT),
      );
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

      // Ink on top, then neon glow over the ink so signage stays vivid,
      // then the glow outline over the halo (comic laser: core, ink, halo).
      color = mix(color, uniforms.ink, inkLines());
      if (bloom) {
        color = color.add(bloom.rgb.mul(uniforms.bloomAmount));
      }
      color = mix(color, uniforms.ink, glowOutline().mul(uniforms.glowOutline));
      return vec4(color, beauty.a);
    })();
  }

  return { uniforms, apply };
}
