import * as THREE from "three/webgpu";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const _matrix = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();

/** Normalize to non-indexed position / normal / uv so everything merges. */
function normalize(geometry) {
  let g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (!g.attributes.normal) {
    g.computeVertexNormals();
  }
  if (!g.attributes.uv) {
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  }
  for (const name of Object.keys(g.attributes)) {
    if (name !== "position" && name !== "normal" && name !== "uv") {
      g.deleteAttribute(name);
    }
  }
  g.morphAttributes = {};
  g.clearGroups();
  return g;
}

/**
 * Procedural hard-surface kit: add bevelled primitives / extrusions under a
 * material key, then build() merges each key into one mesh. A detailed rifle
 * or drone ends up as ~6–8 draw calls regardless of part count.
 */
export function createPartKit() {
  const buckets = new Map();

  function add(key, geometry, { position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1] } = {}) {
    _pos.fromArray(position);
    _quat.setFromEuler(_euler.set(rotation[0], rotation[1], rotation[2], "XYZ"));
    _scale.fromArray(typeof scale === "number" ? [scale, scale, scale] : scale);
    _matrix.compose(_pos, _quat, _scale);
    const g = normalize(geometry);
    g.applyMatrix4(_matrix);
    if (!buckets.has(key)) {
      buckets.set(key, []);
    }
    buckets.get(key).push(g);
    return g;
  }

  /** Bevelled box — the bevel catches rim light, which sells "real object". */
  function box(key, size, options = {}) {
    const radius = options.radius ?? Math.min(size[0], size[1], size[2]) * 0.18;
    return add(key, new RoundedBoxGeometry(size[0], size[1], size[2], options.segments ?? 2, radius), options);
  }

  function cylinder(key, radiusTop, radiusBottom, height, options = {}) {
    return add(
      key,
      new THREE.CylinderGeometry(radiusTop, radiusBottom, height, options.radial ?? 20, 1, options.open ?? false),
      options,
    );
  }

  /** Cylinder along an axis ('x' | 'y' | 'z'). */
  function tube(key, radius, length, axis, options = {}) {
    const rotation = axis === "x" ? [0, 0, Math.PI / 2] : axis === "z" ? [Math.PI / 2, 0, 0] : [0, 0, 0];
    return cylinder(key, options.radiusEnd ?? radius, radius, length, { ...options, rotation: options.rotation ?? rotation });
  }

  function sphere(key, radius, options = {}) {
    return add(key, new THREE.SphereGeometry(radius, options.width ?? 20, options.height ?? 14), options);
  }

  function torus(key, radius, tubeRadius, options = {}) {
    return add(key, new THREE.TorusGeometry(radius, tubeRadius, options.radial ?? 10, options.tubular ?? 40), options);
  }

  /**
   * Extrude a side profile (points in the XY plane) by `depth` along Z,
   * centered, with a small bevel.
   */
  function profile(key, points, depth, options = {}) {
    const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
    const bevel = options.bevel ?? Math.min(0.004, depth * 0.15);
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: depth - bevel * 2,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 2,
      curveSegments: options.curveSegments ?? 8,
    });
    geometry.translate(0, 0, -(depth - bevel * 2) / 2);
    return add(key, geometry, options);
  }

  /**
   * Extrude an arbitrary THREE.Shape (holes allowed) by `depth`, centered on
   * Z. Use rotation [-PI/2, 0, 0] to lay it flat (extrusion along +Y).
   */
  function shape(key, shapeDef, depth, options = {}) {
    const bevel = options.bevel ?? Math.min(0.012, depth * 0.2);
    const geometry = new THREE.ExtrudeGeometry(shapeDef, {
      depth: Math.max(0.001, depth - bevel * 2),
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: options.bevelSegments ?? 3,
      curveSegments: options.curveSegments ?? 10,
    });
    geometry.translate(0, 0, -Math.max(0.001, depth - bevel * 2) / 2);
    return add(key, geometry, options);
  }

  function circle(key, radius, options = {}) {
    return add(key, new THREE.CircleGeometry(radius, options.segments ?? 32), options);
  }

  function plane(key, width, height, options = {}) {
    return add(key, new THREE.PlaneGeometry(width, height), options);
  }

  /**
   * @param {Record<string, THREE.Material>} materials
   * @returns {THREE.Group}
   */
  function build(materials, { name = "part-kit", castShadow = false } = {}) {
    const group = new THREE.Group();
    group.name = name;
    for (const [key, geometries] of buckets) {
      const material = materials[key];
      if (!material) {
        console.warn(`[modelKit] No material for "${key}"`);
        continue;
      }
      const merged = mergeGeometries(geometries, false);
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = `${name}:${key}`;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = false;
      group.add(mesh);
      for (const g of geometries) {
        g.dispose();
      }
    }
    return group;
  }

  return { add, box, cylinder, tube, sphere, torus, profile, shape, circle, plane, build };
}

/** Rounded regular polygon path (sides >= 3) for ducts / shells. */
export function roundedPolygon(path, radius, sides, corner, rotation = 0) {
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2;
    pts.push(new THREE.Vector2(Math.cos(a) * radius, Math.sin(a) * radius));
  }
  for (let i = 0; i < sides; i++) {
    const prev = pts[(i + sides - 1) % sides];
    const cur = pts[i];
    const next = pts[(i + 1) % sides];
    const a = cur.clone().sub(prev).normalize().multiplyScalar(-corner).add(cur);
    const b = next.clone().sub(cur).normalize().multiplyScalar(corner).add(cur);
    if (i === 0) {
      path.moveTo(a.x, a.y);
    } else {
      path.lineTo(a.x, a.y);
    }
    path.quadraticCurveTo(cur.x, cur.y, b.x, b.y);
  }
  path.closePath();
  return path;
}

/** Thick ring: outer / inner rounded polygons (sides >= 24 ≈ circle). */
export function ringShape(outer, inner, sides = 6, corner = 0.06, rotation = Math.PI / 6) {
  const s = roundedPolygon(new THREE.Shape(), outer, sides, sides > 12 ? 0.0001 : corner, rotation);
  s.holes.push(roundedPolygon(new THREE.Path(), inner, sides, sides > 12 ? 0.0001 : corner * 0.7, rotation));
  return s;
}
