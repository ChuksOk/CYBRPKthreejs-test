import { BufferAttribute, BufferGeometry, Vector3 } from "three/webgpu";

const _v = new Vector3();

/**
 * CPU-clip a mesh geometry to the world-space slab xMin <= x <= xMax.
 *
 * The city GLB is merged into a handful of huge meshes that span the whole
 * block, so tiling cannot be done by picking meshes. Instead every triangle is
 * clipped against the two slab planes (Sutherland–Hodgman) once at load, and
 * all attributes are interpolated. Output is non-indexed Float32 geometry in
 * the mesh's local space, so the same result can be shared by every tile clone
 * (one BVH, no GPU clipping planes).
 *
 * @param {BufferGeometry} geometry
 * @param {import("three/webgpu").Matrix4} matrixWorld  mesh local → world
 * @param {number} xMin
 * @param {number} xMax
 * @returns {BufferGeometry|null} null when nothing is left inside the slab
 */
export function sliceGeometryX(geometry, matrixWorld, xMin, xMax) {
  const position = geometry.attributes.position;
  if (!position) {
    return null;
  }

  const names = Object.keys(geometry.attributes);
  const attributes = names.map((name) => geometry.attributes[name]);
  const sizes = attributes.map((attribute) => attribute.itemSize);
  const stride = sizes.reduce((sum, size) => sum + size, 0);

  const vertexCount = position.count;
  const worldX = new Float32Array(vertexCount);
  const e = matrixWorld.elements;
  for (let i = 0; i < vertexCount; i++) {
    _v.fromBufferAttribute(position, i);
    worldX[i] = e[0] * _v.x + e[4] * _v.y + e[8] * _v.z + e[12];
  }

  // Packed vertex data (all attributes, dequantized) for fast copy / lerp.
  const packed = new Float32Array(vertexCount * stride);
  for (let i = 0; i < vertexCount; i++) {
    let offset = i * stride;
    for (let a = 0; a < attributes.length; a++) {
      const attribute = attributes[a];
      for (let c = 0; c < sizes[a]; c++) {
        packed[offset++] = attribute.getComponent(i, c);
      }
    }
  }

  const index = geometry.index;
  const triangleCount = index ? index.count / 3 : vertexCount / 3;
  // Growable output buffer — plain arrays of doubles get too big for the city.
  let out = new Float32Array(Math.max(stride * 3, packed.length));
  let outLength = 0;

  const pushVertex = (data) => {
    if (outLength + stride > out.length) {
      const grown = new Float32Array(out.length * 2);
      grown.set(out);
      out = grown;
    }
    for (let k = 0; k < stride; k++) {
      out[outLength++] = data[k];
    }
  };

  const vertexData = (i) => packed.subarray(i * stride, i * stride + stride);

  const lerpVertex = (a, b, t) => {
    const result = new Float32Array(stride);
    for (let k = 0; k < stride; k++) {
      result[k] = a.data[k] + (b.data[k] - a.data[k]) * t;
    }
    return { data: result, x: a.x + (b.x - a.x) * t };
  };

  const clipPolygon = (polygon, keep, planeX) => {
    const result = [];
    for (let i = 0; i < polygon.length; i++) {
      const current = polygon[i];
      const next = polygon[(i + 1) % polygon.length];
      const currentIn = keep(current.x);
      const nextIn = keep(next.x);
      if (currentIn) {
        result.push(current);
      }
      if (currentIn !== nextIn) {
        const t = (planeX - current.x) / (next.x - current.x);
        result.push(lerpVertex(current, next, t));
      }
    }
    return result;
  };

  const insideMin = (x) => x >= xMin;
  const insideMax = (x) => x <= xMax;

  for (let t = 0; t < triangleCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const x0 = worldX[i0];
    const x1 = worldX[i1];
    const x2 = worldX[i2];

    const lo = Math.min(x0, x1, x2);
    const hi = Math.max(x0, x1, x2);
    if (hi < xMin || lo > xMax) {
      continue;
    }

    if (lo >= xMin && hi <= xMax) {
      pushVertex(vertexData(i0));
      pushVertex(vertexData(i1));
      pushVertex(vertexData(i2));
      continue;
    }

    let polygon = [
      { data: vertexData(i0), x: x0 },
      { data: vertexData(i1), x: x1 },
      { data: vertexData(i2), x: x2 },
    ];
    if (lo < xMin) {
      polygon = clipPolygon(polygon, insideMin, xMin);
    }
    if (polygon.length >= 3 && hi > xMax) {
      polygon = clipPolygon(polygon, insideMax, xMax);
    }
    for (let k = 1; k + 1 < polygon.length; k++) {
      pushVertex(polygon[0].data);
      pushVertex(polygon[k].data);
      pushVertex(polygon[k + 1].data);
    }
  }

  if (outLength === 0) {
    return null;
  }

  const outVertexCount = outLength / stride;
  const result = new BufferGeometry();
  let offset = 0;
  for (let a = 0; a < attributes.length; a++) {
    const size = sizes[a];
    const array = new Float32Array(outVertexCount * size);
    for (let v = 0; v < outVertexCount; v++) {
      const base = v * stride + offset;
      for (let c = 0; c < size; c++) {
        array[v * size + c] = out[base + c];
      }
    }
    result.setAttribute(names[a], new BufferAttribute(array, size));
    offset += size;
  }

  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}
