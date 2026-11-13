// Small modelling kit shared by scene.js and space.js: profiles turned on a lathe, tubes along
// curves, displaced blobs, and helpers that keep UVs at a steady scale.
//
// UV convention: lathes, tubes and rods are scaled so one UV unit is about one metre; boxUV does the
// same for hard-surface parts by projecting along each face's dominant axis. Surfaces that already
// carried a texture one-tile-per-face (desk tops, chair fabric, solar wings) keep that mapping.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _n = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// Transform a geometry into a mergeable, non-indexed piece (same contract as scene.js `part`).
export function part(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  g.clearGroups();
  g.applyMatrix4(new THREE.Matrix4().compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz)));
  return g;
}
export const merge = (parts) => mergeGeometries(parts, false);
export const RB = (w, h, d, r = 0.02, seg = 1) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2, h / 2, d / 2));

export function uvScale(g, su, sv = su) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return g;
}

// Planar UVs per triangle along its dominant axis: k UV units per metre, no stretching on any side.
export function boxUV(geo, k = 1) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position, uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i += 3) {
    _a.fromBufferAttribute(p, i); _b.fromBufferAttribute(p, i + 1); _c.fromBufferAttribute(p, i + 2);
    _n.subVectors(_b, _a).cross(_c.sub(_a));
    const ax = Math.abs(_n.x), ay = Math.abs(_n.y), az = Math.abs(_n.z);
    for (let j = i; j < i + 3; j++) {
      const x = p.getX(j), y = p.getY(j), z = p.getZ(j);
      if (ax >= ay && ax >= az) { uv[j * 2] = z * k; uv[j * 2 + 1] = y * k; }
      else if (ay >= az) { uv[j * 2] = x * k; uv[j * 2 + 1] = z * k; }
      else { uv[j * 2] = x * k; uv[j * 2 + 1] = y * k; }
    }
  }
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

// Turn a profile of [radius, height] pairs round the Y axis. List the points bottom to top for a
// surface that faces outwards (top to bottom for the inside of a bowl). Neighbouring segments
// share a normal, so a short segment between two long ones reads as a bevel; a third entry
// ([r, y, 1]) marks a crisp corner instead.
export function lathe(profile, seg = 24, phi0 = 0, arc = Math.PI * 2) {
  const pts = profile.flatMap(([r, y, hard]) => { const v = new THREE.Vector2(Math.max(r, 1e-4), y); return hard ? [v, v.clone()] : [v]; });
  let len = 0, rMax = 0;
  for (let i = 0; i < pts.length; i++) { if (i) len += pts[i].distanceTo(pts[i - 1]); rMax = Math.max(rMax, pts[i].x); }
  return uvScale(new THREE.LatheGeometry(pts, seg, phi0, arc), rMax * arc, len);
}

// A round tube through the given [x, y, z] points.
export function tube(points, radius, seg = 12, radial = 6, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])), closed, 'centripetal');
  return uvScale(new THREE.TubeGeometry(curve, seg, radius, radial, closed), curve.getLength(), Math.PI * 2 * radius);
}

// A straight (optionally tapered) rod from a to b.
export function rod(a, b, r0, r1 = r0, radial = 6, capped = false) {
  _a.set(a[0], a[1], a[2]); _b.set(b[0], b[1], b[2]);
  const len = _n.subVectors(_b, _a).length();
  const g = uvScale(new THREE.CylinderGeometry(r1, r0, len, radial, 1, !capped), Math.PI * 2 * Math.max(r0, r1), len);
  g.applyQuaternion(_q.setFromUnitVectors(UP, _n.normalize()));
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return g;
}

// Scale x/z by a function of height (e.g. flatten a lathed torso front to back) and keep the
// normals right for the new shape.
export function shapeXZ(g, fn) {
  const p = g.attributes.position, n = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const [sx, sz] = fn(p.getY(i), p.getX(i), p.getZ(i));
    p.setXYZ(i, p.getX(i) * sx, p.getY(i), p.getZ(i) * sz);
    _n.set(n.getX(i) / sx, n.getY(i), n.getZ(i) / sz).normalize();
    n.setXYZ(i, _n.x, _n.y, _n.z);
  }
  return g;
}

// ---- seeded value noise
function hash3(x, y, z) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1440662683)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const mix = (a, b, t) => a + (b - a) * t;
export function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let fx = x - xi, fy = y - yi, fz = z - zi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  return mix(
    mix(mix(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), fx), mix(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), fx), fy),
    mix(mix(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), fx), mix(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), fx), fy), fz);
}
// 0..1, several octaves
export function fbm3(x, y, z, oct = 3) {
  let a = 0.5, s = 0, n = 0;
  for (let o = 0; o < oct; o++) { s += a * noise3(x, y, z); n += a; x = x * 2.03 + 1.7; y = y * 2.03 + 9.2; z = z * 2.03 + 3.1; a *= 0.5; }
  return s / n;
}

// Recompute smooth normals on a non-indexed geometry by welding vertices that share a position.
export function smoothNormals(g) {
  const p = g.attributes.position;
  const ids = new Int32Array(p.count), acc = [], seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${Math.round(p.getX(i) * 2e3)},${Math.round(p.getY(i) * 2e3)},${Math.round(p.getZ(i) * 2e3)}`;
    let k = seen.get(key);
    if (k === undefined) { k = acc.length; seen.set(key, k); acc.push(new THREE.Vector3()); }
    ids[i] = k;
  }
  for (let i = 0; i < p.count; i += 3) {
    _a.fromBufferAttribute(p, i); _b.fromBufferAttribute(p, i + 1); _c.fromBufferAttribute(p, i + 2);
    _n.subVectors(_b, _a).cross(_c.sub(_a)); // area-weighted
    acc[ids[i]].add(_n); acc[ids[i + 1]].add(_n); acc[ids[i + 2]].add(_n);
  }
  const nor = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { _n.copy(acc[ids[i]]).normalize(); nor[i * 3] = _n.x; nor[i * 3 + 1] = _n.y; nor[i * 3 + 2] = _n.z; }
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

// A unit sphere pushed in and out by seeded noise, shaded smooth: tree canopies, bushes, rocks.
// `puff` adds leafy clumps; `shape(dir, f)` may return an adjusted radius (craters, flat spots).
export function blob(detail, seed, { amp = 0.22, freq = 1.5, oct = 3, puff = 0, puffFreq = 3, sx = 1, sy = 1, sz = 1, shape = null } = {}) {
  const g = new THREE.IcosahedronGeometry(1, detail); // non-indexed, with seam-corrected spherical UVs
  const p = g.attributes.position;
  const ox = seed * 7.13, oy = seed * 3.71, oz = seed * 5.37;
  for (let i = 0; i < p.count; i++) {
    _v.fromBufferAttribute(p, i).normalize();
    let f = 1 + amp * (fbm3(_v.x * freq + ox, _v.y * freq + oy, _v.z * freq + oz, oct) * 2 - 1);
    // puffs: rounded bumps meeting in sharp creases, like clumps of leaves
    if (puff) f += puff * (Math.min(1, Math.abs(fbm3(_v.x * puffFreq - oz, _v.y * puffFreq + ox, _v.z * puffFreq + oy, 2) * 2 - 1) * 3) - 0.5);
    if (shape) f = shape(_v, f);
    p.setXYZ(i, _v.x * f * sx, _v.y * f * sy, _v.z * f * sz);
  }
  smoothNormals(g);
  return uvScale(g, 6, 3);
}

export function mapUV(g, fn) {
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) { const [u, v] = fn(p.getX(i), p.getY(i), p.getZ(i)); uv.setXY(i, u, v); }
  return g;
}

// Rounded rectangle outline (also usable as a hole).
export function rrShape(w, h, r, cx = 0, cy = 0) {
  const s = new THREE.Shape(), x = cx - w / 2, y = cy - h / 2, q = Math.PI / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -q, 0, false);
  s.lineTo(x + w, y + h - r); s.absarc(x + w - r, y + h - r, r, 0, q, false);
  s.lineTo(x + r, y + h); s.absarc(x + r, y + h - r, r, q, q * 2, false);
  s.lineTo(x, y + r); s.absarc(x + r, y + r, r, q * 2, q * 3, false);
  return s;
}

// Turn a non-indexed piece inside out.
export function flip(g) {
  for (const k of ['position', 'normal', 'uv']) {
    const a = g.attributes[k], n = a.itemSize, arr = a.array;
    for (let i = 0; i < a.count; i += 3) {
      for (let c = 0; c < n; c++) { const t = arr[(i + 1) * n + c]; arr[(i + 1) * n + c] = arr[(i + 2) * n + c]; arr[(i + 2) * n + c] = t; }
    }
  }
  const nor = g.attributes.normal.array;
  for (let i = 0; i < nor.length; i++) nor[i] = -nor[i];
  return g;
}

// Flat end face for a lathe that only sweeps part of a turn: the profile itself, stood at angle phi.
export function latheCap(profile, phi, far = false) {
  const g = new THREE.ShapeGeometry(new THREE.Shape(profile.map(([r, y]) => new THREE.Vector2(r, y))));
  const p = part(g, 0, 0, 0, 0, phi - Math.PI / 2);
  return far ? flip(p) : p;
}

// Bake a rotation about Y into a piece (for parts laid out in a holder's local frame).
export const spunY = (g, a) => g.clone().rotateY(a);
