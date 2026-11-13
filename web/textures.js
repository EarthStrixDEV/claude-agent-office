// Procedural textures, drawn once at start-up: no image downloads.
//
// Surfaces come as PBR sets { map, normalMap, roughnessMap?, aoMap?, metalnessMap? }. Each set is
// built from one height field: the albedo is painted on a canvas, the normal map is a Sobel of the
// height, and roughness / occlusion / metalness are packed into one "ORM" texture (R = occlusion,
// G = roughness, B = metalness: the channels three.js reads), at half size because nobody can see
// roughness at full resolution.
import * as THREE from 'three';

export function rng(seed = 1) {
  let s = (seed >>> 0) || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// Sizes below are written for Ultra. Standard halves every side, a quarter of the memory and of the
// start-up work. Textures are built before createOffice() knows the tier, so this reads the same
// setting app.js does; switching tier in the panel takes effect on the next load.
function wantsUltra() {
  try {
    const q = localStorage.getItem('office-quality');
    if (q === 'ultra' || q === 'standard') return q === 'ultra';
  } catch { /* storage blocked: fall through to the default */ }
  return !(matchMedia('(pointer: coarse)').matches || innerWidth < 860);
}
export const HI = wantsUltra();
const S = HI ? 1 : 0.5;
const px = (n) => Math.max(1, Math.round(n * S));
const TAU = Math.PI * 2;

function make(w, h, draw, { repeat = [1, 1], srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 8;
  return t;
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ------------------------------------------------------------ toolkit
// A canvas of bw x bh "Ultra pixels": drawing code always works in those units.
function paint(bw, bh, read = false) {
  const c = document.createElement('canvas');
  c.width = px(bw); c.height = px(bh);
  const ctx = c.getContext('2d', read ? { willReadFrequently: true } : undefined);
  ctx.scale(c.width / bw, c.height / bh);
  return ctx;
}

function tune(t, repeat, srgb) {
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 8;
  return t;
}
const colorTex = (ctx, repeat) => tune(new THREE.CanvasTexture(ctx.canvas), repeat, true);
const dataCanvasTex = (ctx, repeat) => tune(new THREE.CanvasTexture(ctx.canvas), repeat, false);
function bytesTex(bytes, w, h, repeat) {
  const t = new THREE.DataTexture(bytes, w, h, THREE.RGBAFormat);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return tune(t, repeat, false);
}

// Tileable fbm value noise in 0..1. The lattice has cx x cy cells in the first octave, so a
// lopsided lattice gives stretched noise (wood fibres, bark furrows) with no resampling.
function fbm(w, h, cx, cy, octaves, seed) {
  const out = new Float32Array(w * h), r = rng(seed);
  cx = Math.min(cx, w >> 1); cy = Math.min(cy, h >> 1); // Standard halves the canvas: stay under Nyquist
  let amp = 0.5, total = 0;
  for (let o = 0; o < octaves && cx <= w / 2 && cy <= h / 2; o++, cx *= 2, cy *= 2, amp *= 0.5) {
    const lat = new Float32Array(cx * cy);
    for (let i = 0; i < lat.length; i++) lat[i] = r();
    const x0 = new Int32Array(w), x1 = new Int32Array(w), wx = new Float32Array(w);
    for (let x = 0; x < w; x++) { const f = (x / w) * cx, i = Math.floor(f), t = f - i; x0[x] = i; x1[x] = (i + 1) % cx; wx[x] = t * t * (3 - 2 * t); }
    for (let y = 0, k = 0; y < h; y++) {
      const f = (y / h) * cy, i = Math.floor(f), t = f - i, wy = t * t * (3 - 2 * t);
      const r0 = i * cx, r1 = ((i + 1) % cy) * cx;
      for (let x = 0; x < w; x++, k++) {
        const a = lat[r0 + x0[x]], c = lat[r1 + x0[x]], u = wx[x];
        const top = a + (lat[r0 + x1[x]] - a) * u, bot = c + (lat[r1 + x1[x]] - c) * u;
        out[k] += (top + (bot - top) * wy) * amp;
      }
    }
    total += amp;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

// One channel of a canvas as floats in 0..1.
function channel(ctx, ch = 0) {
  const { width: w, height: h } = ctx.canvas;
  const d = ctx.getImageData(0, 0, w, h).data, f = new Float32Array(w * h);
  for (let i = 0, k = ch; i < f.length; i++, k += 4) f[i] = d[k] / 255;
  return f;
}

// Wrap-around box blur, r in real pixels.
function blur(src, w, h, r) {
  r = Math.max(1, Math.round(r));
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + ((k + w) % w)];
    for (let x = 0; x < w; x++) { tmp[row + x] = sum * inv; sum += src[row + ((x + r + 1) % w)] - src[row + ((x - r + w) % w)]; }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[((k + h) % h) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = sum * inv; sum += tmp[((y + r + 1) % h) * w + x] - tmp[((y - r + h) % h) * w + x]; }
  }
  return out;
}

// Height field (0..1, row 0 at the top like a canvas) -> tangent-space normal map. Sobel with
// wrap-around, so the normal map tiles exactly like its height. `strength` is resolution-free.
function normalTex(hf, w, h, strength, repeat) {
  const out = new Uint8Array(w * h * 4), k = strength * S * 0.5;
  for (let y = 0; y < h; y++) {
    const ym = ((y + h - 1) % h) * w, y0 = y * w, yp = ((y + 1) % h) * w;
    let o = (h - 1 - y) * w * 4; // data textures are bottom-up
    // slide a 3x3 window along the row: a = left column, b = centre, c = right (top, middle, bottom)
    let a0 = hf[ym + w - 1], a1 = hf[y0 + w - 1], a2 = hf[yp + w - 1], b0 = hf[ym], b2 = hf[yp];
    for (let x = 0; x < w; x++, o += 4) {
      const xp = x + 1 === w ? 0 : x + 1, c0 = hf[ym + xp], c1 = hf[y0 + xp], c2 = hf[yp + xp];
      const gx = (c0 + 2 * c1 + c2 - a0 - 2 * a1 - a2) * k, gy = (a2 + 2 * b2 + c2 - a0 - 2 * b0 - c0) * k;
      const inv = 127.5 / Math.sqrt(gx * gx + gy * gy + 1);
      out[o] = 128 - gx * inv; out[o + 1] = 128 + gy * inv; out[o + 2] = 128 + inv; out[o + 3] = 255;
      a0 = b0; a1 = hf[y0 + x]; a2 = b2; b0 = c0; b2 = c2;
    }
  }
  return bytesTex(out, w, h, repeat);
}

// Pack occlusion / roughness / metalness (each a field or a constant) into one half-size texture.
function ormTex(w, h, ao, rough, metal, repeat) {
  const hw = w >> 1, hh = h >> 1, out = new Uint8Array(hw * hh * 4);
  const chans = [ao, rough, metal];
  for (let c = 0; c < 3; c++) {
    const f = chans[c];
    if (typeof f === 'number') { const v = Math.round(f * 255); for (let i = c; i < out.length; i += 4) out[i] = v; continue; }
    for (let y = 0; y < hh; y++) {
      let o = (hh - 1 - y) * hw * 4 + c;
      const a = y * 2 * w, b = a + w;
      for (let x = 0; x < hw; x++, o += 4) { const i = x * 2; out[o] = Math.min(1, Math.max(0, (f[a + i] + f[a + i + 1] + f[b + i] + f[b + i + 1]) * 0.25)) * 255; }
    }
  }
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return bytesTex(out, hw, hh, repeat);
}

// Where to repeat a shape of radius s centred at x so that it wraps round a tile of size B.
const wraps = (x, s, B) => (x < s ? [0, B] : x > B - s ? [0, -B] : [0]);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------ office surfaces
// Light birch desk top: five glued boards with long grain. Pores and seams sit lower and rougher.
function makeWood() {
  const w = px(1024), h = px(512), r = rng(7), repeat = [1, 1];
  const fibre = fbm(w, h, 3, 64, 3, 71), warp = fbm(w, h, 2, 4, 2, 72), pore = fbm(w, h, 12, 256, 2, 73);
  const BOARDS = 5, bh = h / BOARDS;
  const boards = Array.from({ length: BOARDS }, () => ({ shift: Math.floor(r() * w), tone: 0.94 + r() * 0.1, bands: 2 + r() * 3, ph: r() * TAU, warm: r() }));
  const ctx = paint(1024, 512, true), img = ctx.createImageData(w, h), d = img.data;
  const hf = new Float32Array(w * h), rough = new Float32Array(w * h), ao = new Float32Array(w * h);
  for (let y = 0, k = 0; y < h; y++) {
    const bi = Math.min(BOARDS - 1, Math.floor(y / bh)), b = boards[bi], fv = y / bh - bi;
    const seam = 1 - smooth(0, 2.2 * S, Math.min(fv, 1 - fv) * bh);
    for (let x = 0; x < w; x++, k++) {
      const s = y * w + ((x + b.shift) % w);
      const line = smooth(0.5, 0.72, fibre[s]), p = pore[s];
      const band = 0.5 + 0.5 * Math.sin((fv * b.bands + warp[s] * 5) * TAU + b.ph);
      const tone = b.tone * (1 - 0.13 * line - 0.05 * band - 0.05 * (p - 0.5)) * (1 - 0.45 * seam);
      const dark = line * 0.5 + band * 0.2;
      d[k * 4] = (236 - 18 * dark - 6 * b.warm) * tone;
      d[k * 4 + 1] = (214 - 30 * dark - 4 * b.warm) * tone;
      d[k * 4 + 2] = (184 - 44 * dark - 12 * b.warm) * tone;
      d[k * 4 + 3] = 255;
      hf[k] = 0.7 - 0.22 * line - 0.2 * smooth(0.55, 0.8, p) - 0.6 * seam;
      rough[k] = 0.4 + 0.2 * line + 0.12 * (p - 0.5) + 0.35 * seam;
      ao[k] = 1 - 0.6 * seam;
    }
  }
  ctx.putImageData(img, 0, 0);
  const orm = ormTex(w, h, ao, rough, 0, repeat);
  return { map: colorTex(ctx, repeat), normalMap: normalTex(hf, w, h, 1.6, repeat), roughnessMap: orm, aoMap: orm };
}

// Cream terrazzo with pastel chips, like a Minju City plaza. The chips are polished and stand a
// hair proud of the binder; the binder is finely pitted.
function makeTerrazzo() {
  const B = 1024, n = px(B), r = rng(11), repeat = [14, 14];
  const col = paint(B, B), mask = paint(B, B, true);
  col.fillStyle = '#F1E9DE'; col.fillRect(0, 0, B, B);
  mask.fillStyle = '#000'; mask.fillRect(0, 0, B, B);
  for (const sand of ['rgba(255,255,255,0.14)', 'rgba(150,128,104,0.08)']) { // sand in the binder
    col.fillStyle = sand; col.beginPath();
    for (let i = 0; i < 2500; i++) col.rect(r() * B, r() * B, 2 + r() * 3, 2 + r() * 3);
    col.fill();
  }
  const chips = ['#FF8FB8', '#FFD86B', '#7CC4F5', '#B9A8F0', '#8FDDB8', '#E2D3C2', '#CDBDAA', '#FFB070'];
  for (let i = 0; i < 1700; i++) {
    const x = r() * B, y = r() * B, s = 3 + r() * (r() < 0.1 ? 14 : 7);
    const fill = chips[Math.floor(r() * chips.length)], alpha = 0.4 + r() * 0.5;
    const k = 3 + Math.floor(r() * 3), pts = [];
    for (let j = 0; j < k; j++) { const a = (j / k) * TAU + r(); pts.push([Math.cos(a) * s, Math.sin(a) * s]); }
    for (const ox of wraps(x, s, B)) for (const oy of wraps(y, s, B)) {
      col.globalAlpha = alpha; col.fillStyle = fill; mask.fillStyle = '#fff';
      for (const c of [col, mask]) { c.beginPath(); for (const [dx, dy] of pts) c.lineTo(x + ox + dx, y + oy + dy); c.fill(); }
    }
  }
  const chip = channel(mask), gn = n >> 2, grit = fbm(gn, gn, 32, 32, 2, 12); // grit is fine enough to reuse a quarter-size tile
  const hf = new Float32Array(n * n), rough = new Float32Array(n * n);
  for (let y = 0, i = 0; y < n; y++) for (let x = 0; x < n; x++, i++) {
    const c = chip[i], g = grit[(y % gn) * gn + (x % gn)];
    hf[i] = c * 0.55 + (1 - c) * g * 0.35;
    rough[i] = 0.24 + (1 - c) * (0.3 + (g - 0.5) * 0.3);
  }
  return { map: colorTex(col, repeat), normalMap: normalTex(hf, n, n, 0.9, repeat), roughnessMap: ormTex(n, n, 1, rough, 0, repeat) };
}

// Lawn: blades lean one way so the relief has a direction, colour drifts in patches. The blades
// are rasterised straight into the height field (tallest wins), which is far quicker than asking a
// canvas for fifteen thousand strokes.
function makeGrass() {
  const n = px(1024), r = rng(5), repeat = [18, 18];
  const hf = new Float32Array(n * n).fill(0.1), id = new Uint16Array(n * n); // id 0: thatch between the blades
  const N = 15000, tint = new Float32Array((N + 1) * 3);
  tint.set([128, 184, 124]);
  for (let b = 1; b <= N; b++) {
    const x = r() * n, y = r() * n, len = (9 + r() * 20) * S, lean = (r() - 0.35) * 9 * S, half = (0.4 + r() * 1.3) * S, top = 0.3 + r() * 0.7;
    const a = 0.3 + r() * 0.35; // how much of the blade's own green shows over the lawn colour
    tint.set([158 + (r() * 50 - 88) * a, 214 + (r() * 70 - 64) * a, 154 + (r() * 40 - 74) * a], b * 3);
    for (let t = 0; t <= len; t++) {
      const f = t / len, lv = top * (0.5 + 0.5 * f), wi = Math.round(half * (1 - 0.7 * f)); // taller and thinner towards the tip
      const row = (((Math.round(y - t) % n) + n) % n) * n, cx = Math.round(x + lean * f);
      for (let dx = -wi; dx <= wi; dx++) {
        const k = row + (((cx + dx) % n) + n) % n;
        if (lv > hf[k]) { hf[k] = lv; id[k] = b; }
      }
    }
  }
  const patch = fbm(n, n, 3, 3, 2, 51);
  const ctx = paint(1024, 1024, true), img = ctx.createImageData(n, n), d = img.data;
  for (let i = 0, k = 0; i < hf.length; i++, k += 4) {
    const p = patch[i], t = id[i] * 3, lum = (0.86 + 0.26 * p) * (0.84 + 0.24 * hf[i]); // drier and lighter in patches, darker low down
    d[k] = (tint[t] + (p - 0.5) * 46) * lum;
    d[k + 1] = tint[t + 1] * lum;
    d[k + 2] = (tint[t + 2] - (p - 0.5) * 26) * lum;
    d[k + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { map: colorTex(ctx, repeat), normalMap: normalTex(hf, n, n, 1.2, repeat) };
}

// Near-white plain weave, tinted by the material colour: warp and weft threads go over and under.
function makeFabric() {
  const n = px(256), T = 16, cell = n / T, repeat = [3, 3], r = rng(21);
  const ctx = paint(256, 256, true), img = ctx.createImageData(n, n), d = img.data, hf = new Float32Array(n * n);
  const fuzz = fbm(n, n, 64, 64, 2, 22), tone = Array.from({ length: T * 2 }, () => 0.96 + r() * 0.04);
  for (let y = 0, k = 0; y < n; y++) {
    const cy = Math.floor(y / cell), fy = y / cell - cy, sy = Math.sin(Math.PI * fy);
    for (let x = 0; x < n; x++, k++) {
      const cx = Math.floor(x / cell), fx = x / cell - cx, sx = Math.sin(Math.PI * fx);
      const warp = (cx + cy) % 2 === 0; // which thread is on top in this cell
      const v = (warp ? (0.5 + 0.5 * sy) * Math.sqrt(sx) : (0.5 + 0.5 * sx) * Math.sqrt(sy)) * 0.9 + fuzz[k] * 0.1;
      hf[k] = v;
      const c = (190 + 62 * v) * tone[warp ? cx : T + cy];
      d[k * 4] = d[k * 4 + 1] = d[k * 4 + 2] = c; d[k * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { map: colorTex(ctx, repeat), normalMap: normalTex(hf, n, n, 1.5, repeat) };
}

// Island rock: sedimentary layers of different hardness, bent a little, grained and runnelled.
// Soft layers are recessed, darker and occluded; hard ones stand out and are a touch smoother.
function makeRock() {
  const n = px(512), r = rng(3), repeat = [16, 3];
  const LUT = 1024, level = new Float32Array(LUT), tint = new Float32Array(LUT);
  for (let i = 0, lv = r(), tv = r(); i < LUT;) { // random-width layers
    const len = Math.floor(30 + r() * 110), nl = r() < 0.5 ? r() * 0.4 : 0.6 + r() * 0.4, nt = r();
    for (let j = 0; j < len && i < LUT; j++, i++) { const t = smooth(0, 10, j); level[i] = lv + (nl - lv) * t; tint[i] = tv + (nt - tv) * t; }
    lv = nl; tv = nt;
  }
  for (let j = 0; j < 12; j++) { const t = j / 12, i = LUT - 12 + j; level[i] += (level[0] - level[i]) * t; tint[i] += (tint[0] - tint[i]) * t; } // close the loop
  const bend = fbm(n, n, 3, 2, 2, 31), grain = fbm(n, n, 24, 24, 3, 32), runnel = fbm(n, n, 28, 2, 2, 33);
  const hf = new Float32Array(n * n), tn = new Float32Array(n * n);
  for (let y = 0, k = 0; y < n; y++) for (let x = 0; x < n; x++, k++) {
    const v = y / n + (bend[k] - 0.5) * 0.16, i = Math.floor((v - Math.floor(v)) * LUT) % LUT;
    hf[k] = clamp01(level[i] * 0.6 + grain[k] * 0.3 + runnel[k] * 0.16); // rain has cut faint channels down the face
    tn[k] = tint[i];
  }
  const wide = blur(hf, n, n, 6 * S);
  const ctx = paint(512, 512, true), img = ctx.createImageData(n, n), d = img.data;
  const ao = new Float32Array(n * n), rough = new Float32Array(n * n);
  for (let k = 0; k < hf.length; k++) {
    const a = clamp01(1 - (wide[k] - hf[k]) * 2.6), t = tn[k], g = grain[k];
    const lum = (0.84 + 0.16 * hf[k] + 0.12 * (g - 0.5)) * (0.76 + 0.24 * a);
    // pink rock drifting to cream (t high) and mauve (t low)
    d[k * 4] = Math.min(255, (228 + 20 * t) * lum);
    d[k * 4 + 1] = Math.min(255, (180 + 38 * t) * lum);
    d[k * 4 + 2] = Math.min(255, (206 - 4 * t) * lum);
    d[k * 4 + 3] = 255;
    ao[k] = a;
    rough[k] = 0.96 - 0.2 * hf[k] + 0.1 * (g - 0.5);
  }
  ctx.putImageData(img, 0, 0);
  const orm = ormTex(n, n, ao, rough, 0, repeat);
  return { map: colorTex(ctx, repeat), normalMap: normalTex(hf, n, n, 2.2, repeat), roughnessMap: orm, aoMap: orm };
}

// Round rug under Minju's desk. Its pile is a small noise normal map repeated many times.
function makeRug() {
  const B = 512, n = px(B), repeat = [1, 1];
  const ctx = paint(B, B, true), c = B / 2;
  const rings = ['#FFE1EC', '#FFD0E0', '#FFE9F2', '#FFC4D8', '#FFF4F8', '#FFD6E5'];
  for (let i = 0; i < 12; i++) {
    ctx.fillStyle = rings[i % rings.length];
    ctx.beginPath(); ctx.arc(c, c, c - i * 20, 0, TAU); ctx.fill();
  }
  ctx.strokeStyle = 'rgba(200,50,95,0.18)'; ctx.lineWidth = 3;
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * TAU;
    ctx.beginPath(); ctx.moveTo(c + Math.cos(a) * 60, c + Math.sin(a) * 60); ctx.lineTo(c + Math.cos(a) * 240, c + Math.sin(a) * 240); ctx.stroke();
  }
  const tuft = fbm(n, n, 128, 128, 2, 9), img = ctx.getImageData(0, 0, n, n), d = img.data;
  for (let i = 0, k = 0; i < tuft.length; i++, k += 4) { const l = 0.93 + tuft[i] * 0.1; d[k] = Math.min(255, d[k] * l); d[k + 1] *= l; d[k + 2] *= l; }
  ctx.putImageData(img, 0, 0);
  const m = px(256);
  return { map: colorTex(ctx, repeat), normalMap: normalTex(fbm(m, m, 32, 32, 3, 10), m, m, 3, [28, 28]) };
}

function makeKeyboard() {
  const BW = 512, BH = 176, w = px(BW), h = px(BH), repeat = [1, 1];
  const col = paint(BW, BH), hgt = paint(BW, BH, true);
  col.fillStyle = '#DDE0E7'; col.fillRect(0, 0, BW, BH);
  hgt.fillStyle = '#000'; hgt.fillRect(0, 0, BW, BH);
  const rows = 5, kh = (BH - 16) / rows;
  for (let r = 0; r < rows; r++) {
    let x = 8 + (r % 2) * 10;
    const y = 8 + r * kh;
    while (x < BW - 20) {
      const kw = r === 4 && x > 120 && x < 300 ? 180 : 28;
      col.fillStyle = '#C3C8D2'; roundRect(col, x, y + 3, kw - 4, kh - 4, 5); col.fill();
      col.fillStyle = '#F7F8FA'; roundRect(col, x, y, kw - 4, kh - 6, 5); col.fill();
      hgt.fillStyle = '#8A8A8A'; roundRect(hgt, x, y, kw - 4, kh - 3, 5); hgt.fill();
      hgt.fillStyle = '#FFFFFF'; roundRect(hgt, x + 3, y + 2, kw - 10, kh - 11, 4); hgt.fill();
      x += kw;
    }
  }
  return { map: colorTex(col, repeat), normalMap: normalTex(blur(channel(hgt), w, h, 1.5 * S), w, h, 2.5, repeat) };
}

// Tree bark: furrows running up the trunk. Colour is baked in, so the material stays white.
function makeBark() {
  const n = px(256), repeat = [2, 2];
  const furrow = fbm(n, n, 14, 2, 4, 41), grain = fbm(n, n, 32, 32, 2, 42);
  const ctx = paint(256, 256, true), img = ctx.createImageData(n, n), d = img.data, hf = new Float32Array(n * n);
  for (let k = 0; k < hf.length; k++) {
    const ridge = 1 - Math.abs(furrow[k] * 2 - 1) * 1.6; // plates with deep gaps between them
    const v = clamp01(ridge * 0.8 + grain[k] * 0.2);
    hf[k] = v;
    const l = 0.78 + 0.32 * v;
    d[k * 4] = Math.min(255, 196 * l); d[k * 4 + 1] = Math.min(255, 146 * l); d[k * 4 + 2] = Math.min(255, 106 * l); d[k * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { map: colorTex(ctx, repeat), normalMap: normalTex(hf, n, n, 2.2, repeat) };
}

// Foliage: overlapping leaves in near-white, because the material colour follows the time of day.
function makeLeaf() {
  const B = 512, n = px(B), r = rng(61), repeat = [3, 2];
  const col = paint(B, B), hgt = paint(B, B, true);
  col.fillStyle = '#D9E0D5'; col.fillRect(0, 0, B, B);
  hgt.fillStyle = '#000'; hgt.fillRect(0, 0, B, B);
  const N = 850;
  for (let i = 0; i < N; i++) {
    const x = r() * B, y = r() * B, len = 13 + r() * 13, wid = len * (0.42 + r() * 0.2), a = r() * TAU;
    const l = 222 + r() * 33, warm = r() * 16, top = 90 + (i / N) * 165;
    for (const ox of wraps(x, len, B)) for (const oy of wraps(y, len, B)) {
      for (const c of [col, hgt]) { c.save(); c.translate(x + ox, y + oy); c.rotate(a); }
      col.fillStyle = 'rgba(70,95,70,0.2)'; // shadow on the leaves underneath
      col.beginPath(); col.ellipse(1.5, 2.5, len, wid, 0, 0, TAU); col.fill();
      col.fillStyle = `rgb(${l - 12 + warm},${l},${l - 20})`;
      col.beginPath(); col.ellipse(0, 0, len, wid, 0, 0, TAU); col.fill();
      col.strokeStyle = 'rgba(255,255,255,0.35)'; col.lineWidth = 1.2;
      col.beginPath(); col.moveTo(-len * 0.85, 0); col.lineTo(len * 0.85, 0); col.stroke();
      hgt.scale(1, wid / len);
      const g = hgt.createRadialGradient(0, 0, 0, 0, 0, len);
      g.addColorStop(0, `rgb(${top},${top},${top})`); g.addColorStop(1, `rgb(${top * 0.55},${top * 0.55},${top * 0.55})`);
      hgt.fillStyle = g; hgt.beginPath(); hgt.arc(0, 0, len, 0, TAU); hgt.fill();
      col.restore(); hgt.restore();
    }
  }
  return { map: colorTex(col, repeat), normalMap: normalTex(blur(channel(hgt), n, n, 1), n, n, 2.4, repeat) };
}

// ------------------------------------------------------------ space surfaces
// Station hull: rows of plates with seams and rivets; each plate has its own tint and sheen.
function makeHull() {
  const B = 512, n = px(B), r = rng(88), repeat = [2, 2];
  const col = paint(B, B), hgt = paint(B, B, true), orm = paint(B, B);
  col.fillStyle = '#D0D2DA'; col.fillRect(0, 0, B, B);
  hgt.fillStyle = '#000'; hgt.fillRect(0, 0, B, B);
  orm.fillStyle = 'rgb(120,150,0)'; orm.fillRect(0, 0, B, B); // seams: occluded
  const tints = [[232, 233, 238], [226, 230, 238], [236, 233, 228], [222, 224, 230], [240, 240, 243]];
  const rowH = [112, 144, 96, 160];
  for (let row = 0, y = 0; row < rowH.length; y += rowH[row++]) {
    for (let x = Math.floor(r() * 4) * 32, end = x + B; x < end;) {
      const pw = Math.min(end - x, 96 + Math.floor(r() * 4) * 32), ph = rowH[row];
      const t = tints[Math.floor(r() * tints.length)], l = 0.94 + r() * 0.06, rough = Math.round(95 + r() * 60);
      for (const ox of [0, -B]) {
        const X = x + ox;
        col.fillStyle = `rgb(${t[0] * l},${t[1] * l},${t[2] * l})`; col.fillRect(X + 1.5, y + 1.5, pw - 3, ph - 3);
        hgt.fillStyle = '#909090'; hgt.fillRect(X + 1.5, y + 1.5, pw - 3, ph - 3);
        orm.fillStyle = `rgb(255,${rough},0)`; orm.fillRect(X + 2.5, y + 2.5, pw - 5, ph - 5);
        for (let i = 0; i < 2; i++) { // rivets along the two long edges
          const ry = i ? y + ph - 9 : y + 9;
          for (let rx = X + 12; rx < X + pw - 6; rx += 24) {
            hgt.fillStyle = '#FFFFFF'; hgt.beginPath(); hgt.arc(rx, ry, 3, 0, TAU); hgt.fill();
            col.fillStyle = 'rgba(120,125,140,0.35)'; col.beginPath(); col.arc(rx, ry + 0.8, 2.8, 0, TAU); col.fill();
          }
        }
      }
      x += pw;
    }
  }
  const o = dataCanvasTex(orm, repeat);
  return { map: colorTex(col, repeat), normalMap: normalTex(blur(channel(hgt), n, n, 1), n, n, 2, repeat), roughnessMap: o, aoMap: o };
}

// Solar array blanket: glassy blue cells in a silver frame. Busbars and frame are rougher metal.
function makeSolar() {
  const BW = 256, BH = 512, w = px(BW), h = px(BH), r = rng(8), repeat = [1, 1];
  const col = paint(BW, BH), hgt = paint(BW, BH, true), orm = paint(BW, BH);
  col.fillStyle = '#C9CED8'; col.fillRect(0, 0, BW, BH);
  hgt.fillStyle = '#000'; hgt.fillRect(0, 0, BW, BH);
  orm.fillStyle = 'rgb(170,125,235)'; orm.fillRect(0, 0, BW, BH); // frame
  const cols = 4, rows = 16, pad = 6, gap = 3;
  const cw = (BW - pad * 2 - gap * (cols - 1)) / cols, ch = (BH - pad * 2 - gap * (rows - 1)) / rows;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const X = pad + x * (cw + gap), Y = pad + y * (ch + gap), l = 16 + r() * 10;
      const g = col.createLinearGradient(X, Y, X + cw, Y + ch);
      g.addColorStop(0, `hsl(222,62%,${l + 6}%)`); g.addColorStop(1, `hsl(228,70%,${l - 4}%)`);
      col.fillStyle = g; col.fillRect(X, Y, cw, ch);
      hgt.fillStyle = '#B0B0B0'; hgt.fillRect(X, Y, cw, ch);
      orm.fillStyle = `rgb(255,${Math.round(28 + r() * 16)},140)`; orm.fillRect(X, Y, cw, ch);
      col.strokeStyle = 'rgba(150,180,235,0.4)'; hgt.strokeStyle = '#FFFFFF'; orm.strokeStyle = 'rgb(255,120,230)';
      col.lineWidth = hgt.lineWidth = orm.lineWidth = 1;
      for (let i = 1; i < 4; i++) for (const c of [col, hgt, orm]) { c.beginPath(); c.moveTo(X + (cw * i) / 4, Y); c.lineTo(X + (cw * i) / 4, Y + ch); c.stroke(); }
    }
  }
  const map = colorTex(col, repeat), o = dataCanvasTex(orm, repeat);
  return { map, normalMap: normalTex(channel(hgt), w, h, 1.2, repeat), roughnessMap: o, metalnessMap: o, aoMap: o };
}

// Crinkled gold insulation: two sizes of flat facets, each tilted its own way. The normal map is
// written straight from the tilts, so creases stay knife-sharp.
function makeFoil() {
  const n = px(256), repeat = [2, 1];
  const layer = (cells, seed) => { // jittered Voronoi; returns per-pixel facet index and edge distance
    const r = rng(seed), pts = new Float32Array(cells * cells * 5);
    for (let i = 0; i < cells * cells; i++) pts.set([(i % cells + r()) / cells, (Math.floor(i / cells) + r()) / cells, (r() - 0.5) * 2, (r() - 0.5) * 2, r()], i * 5);
    const id = new Int32Array(n * n);
    for (let y = 0, k = 0; y < n; y++) for (let x = 0; x < n; x++, k++) {
      const u = x / n, v = y / n, cx = Math.floor(u * cells), cy = Math.floor(v * cells);
      let best = 9;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const c = ((cy + j + cells) % cells) * cells + ((cx + i + cells) % cells);
        let dx = Math.abs(pts[c * 5] - u), dy = Math.abs(pts[c * 5 + 1] - v);
        if (dx > 0.5) dx = 1 - dx;
        if (dy > 0.5) dy = 1 - dy;
        const dd = dx * dx + dy * dy;
        if (dd < best) { best = dd; id[k] = c; }
      }
    }
    return { pts, id };
  };
  const big = layer(7, 19), small = layer(18, 20);
  const ctx = paint(256, 256, true), img = ctx.createImageData(n, n), d = img.data;
  const nrm = new Uint8Array(n * n * 4), rough = new Float32Array(n * n);
  for (let y = 0, k = 0; y < n; y++) {
    let o = (n - 1 - y) * n * 4;
    for (let x = 0; x < n; x++, k++, o += 4) {
      const a = big.id[k] * 5, b = small.id[k] * 5;
      const gx = big.pts[a + 2] * 0.55 + small.pts[b + 2] * 0.4, gy = big.pts[a + 3] * 0.55 + small.pts[b + 3] * 0.4;
      const inv = 127.5 / Math.sqrt(gx * gx + gy * gy + 1);
      nrm[o] = 128 - gx * inv; nrm[o + 1] = 128 + gy * inv; nrm[o + 2] = 128 + inv; nrm[o + 3] = 255;
      const l = 0.86 + big.pts[a + 4] * 0.16 + small.pts[b + 4] * 0.12;
      d[k * 4] = Math.min(255, 214 * l); d[k * 4 + 1] = Math.min(255, 164 * l); d[k * 4 + 2] = 70 * l; d[k * 4 + 3] = 255;
      rough[k] = 0.2 + small.pts[b + 4] * 0.22;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { map: colorTex(ctx, repeat), normalMap: bytesTex(nrm, n, n, repeat), roughnessMap: ormTex(n, n, 1, rough, 1, repeat) };
}

// Open lattice for the station truss (used with alphaTest). The struts are shaded as round tubes.
function makeTruss() {
  const BW = 512, BH = 128, w = px(BW), h = px(BH), repeat = [10, 1];
  const ctx = paint(BW, BH, true);
  ctx.strokeStyle = '#D9DCE3'; ctx.lineCap = 'round';
  ctx.lineWidth = 14; ctx.strokeRect(7, 7, BW - 14, BH - 14);
  ctx.lineWidth = 10;
  for (let x = 0; x < BW; x += 128) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, BH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 128, BH); ctx.stroke();
  }
  return { map: colorTex(ctx, repeat), normalMap: normalTex(blur(channel(ctx, 3), w, h, 3 * S), w, h, 2.5, repeat) };
}

// Asteroid skin: grain, cracks and bowl craters with raised rims. Grey, tinted per rock.
function makeAsteroid() {
  const B = 256, n = px(B), r = rng(17), repeat = [2, 1]; // small and far away: a quarter of the hull's pixels
  const grain = fbm(n, n, 6, 6, 5, 18), hf = new Float32Array(n * n);
  for (let i = 0; i < hf.length; i++) hf[i] = 0.5 + (grain[i] - 0.5) * 0.7;
  for (let i = 0; i < 26; i++) {
    const cx = r() * n, cy = r() * n, rad = (4 + r() * r() * 26) * S, depth = 0.18 + r() * 0.2, R = Math.ceil(rad * 1.5);
    for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
      const dd = Math.sqrt(x * x + y * y) / rad;
      if (dd > 1.5) continue;
      const k = (((Math.floor(cy) + y) % n + n) % n) * n + (((Math.floor(cx) + x) % n + n) % n);
      hf[k] += dd < 1 ? depth * (dd * dd - 1) + depth * 0.35 * dd * dd : depth * 0.35 * (1 - smooth(1, 1.5, dd));
    }
  }
  const ctx = paint(B, B, true), img = ctx.createImageData(n, n), d = img.data;
  for (let k = 0; k < hf.length; k++) { const c = 255 * clamp01(0.5 + hf[k] * 0.62); d[k * 4] = d[k * 4 + 1] = d[k * 4 + 2] = c; d[k * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return { map: colorTex(ctx, repeat), normalMap: normalTex(hf, n, n, 1.6, repeat) };
}

// Every set is built on first use and then shared, so asking for one twice costs nothing.
const once = (build) => { let set; return () => (set ??= build()); };
export const woodSet = once(makeWood);
export const terrazzoSet = once(makeTerrazzo);
export const grassSet = once(makeGrass);
export const fabricSet = once(makeFabric);
export const rockSet = once(makeRock);
export const rugSet = once(makeRug);
export const keyboardSet = once(makeKeyboard);
export const barkSet = once(makeBark);
export const leafSet = once(makeLeaf);
export const hullSet = once(makeHull);
export const solarSet = once(makeSolar);
export const foilSet = once(makeFoil);
export const trussSet = once(makeTruss);
export const asteroidSet = once(makeAsteroid);
// The albedo-only names from before there were sets, for callers that just want the colour map.
export const woodTexture = () => woodSet().map;
export const terrazzoTexture = () => terrazzoSet().map;
export const grassTexture = () => grassSet().map;
export const fabricTexture = () => fabricSet().map;
export const rockTexture = () => rockSet().map;
export const rugTexture = () => rugSet().map;
export const keyboardTexture = () => keyboardSet().map;
export const solarPanelTexture = () => solarSet().map;
export const foilTexture = () => foilSet().map;
export const trussTexture = () => trussSet().map;

// The same set at another tiling (the GPU copy is shared; only the UV transform differs).
export function retile(set, rx, ry) {
  const done = new Map(), out = {};
  for (const [k, t] of Object.entries(set)) {
    if (!done.has(t)) { const c = t.clone(); c.repeat.set(rx, ry); c.needsUpdate = true; done.set(t, c); }
    out[k] = done.get(t);
  }
  return out;
}

// ------------------------------------------------------------ shader touches
// Small patches for stock materials where a texture cannot do the job. Constants are inlined, so
// the program cache key carries them.
const GLSL_VNOISE = /* glsl */ `
float txHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float txNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(txHash(i), txHash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(txHash(i + vec3(0.0, 1.0, 0.0)), txHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(txHash(i + vec3(0.0, 0.0, 1.0)), txHash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(txHash(i + vec3(0.0, 1.0, 1.0)), txHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}`;
const num = (v) => Number(v).toFixed(4);

// Big ground planes: a slow world-space drift in tone and gloss hides the texture repeat, and
// `rings` (metres) lays concentric mowing stripes round the island centre. No extra texture.
export function groundDetail(mat, { scale = 0.11, tone = 0.1, gloss = 0, rings = 0, ringTone = 0.05 } = {}) {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying vec3 vTxWorld;\n' + shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n  vTxWorld = (modelMatrix * vec4(position, 1.0)).xyz;');
    shader.fragmentShader = `varying vec3 vTxWorld;\n${GLSL_VNOISE}\n` + shader.fragmentShader
      .replace('#include <map_fragment>', `#include <map_fragment>
      vec3 txP = vec3(vTxWorld.xz * ${num(scale)}, 3.7);
      float txDrift = txNoise(txP) * 0.65 + txNoise(txP * 3.1 + 11.0) * 0.35;
      diffuseColor.rgb *= 1.0 + (txDrift - 0.5) * ${num(tone * 2)};
      ${rings ? `float txR = length(vTxWorld.xz) * ${num(Math.PI / rings)};
      float txStripe = smoothstep(-0.6, 0.6, sin(txR)) - 0.5;
      diffuseColor.rgb *= 1.0 + txStripe * ${num(ringTone * 2)} * clamp(1.5 - fwidth(txR) * 1.2, 0.0, 1.0);` : ''}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      roughnessFactor = clamp(roughnessFactor * (1.0 + (txNoise(txP * 1.9 + 5.0) - 0.5) * ${num(gloss * 2)}), 0.04, 1.0);`);
  };
  mat.customProgramCacheKey = () => `tx-ground-${scale}-${tone}-${gloss}-${rings}-${ringTone}`;
  return mat;
}

// Painted metal and moulded plastic on meshes whose UVs are not worth trusting: break the
// highlight up with object-space noise in the roughness (fine orange peel plus slow wear).
export function microRough(mat, { scale = 60, amount = 0.1 } = {}) {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying vec3 vTxLocal;\n' + shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n  vTxLocal = position;');
    shader.fragmentShader = `varying vec3 vTxLocal;\n${GLSL_VNOISE}\n` + shader.fragmentShader
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      roughnessFactor = clamp(roughnessFactor + (txNoise(vTxLocal * ${num(scale)}) * 0.6 + txNoise(vTxLocal * ${num(scale * 0.13)} + 7.0) * 0.4 - 0.5) * ${num(amount * 2)}, 0.04, 1.0);`);
  };
  mat.customProgramCacheKey = () => `tx-micro-${scale}-${amount}`;
  return mat;
}

// The Sun: a white-hot core in a warm corona.
export function sunTexture() {
  return make(512, 512, (ctx, w) => {
    const c = w / 2;
    const g = ctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.05, 'rgba(255,255,250,1)');
    g.addColorStop(0.09, 'rgba(255,240,215,0.85)');
    g.addColorStop(0.2, 'rgba(255,205,150,0.32)');
    g.addColorStop(0.45, 'rgba(255,160,110,0.08)');
    g.addColorStop(1, 'rgba(255,140,100,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, w);
  }, { repeat: [1, 1] });
}

// Glare streaks around the Sun.
export function sunRaysTexture() {
  return make(512, 512, (ctx, w) => {
    const r = rng(5), c = w / 2;
    ctx.translate(c, c);
    ctx.globalCompositeOperation = 'lighter';
    const ray = (angle, len, width, alpha) => {
      ctx.save(); ctx.rotate(angle);
      const g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, `rgba(255,236,200,${alpha})`); g.addColorStop(1, 'rgba(255,236,200,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(0, -width); ctx.lineTo(len, 0); ctx.lineTo(0, width); ctx.closePath(); ctx.fill();
      ctx.restore();
    };
    for (let i = 0; i < 6; i++) ray((i / 6) * Math.PI * 2 + 0.3, c * 0.98, 5, 0.55);
    for (let i = 0; i < 40; i++) ray(r() * Math.PI * 2, c * (0.25 + r() * 0.55), 1.5 + r() * 3, 0.12 + r() * 0.2);
  }, { repeat: [1, 1] });
}

// A code editor / terminal, drawn per desk and scrolled while the agent works.
const TOKEN = ['#FF8FB8', '#7CC4F5', '#FFD86B', '#8FDDB8', '#B9A8F0', '#C9CED8', '#C9CED8', '#FFB070'];
export function drawScreen(ctx, w, h, { seed = 1, offset = 0, accent = '#7CC4F5', on = true, label = '' }) {
  if (!on) {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#2C313D'); g.addColorStop(0.5, '#1E222C'); g.addColorStop(1, '#262A35');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath(); ctx.moveTo(w * 0.55, 0); ctx.lineTo(w * 0.75, 0); ctx.lineTo(w * 0.4, h); ctx.lineTo(w * 0.2, h); ctx.fill();
    return;
  }
  ctx.fillStyle = '#1E2230'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = accent; ctx.fillRect(0, 0, w, 12);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '600 9px "IBM Plex Sans Thai", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(label.slice(0, 34), 6, 6.5);
  ctx.fillStyle = '#262B3A'; ctx.fillRect(0, 12, 46, h - 12); // file tree
  const tr = rng(seed * 7);
  for (let i = 0; i < 9; i++) { ctx.fillStyle = 'rgba(201,206,216,0.45)'; ctx.fillRect(6 + (tr() < 0.4 ? 6 : 0), 18 + i * 11, 18 + tr() * 18, 4); }
  const lineH = 9, rows = Math.floor((h - 16) / lineH);
  for (let i = 0; i < rows; i++) {
    const r = rng(seed * 1000 + i + offset);
    const y = 16 + i * lineH;
    ctx.fillStyle = 'rgba(201,206,216,0.3)'; ctx.fillRect(52, y + 2, 7, 4);
    let x = 64 + Math.floor(r() * 4) * 8;
    const n = 1 + Math.floor(r() * 5);
    for (let k = 0; k < n && x < w - 10; k++) {
      const tw = 8 + r() * 34;
      ctx.fillStyle = TOKEN[Math.floor(r() * TOKEN.length)];
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x, y + 1.5, Math.min(tw, w - 8 - x), 5);
      x += tw + 4;
    }
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = accent; ctx.fillRect(64 + ((offset * 13) % 80), 16 + (rows - 1) * lineH, 2, 7); // cursor
}
