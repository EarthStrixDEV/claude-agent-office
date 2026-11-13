// The 3D office: a Minju City island floating in orbit above the Earth (see space.js). Minju's round dispatch desk sits in the middle,
// agent desks stand on rings around it, and a garden ring with lamps and trees circles the edge.
//
// Lighting follows a time of day (the same six keyframes as Minju City). Static furniture is
// built once per kind and drawn with InstancedMesh, so ~40 detailed desks cost a few draw calls.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { boxUV, mapUV, uvScale, lathe, latheCap, tube, rod, blob, shapeXZ, rrShape, spunY, fbm3, smoothNormals } from './mesh.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { supportsHdr, createPipeline, fitSunShadow, createOrbitEnvironment, createLightPools } from './render.js';
import * as TX from './textures.js';
import { createSpace } from './space.js';

export const STATUS_LABEL = {
  idle: 'Idle', thinking: 'Thinking', working: 'Working', waiting: 'Needs you', error: 'Error',
  standby: 'Standby', compacting: 'Compacting', ended: 'Ended', stale: 'Unknown',
};
const STATUS = {
  idle: '#8C93A6', thinking: '#8A7CF0', working: '#2FA8D0', waiting: '#F2A20C', error: '#E8506A',
  standby: '#2FB58A', compacting: '#D46AC8', ended: '#C3C7D2', stale: '#B3B8C4',
};
const statusColor = (s) => STATUS[s] || STATUS.idle;

// Map-pin labels follow the panel theme.
const LABEL = {
  light: { bg: 'rgba(255,255,255,0.95)', dimBg: 'rgba(255,255,255,0.7)', ink: '#1E2230', sub: '#5F6678', dimInk: '#8C93A6', shadow: 'rgba(30,34,48,0.18)' },
  dark: { bg: 'rgba(22,24,34,0.9)', dimBg: 'rgba(22,24,34,0.6)', ink: '#EEF0F5', sub: '#A2A8B8', dimInk: '#7C8296', shadow: 'rgba(0,0,0,0.35)' },
};
let L = LABEL.light;

// ------------------------------------------------------------ time of day
// Minju City keyframes (hour -> look): they light the office; space.js moves the Sun round the Earth.
const K_NIGHT = { sun: 0x9DB4FF, sunInt: 0.5, sunPos: [-40, 80, -60], hemiSky: 0x5466A8, hemiGround: 0x2A2030, hemiInt: 0.72, foliage: 0x3E6E58, window: 1.7, lamp: 2.2, stars: 1, exposure: 1.15 };
const K_PREDAWN = { sun: 0x8FA6FF, sunInt: 0.45, sunPos: [100, 14, 35], hemiSky: 0x5A6BB0, hemiGround: 0x2C223C, hemiInt: 0.64, foliage: 0x4A7A60, window: 1.4, lamp: 1.8, stars: 0.55, exposure: 1.12 };
const K_DAWN = { sun: 0xFFB98A, sunInt: 1.4, sunPos: [95, 24, 35], hemiSky: 0xFFD1B8, hemiGround: 0x8F7AA8, hemiInt: 1.05, foliage: 0x9CC48A, window: 0.7, lamp: 0.5, stars: 0.1, exposure: 1.05 };
const K_DAY = { sun: 0xFFF4E0, sunInt: 2.6, sunPos: [75, 70, 40], hemiSky: 0xDDEEFF, hemiGround: 0xFFE2EC, hemiInt: 1.05, foliage: 0x86D28F, window: 0, lamp: 0, stars: 0, exposure: 1.0 };
const K_DAY2 = { ...K_DAY, sunPos: [-35, 78, 40] };
const K_SUNSET = { sun: 0xFFA574, sunInt: 1.8, sunPos: [-95, 22, 35], hemiSky: 0xFFD2BC, hemiGround: 0x8A6A9E, hemiInt: 1.0, foliage: 0x9DBE78, window: 0.7, lamp: 0.55, stars: 0.12, exposure: 1.05 };
const K_DUSK = { sun: 0xFF7F6B, sunInt: 0.8, sunPos: [-100, 14, 35], hemiSky: 0x8A7AC0, hemiGround: 0x3A2E56, hemiInt: 0.8, foliage: 0x5E8466, window: 1.3, lamp: 1.5, stars: 0.6, exposure: 1.1 };
const KEYS_C = ['sun', 'hemiSky', 'hemiGround', 'foliage'];
const KEYS_N = ['sunInt', 'hemiInt', 'window', 'lamp', 'stars', 'exposure'];
const KF = [[0, K_NIGHT], [4.6, K_PREDAWN], [6.3, K_DAWN], [8.5, K_DAY], [15.5, K_DAY2], [17.8, K_SUNSET], [19.3, K_DUSK], [21, K_NIGHT], [24, K_NIGHT]]
  .map(([h, k]) => ({ h, n: k, c: Object.fromEntries(KEYS_C.map((key) => [key, new THREE.Color(k[key])])), sp: new THREE.Vector3(...k.sunPos) }));

function sampleTime(hour) {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < KF.length - 2 && KF[i + 1].h <= h) i++;
  const a = KF[i], b = KF[i + 1];
  const t = THREE.MathUtils.smoothstep(h, a.h, b.h);
  const out = { c: {}, sp: a.sp.clone().lerp(b.sp, t) };
  for (const k of KEYS_C) out.c[k] = a.c[k].clone().lerp(b.c[k], t);
  for (const k of KEYS_N) out[k] = a.n[k] + (b.n[k] - a.n[k]) * t;
  return out;
}

export function periodOf(hour) {
  const h = ((hour % 24) + 24) % 24;
  if (h < 4.6 || h >= 21) return { name: 'Night', icon: '🌙' };
  if (h < 6.3) return { name: 'Before dawn', icon: '🌌' };
  if (h < 8.5) return { name: 'Sunrise', icon: '🌅' };
  if (h < 12) return { name: 'Morning', icon: '☀️' };
  if (h < 15.5) return { name: 'Afternoon', icon: '🌤️' };
  if (h < 17.8) return { name: 'Late afternoon', icon: '🌤️' };
  if (h < 19.3) return { name: 'Sunset', icon: '🌇' };
  return { name: 'Dusk', icon: '🌆' };
}
export const isNightHour = (hour) => { const h = ((hour % 24) + 24) % 24; return h < 6 || h >= 19.3; };

// ------------------------------------------------------------------ setup
const RINGS = [{ r: 9, n: 8 }, { r: 15, n: 14 }, { r: 21, n: 20 }];
// ?timescale=4 speeds up walking and physics (handy for demos and slow test machines)
const TIME_SCALE = Math.min(10, Math.max(0.1, Number(new URLSearchParams(location.search).get('timescale')) || 1));
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const UI_FONT = '"IBM Plex Sans Thai", Inter, system-ui, sans-serif';
const DISPLAY_FONT = 'Mali, "IBM Plex Sans Thai", system-ui, sans-serif';
const PASTEL = ['#FF8FB8', '#FFB070', '#7CC4F5', '#FFD86B', '#B9A8F0', '#8FDDB8', '#9FD4F2', '#FFC4D8'];
const HAIR = ['#2a1d1a', '#3b2620', '#1d1d2b', '#5a3a2c', '#7a5236', '#2b2340'];
const PANTS = ['#4B5D82', '#3A4256', '#5F6678', '#6E5A7E', '#3F5A5A'];

function hashHue(str) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
const shirtColor = (key) => new THREE.Color().setHSL((hashHue(key) % 360) / 360, 0.62, 0.72);

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const glowTexture = canvasTexture(128, 128, (ctx, w) => {
  const g = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, w);
});
const alertTexture = canvasTexture(128, 128, (ctx) => {
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(64, 64, 60, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#F2A20C'; ctx.beginPath(); ctx.arc(64, 64, 52, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffffff'; ctx.font = `bold 80px ${UI_FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('!', 64, 68);
});

export const MODE_TAG = {
  plan: ['Plan', '#4F7FE0'], acceptEdits: ['Accept edits', '#1F9E75'], auto: ['Auto', '#8A7CF0'],
  dontAsk: ["Don't ask", '#D98A00'], bypassPermissions: ['Bypass', '#D63A57'],
};
export function shortModel(m) {
  if (!m) return '';
  const x = String(m).replace(/\[.*\]$/, '');
  const k = x.match(/claude-([a-z]+)-(\d+)(?:-(\d+))?/i);
  if (k) return `${k[1][0].toUpperCase()}${k[1].slice(1)} ${k[2]}${k[3] && k[3].length < 3 ? `.${k[3]}` : ''}`;
  return x.replace(/^Claude\s+/i, '');
}

function drawLabel(ctx, w, h, title, sub, color, dim, display = false, tag = null) {
  const { roundRect } = TX;
  ctx.clearRect(0, 0, w, h);
  const ph = h - 20, rr = ph / 2;
  ctx.save();
  ctx.shadowColor = L.shadow; ctx.shadowBlur = 14; ctx.shadowOffsetY = 4;
  roundRect(ctx, 8, 8, w - 16, ph, rr);
  ctx.fillStyle = dim ? L.dimBg : L.bg; ctx.fill();
  ctx.restore();
  ctx.lineWidth = 4; ctx.strokeStyle = color; ctx.globalAlpha = dim ? 0.35 : 0.85;
  roundRect(ctx, 8, 8, w - 16, ph, rr); ctx.stroke();
  ctx.globalAlpha = 1;
  const cy = 8 + rr;
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(8 + rr, cy, rr - 12, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.beginPath(); ctx.arc(8 + rr, cy, 9, 0, Math.PI * 2); ctx.fill();
  const tx = 8 + ph + 6;
  ctx.fillStyle = dim ? L.dimInk : L.ink;
  ctx.font = `${display ? 700 : 600} 38px ${display ? DISPLAY_FONT : UI_FONT}`;
  ctx.textBaseline = 'middle';
  let tagW = 0;
  if (tag) {
    ctx.save();
    ctx.font = `700 22px ${UI_FONT}`;
    tagW = ctx.measureText(tag[0]).width + 22;
    const x0 = w - 24 - tagW, y0 = cy - 30;
    roundRect(ctx, x0, y0, tagW, 30, 15);
    ctx.fillStyle = tag[1]; ctx.globalAlpha = dim ? 0.4 : 1; ctx.fill();
    ctx.fillStyle = '#FFFFFF'; ctx.textBaseline = 'middle'; ctx.fillText(tag[0], x0 + 11, y0 + 16);
    ctx.restore();
    ctx.font = `${display ? 700 : 600} 38px ${display ? DISPLAY_FONT : UI_FONT}`;
  }
  let t = title;
  while (ctx.measureText(t).width > w - tx - 30 - tagW && t.length > 3) t = t.slice(0, -2);
  if (t !== title) t = t.slice(0, -1) + '…';
  ctx.fillText(t, tx, sub ? cy - 15 : cy);
  if (sub) { ctx.font = `500 26px ${UI_FONT}`; ctx.fillStyle = dim ? L.dimInk : L.sub; ctx.fillText(sub, tx, cy + 21); }
}

// ------------------------------------------------------------ materials
// PBR sets from textures.js (albedo + normal + packed occlusion/roughness), built once and shared.
const PBR = {
  wood: TX.woodSet(), terrazzo: TX.terrazzoSet(), grass: TX.grassSet(), fabric: TX.fabricSet(),
  rock: TX.rockSet(), rug: TX.rugSet(), keys: TX.keyboardSet(), bark: TX.barkSet(), leaf: TX.leafSet(),
};
// the albedo maps on their own, for materials that only want the colour
const TEX = Object.fromEntries(Object.entries(PBR).map(([k, set]) => [k, set.map]));
const bump = (v) => new THREE.Vector2(v, v);
// Merged props have UVs nobody should trust, so their gloss is broken up in object space instead.
// Ultra only: it is a few noise taps per pixel, and clearcoat / sheen are a second specular lobe.
const micro = (mat, opt) => (TX.HI ? TX.microRough(mat, opt) : mat);
const M = {
  wood: new THREE.MeshStandardMaterial({ ...PBR.wood, roughness: 1, metalness: 0, normalScale: bump(0.7) }),
  frame: micro(new THREE.MeshStandardMaterial({ color: '#ECECEF', roughness: 0.38, metalness: 0.35 }), { scale: 90, amount: 0.1 }),
  dark: micro(new THREE.MeshPhysicalMaterial({ color: '#2B2F3A', roughness: 0.4, metalness: 0.4, clearcoat: TX.HI ? 0.5 : 0, clearcoatRoughness: 0.12 }), { scale: 70, amount: 0.1 }),
  plastic: micro(new THREE.MeshStandardMaterial({ color: '#F0F0F3', roughness: 0.4 }), { scale: 140, amount: 0.12 }),
  keys: new THREE.MeshStandardMaterial({ ...PBR.keys, roughness: 0.45, normalScale: bump(1) }),
  fabric: new THREE.MeshPhysicalMaterial({ ...PBR.fabric, color: '#FFC4D8', roughness: 0.92, normalScale: bump(0.9), sheen: TX.HI ? 0.7 : 0, sheenRoughness: 0.55, sheenColor: '#FFE9F0' }),
  chairFrame: micro(new THREE.MeshStandardMaterial({ color: '#3A3F4D', roughness: 0.42, metalness: 0.6 }), { scale: 80, amount: 0.12 }),
  ceramic: new THREE.MeshPhysicalMaterial({ color: '#F4F2EF', roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06 }),
  paper: new THREE.MeshStandardMaterial({ color: '#F4F3F0', roughness: 0.85 }),
  leaf: new THREE.MeshStandardMaterial({ ...PBR.leaf, color: '#86D28F', roughness: 0.8, flatShading: true, normalScale: bump(0.8) }),
  succulent: new THREE.MeshStandardMaterial({ color: '#7FC49A', roughness: 0.6 }),
  trunk: new THREE.MeshStandardMaterial({ ...PBR.bark, color: '#FFFFFF', roughness: 0.92, normalScale: bump(1) }),
  lampGlow: new THREE.MeshStandardMaterial({ color: '#FFF6E6', emissive: '#FFD79A', emissiveIntensity: 0, roughness: 0.3 }),
  skin: new THREE.MeshStandardMaterial({ color: '#F3D3BF', roughness: 0.65 }),
  eye: new THREE.MeshStandardMaterial({ color: '#2B2340', roughness: 0.2 }),
  white: new THREE.MeshBasicMaterial({ color: '#FFFFFF' }),
  blush: new THREE.MeshBasicMaterial({ color: '#FF9DB8', transparent: true, opacity: 0.55, depthWrite: false }),
  shoe: new THREE.MeshStandardMaterial({ color: '#F4F4F6', roughness: 0.5 }),
  server: micro(new THREE.MeshStandardMaterial({ color: '#E7EAF2', roughness: 0.38, metalness: 0.3 }), { scale: 60, amount: 0.1 }),
  metalDark: micro(new THREE.MeshStandardMaterial({ color: '#4A4F5E', roughness: 0.45, metalness: 0.6 }), { scale: 50, amount: 0.14 }),
  // the island itself
  floor: TX.groundDetail(new THREE.MeshStandardMaterial({ ...PBR.terrazzo, roughness: 1, metalness: 0, normalScale: bump(0.25) }), { scale: 0.09, tone: 0.06, gloss: 0.2 }),
  grass: TX.groundDetail(new THREE.MeshStandardMaterial({ ...PBR.grass, roughness: 0.9, normalScale: bump(0.8) }), { scale: 0.13, tone: 0.1, rings: 0.74, ringTone: 0.05 }),
  rock: new THREE.MeshStandardMaterial({ ...PBR.rock, roughness: 1, flatShading: true, normalScale: bump(1) }),
  rockSide: new THREE.MeshStandardMaterial({ ...TX.retile(PBR.rock, 16, 0.25), roughness: 1, flatShading: true, normalScale: bump(1) }),
  rug: new THREE.MeshStandardMaterial({ ...PBR.rug, roughness: 1, normalScale: bump(0.5) }),
};

// Transform a geometry into a mergeable, non-indexed piece.
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
function part(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  g.clearGroups();
  g.applyMatrix4(new THREE.Matrix4().compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz)));
  return g;
}
const merge = (parts) => mergeGeometries(parts, false);
const RB = (w, h, d, r = 0.02, seg = 3) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2, h / 2, d / 2));

// Extrude a 2D outline with soft edges. The bevel is taken out of the outline, so the piece keeps
// the size it was drawn at.
function extrude(shape, depth, bevel = 0.006, bevelSegments = 2, curveSegments = 3) {
  return new THREE.ExtrudeGeometry(shape, {
    depth: depth - bevel * 2, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments, curveSegments,
  }).translate(0, 0, bevel);
}

// ----------------------------------------------------- desk templates
// Desk-local space: +Z faces Minju; the agent sits at -Z. Every piece below is merged into one
// geometry per material and instanced across all desks, so the budget is per desk set (about 4k
// triangles): round edges and silhouettes first, flat faces stay cheap.
function deskTemplates() {
  // sled legs: one bent flat-bar loop per side on levelling feet
  const loop = rrShape(0.92, 0.718, 0.06, 0, 0.371);
  loop.holes.push(rrShape(0.83, 0.628, 0.022, 0, 0.371));
  const loopGeo = extrude(loop, 0.05, 0.006, 1, 2);
  const frame = [];
  for (const x of [-0.9, 0.9]) {
    frame.push(part(loopGeo, x - 0.025, 0, 0, 0, Math.PI / 2));
    for (const z of [-0.36, 0.36]) frame.push(part(new THREE.CylinderGeometry(0.02, 0.025, 0.014, 8), x, 0.007, z));
  }
  frame.push(part(new THREE.BoxGeometry(1.76, 0.05, 0.03), 0, 0.703, 0.36));    // crossbeam under the top
  frame.push(part(RB(1.72, 0.3, 0.018, 0.008, 1), 0, 0.53, 0.46));              // modesty panel facing Minju
  const tray = new THREE.Shape();                                                // cable tray: a folded U channel
  tray.moveTo(-0.05, 0.03); tray.lineTo(-0.05, -0.03); tray.lineTo(0.05, -0.03); tray.lineTo(0.05, 0.03);
  tray.lineTo(0.042, 0.03); tray.lineTo(0.042, -0.022); tray.lineTo(-0.042, -0.022); tray.lineTo(-0.042, 0.03);
  frame.push(part(extrude(tray, 0.9, 0), -0.45, 0.66, 0.3, 0, Math.PI / 2));

  // top: rounded corners and a soft edge; the grain still runs once across the whole top
  const wood = [part(extrude(rrShape(2.0, 1.0, 0.05), 0.05, 0.007, 2, 3), 0, 0.73, 0, -Math.PI / 2)];

  // monitor: thin panel, rear housing, hinge, neck and a round foot; cable down through a grommet
  const dark = [
    part(RB(0.96, 0.58, 0.03, 0.012, 2), 0, 1.22, 0.2375),
    part(RB(0.52, 0.32, 0.045, 0.02, 1), 0, 1.2, 0.268),
    part(new THREE.CylinderGeometry(0.02, 0.02, 0.11, 10), 0, 1.12, 0.298, 0, 0, Math.PI / 2),
    part(RB(0.07, 0.35, 0.022, 0.008, 1), 0, 0.955, 0.31, -0.08),
    part(lathe([[0, 0], [0.125, 0], [0.135, 0.004], [0.135, 0.008], [0.11, 0.014], [0.03, 0.019], [0, 0.019]], 18), 0, 0.78, 0.3, 0, 0, 0, 1, 1, 0.8),
    part(lathe([[0.016, 0], [0.03, 0], [0.03, 0.004], [0.016, 0.004]], 10), 0.22, 0.78, 0.4),
    part(tube([[0.1, 1.1, 0.29], [0.19, 0.98, 0.33], [0.22, 0.84, 0.39], [0.22, 0.76, 0.4]], 0.007, 6, 5)),
  ];
  const plastic = [
    part(RB(0.46, 0.018, 0.15, 0.006, 1), 0, 0.789, -0.17),
    part(new THREE.SphereGeometry(1, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2), 0.36, 0.781, -0.17, 0, 0, 0, 0.03, 0.03, 0.05),
  ];
  const keys = [part(new THREE.PlaneGeometry(0.43, 0.13), 0, 0.7995, -0.17, -Math.PI / 2)];

  // office chair at z = -0.85, back towards -Z
  const cz = -0.85;
  // seat cushion: side profile with a waterfall front edge, extruded across with pillowed sides
  const seat = new THREE.Shape();
  seat.moveTo(-0.2, 0.44);
  seat.lineTo(0.16, 0.44);
  seat.splineThru([[0.225, 0.452], [0.24, 0.48], [0.215, 0.506], [0.1, 0.512], [-0.05, 0.506], [-0.19, 0.513], [-0.235, 0.49], [-0.23, 0.455], [-0.2, 0.44]].map(([x, y]) => new THREE.Vector2(x, y)));
  // backrest: a shallow arc in plan that wraps the sitter, extruded upwards
  const back = new THREE.Shape(), bc = -0.62, ba = 0.38, q = Math.PI / 2;
  back.absarc(0, bc, 0.65, q - ba, q + ba, false);
  back.absarc(Math.cos(q + ba) * 0.62, bc + Math.sin(q + ba) * 0.62, 0.03, q + ba, q + ba + Math.PI, false);
  back.absarc(0, bc, 0.59, q + ba, q - ba, true);
  back.absarc(Math.cos(q - ba) * 0.62, bc + Math.sin(q - ba) * 0.62, 0.03, q - ba + Math.PI, q - ba + Math.PI * 2, false);
  const fabric = [
    part(extrude(seat, 0.5, 0.03, 3, 2), 0.25, 0, cz, 0, -Math.PI / 2),
    part(extrude(back, 0.54, 0.022, 2, 3).rotateX(-q).translate(0, -0.27, 0), 0, 0.84, cz - 0.26, -0.12),
  ];
  const chairFrame = [
    part(new THREE.BoxGeometry(0.34, 0.035, 0.3), 0, 0.424, cz),                 // tilt mechanism
    part(rod([0.1, 0.42, cz + 0.06], [0.24, 0.415, cz + 0.08], 0.008, 0.008, 5, true)),   // height lever
    // hub, gas lift and piston in one profile
    part(lathe([[0, 0.058], [0.05, 0.058], [0.056, 0.068], [0.05, 0.11], [0.031, 0.125], [0.031, 0.27], [0.035, 0.276], [0.035, 0.286], [0.021, 0.292], [0.021, 0.41]], 12), 0, 0, cz),
    // spine from under the seat up the back of the backrest
    part(tube([[0, 0.424, cz - 0.1], [0, 0.428, cz - 0.27], [0, 0.5, cz - 0.292], [0, 0.7, cz - 0.292], [0, 0.92, cz - 0.317]], 0.016, 10, 6)),
    part(RB(0.16, 0.2, 0.012, 0.005, 1), 0, 0.8, cz - 0.29, -0.12),
  ];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3, c = Math.cos(a), s = Math.sin(a);
    chairFrame.push(part(rod([c * 0.035, 0.092, s * 0.035], [c * 0.3, 0.062, s * 0.3], 0.024, 0.015, 6, true), 0, 0, cz, 0, 0, 0, 1, 0.75, 1));
    chairFrame.push(part(new THREE.CylinderGeometry(0.027, 0.027, 0.03, 10), c * 0.29, 0.027, cz + s * 0.29, 0, -a, Math.PI / 2)); // castor wheel
    chairFrame.push(part(new THREE.SphereGeometry(0.03, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2), c * 0.29, 0.03, cz + s * 0.29, 0, 0, 0, 1, 0.9, 1));
  }
  for (const x of [-1, 1]) {
    chairFrame.push(part(tube([[x * 0.15, 0.43, cz], [x * 0.25, 0.432, cz - 0.01], [x * 0.288, 0.47, cz - 0.02], [x * 0.29, 0.645, cz - 0.03]], 0.014, 8, 6)));
    chairFrame.push(part(RB(0.062, 0.03, 0.26, 0.014, 1), x * 0.29, 0.66, cz - 0.02));
  }

  return {
    frame: boxUV(merge(frame)),
    wood: mapUV(merge(wood), (x, y, z) => [x / 2 + 0.5, z + 0.5]),
    dark: boxUV(merge(dark)), plastic: boxUV(merge(plastic)), keys: merge(keys),
    fabric: boxUV(merge(fabric), 2), chairFrame: boxUV(merge(chairFrame)),
  };
}

function propTemplates() {
  // mug: one profile from the foot up the outside, over the lip and down the inside
  const mug = merge([
    part(lathe([[0, 0], [0.03, 0], [0.034, 0.004], [0.038, 0.084], [0.0365, 0.09], [0.0335, 0.087], [0.031, 0.014], [0, 0.012]], 16)),
    part(new THREE.TorusGeometry(0.023, 0.006, 6, 8, Math.PI), 0.036, 0.047, 0, 0, 0, -Math.PI / 2),
  ]);
  const pot = merge([part(lathe([[0, 0], [0.04, 0], [0.045, 0.005], [0.058, 0.084], [0.065, 0.087], [0.065, 0.1], [0.056, 0.1], [0.054, 0.09], [0, 0.088]], 14))]);
  // succulent: two rings of plump pointed leaves round a bud
  const leaf = new THREE.SphereGeometry(1, 5, 4);
  const leafParts = [part(leaf, 0, 0.11, 0, 0, 0, 0, 0.014, 0.03, 0.014)];
  for (const [n, tilt, rad, len, y] of [[7, 0.95, 0.03, 0.05, 0.105], [5, 0.45, 0.014, 0.045, 0.125]]) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + tilt;
      leafParts.push(part(leaf, Math.cos(a) * rad, y, Math.sin(a) * rad, Math.sin(a) * tilt, 0, -Math.cos(a) * tilt, 0.02, len, 0.009));
    }
  }
  const leaves = merge(leafParts);
  // desk lamp: weighted base, stem, gooseneck and a spun shade that opens downwards over the bulb
  const lampBody = boxUV(merge([
    part(lathe([[0, 0], [0.07, 0], [0.075, 0.006], [0.07, 0.016], [0.022, 0.022], [0.012, 0.032]], 16)),
    part(rod([0, 0.02, 0], [0, 0.4, 0], 0.01, 0.009, 6)),
    part(new THREE.SphereGeometry(0.017, 6, 4), 0, 0.4, 0),
    part(tube([[0, 0.4, 0], [0.06, 0.47, 0], [0.17, 0.485, 0], [0.25, 0.432, 0]], 0.008, 8, 5)),
    part(lathe([[0, 0.424], [0.016, 0.42], [0.04, 0.398], [0.07, 0.342], [0.077, 0.342], [0.047, 0.402], [0.02, 0.428], [0, 0.434]], 16), 0.25, 0, 0),
  ]));
  const lampBulb = merge([part(new THREE.SphereGeometry(0.028, 8, 6), 0.25, 0.356, 0)]);
  const notebook = merge([
    part(RB(0.2, 0.014, 0.27, 0.004, 1), 0, 0.007, 0),
    part(RB(0.012, 0.016, 0.27, 0.004, 1), -0.07, 0.008, 0),                      // elastic band
    part(rod([0.125, 0.006, -0.07], [0.135, 0.006, 0.07], 0.006, 0.006, 6, true)), // pen
  ]);
  return { mug, pot, leaves, lampBody, lampBulb, notebook };
}

// --------------------------------------------------------------- avatar
// Seated pelvis height and standing pelvis height for the rig below.
const SIT_H = 0.54, STAND_H = 0.865;

// Same look as M.shoe, with vertex colours so the sole is tinted inside the one shoe mesh.
const SHOE = M.shoe.clone();
SHOE.vertexColors = true;

// Hair is one shell: every strand runs from the crown over the skull, then hangs free below it.
// side/back/fringe are the head-local heights of the hem; the hem folds back in to the head so
// the shell is closed and needs no double-sided material.
const HAIR_STYLES = [
  { side: -0.1, back: -0.115, fringe: 0.082, vol: 0.012, curl: 0.022, sweep: 0, tuft: 0.003 },                // bob
  { side: -0.012, back: -0.08, fringe: 0.1, vol: 0.02, curl: 0, sweep: 0.6, tuft: 0.009 },                    // tousled crop, side parting
  { side: -0.13, back: -0.33, fringe: 0.08, vol: 0.012, curl: -0.012, sweep: 0, tuft: 0.003 },                // long
  { side: -0.02, back: -0.085, fringe: 0.095, vol: 0.008, curl: 0, sweep: -0.4, tuft: 0.003, bun: true },     // bun
  { side: -0.05, back: -0.09, fringe: 0.085, vol: 0.012, curl: 0, sweep: 0, tuft: 0.004, tails: true },       // twin tails
];
const MINJU_HAIR = { side: -0.15, back: -0.5, fringe: 0.08, vol: 0.012, curl: 0.012, sweep: 0, tuft: 0.003 };
function hairGeometry(st, seed, cols = 22) {
  const R0 = 0.17, RA = 0.19, FREE = 1.6;        // skull radius, strand arc radius, angle where hair leaves the head
  const hang = st.back < -0.14;
  const rows = st.back < -0.4 ? 14 : hang ? 12 : 9, inner = hang ? 4 : 2, thick = hang ? 0.035 : 0.022;
  const sm = THREE.MathUtils.smoothstep, lerp = THREE.MathUtils.lerp;
  const yFree = Math.cos(FREE) * (R0 + 0.022) * 1.04;
  const hem = (phi) => {
    const a = Math.abs(phi);
    const fringe = st.fringe + 0.013 * Math.abs(Math.sin(phi * 5.5 + seed)) + 0.045 * st.sweep * Math.sin(phi * 1.2);
    return lerp(lerp(st.side, st.back, sm(a, 1.75, 2.6)), fringe, 1 - sm(a, 0.8, 1.25));
  };
  const pt = (out, phi, s, len, inset) => {
    const th = Math.min(s / RA, FREE), h = s - th * RA;
    const vol = st.vol * (0.55 + 0.45 * Math.cos(th - 0.6)) * (0.75 - 0.25 * Math.cos(phi)); // fuller on top and behind
    const strand = 0.0035 * Math.sin(phi * 9 + seed) * Math.sin(Math.min(th, 1.5))
      + st.tuft * Math.min(1, th * 2) * (fbm3(Math.sin(phi) * 3 + seed, th * 2.5, Math.cos(phi) * 3, 2) - 0.5) * 2;
    const R = R0 + 0.016 + vol + strand;
    let x = Math.sin(th) * Math.sin(phi) * R, y = Math.cos(th) * R * 1.04, z = Math.sin(th) * Math.cos(phi) * R * 0.98;
    if (h > 0) { // hanging free: straight down, tips curling in (or flicking out)
      const m = 1 - (st.curl / R) * (h / Math.max(0.02, len - FREE * RA)) ** 2;
      x *= m; z *= m; y -= h;
    }
    if (inset) {
      if (th >= FREE - 0.01) { const k = 1 - inset / Math.hypot(x, z); x *= k; z *= k; } else { const k = 1 - inset / R; x *= k; y *= k; z *= k; }
    }
    out.push(x, y, z);
  };
  const pos = [], uv = [], idx = [], n = rows + 1 + inner;
  for (let i = 0; i <= cols; i++) {
    const phi = -Math.PI + (i / cols) * Math.PI * 2, y = hem(phi);
    const len = y >= yFree ? Math.acos(THREE.MathUtils.clamp(y / ((R0 + 0.022) * 1.04), -1, 1)) * RA : FREE * RA + (yFree - y);
    const inEnd = Math.min(len - 0.03, 1.35 * RA);
    for (let j = 0; j <= rows; j++) { const s = len * (j / rows) ** 0.9; pt(pos, phi, s, len, 0); uv.push((i / cols) * 1.2, s); }
    for (let k = 0; k < inner; k++) { const s = lerp(len, inEnd, k / (inner - 1)); pt(pos, phi, s, len, thick); uv.push((i / cols) * 1.2, len + (len - s) + thick); }
  }
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j, b = a + n;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const nor = g.attributes.normal; // the seam down the back of the head shares its normals
  for (let j = 0; j < n; j++) {
    const a = j, b = cols * n + j;
    _v.set(nor.getX(a) + nor.getX(b), nor.getY(a) + nor.getY(b), nor.getZ(a) + nor.getZ(b)).normalize();
    nor.setXYZ(a, _v.x, _v.y, _v.z); nor.setXYZ(b, _v.x, _v.y, _v.z);
  }
  const parts = [part(g)];
  if (st.bun) {
    parts.push(part(blob(2, seed, { amp: 0.12, freq: 2.2, oct: 2 }), 0, 0.2, -0.085, 0, 0, 0, 0.078, 0.07, 0.078));
    parts.push(part(new THREE.TorusGeometry(0.045, 0.012, 5, 12), 0, 0.165, -0.065, Math.PI / 2 - 0.4));
  }
  if (st.tails) {
    const tail = lathe([[0, -0.21], [0.026, -0.185], [0.046, -0.11], [0.042, -0.04], [0.024, 0], [0, 0.012]], 8);
    for (const x of [-1, 1]) {
      parts.push(part(tail, x * 0.17, -0.035, -0.07, 0.12, 0, x * 0.3));
      parts.push(part(new THREE.SphereGeometry(0.03, 8, 6), x * 0.165, -0.02, -0.065));
    }
  }
  return merge(parts);
}

// Body parts are built once and shared by every avatar (the hero version has denser curves).
const AVATAR_PARTS = {};
function avatarParts(hero) {
  const key = hero ? 'hero' : 'std';
  if (AVATAR_PARTS[key]) return AVATAR_PARTS[key];
  const S = (n) => Math.round(n * (hero ? 1.5 : 1));
  const sm = THREE.MathUtils.smoothstep;
  const P = { hair: {} };
  P.pelvis = new THREE.SphereGeometry(1, S(14), S(8)).scale(0.17, 0.13, 0.138);
  // torso: hem, waist, chest, sloping shoulders and a stand-up collar in one profile, flattened front to back
  P.torso = shapeXZ(lathe([
    [0.13, 0], [0.158, 0.045], [0.157, 0.1], [0.147, 0.2], [0.157, 0.32], [0.167, 0.42], [0.171, 0.47], [0.16, 0.52],
    [0.125, 0.556], [0.086, 0.578], [0.066, 0.59], [0.072, 0.606], [0.07, 0.622], [0.059, 0.62], [0.057, 0.6],
  ], S(14)), (y) => [1 + 0.11 * sm(y, 0.33, 0.47) * (1 - sm(y, 0.5, 0.57)), 0.72 + 0.28 * sm(y, 0.5, 0.585)]);
  P.neck = new THREE.CylinderGeometry(0.05, 0.055, 0.1, S(10), 1, true);
  P.thigh = lathe([[0, -0.412], [0.022, -0.407], [0.046, -0.385], [0.058, -0.345], [0.062, -0.3], [0.07, -0.15], [0.074, -0.03], [0.062, 0.02], [0.035, 0.052], [0, 0.062]], S(10));
  P.shin = lathe([[0, -0.425], [0.047, -0.425], [0.051, -0.41], [0.046, -0.392], [0.044, -0.36], [0.053, -0.2], [0.058, -0.06], [0.056, 0], [0.04, 0.04], [0, 0.055]], S(10));
  {
    // sneaker: a dome that sits lower over the toes, on a slightly wider sole
    const upper = new THREE.SphereGeometry(1, S(10), S(5), 0, Math.PI * 2, 0, Math.PI / 2).scale(0.046, 0.058, 0.086);
    const up = upper.attributes.position;
    for (let i = 0; i < up.count; i++) up.setY(i, up.getY(i) * (0.72 + 0.4 * sm(-up.getZ(i), -0.05, 0.05)));
    upper.computeVertexNormals();
    const shoe = merge([part(upper, 0, -0.4645, 0.04), part(new THREE.CylinderGeometry(1, 1, 0.02, S(12)), 0, -0.475, 0.04, 0, 0, 0, 0.05, 1, 0.09)]);
    const sp = shoe.attributes.position, col = new Float32Array(sp.count * 3);
    for (let i = 0; i < sp.count; i++) col.set(sp.getY(i) < -0.4648 ? [0.62, 0.66, 0.74] : [1, 1, 1], i * 3);
    shoe.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    P.shoe = shoe;
  }
  // head: slightly fuller cheeks, with ears
  const skull = shapeXZ(new THREE.SphereGeometry(0.17, S(22), S(14)).scale(1, 1.04, 0.98), (y) => { const k = 1 + 0.035 * Math.sin(Math.PI * THREE.MathUtils.clamp(-y / 0.17, 0, 1)); return [k, k]; });
  const ear = new THREE.SphereGeometry(1, 6, 5);
  P.skull = merge([part(skull), part(ear, -0.168, -0.028, 0, 0, 0, 0.2, 0.016, 0.034, 0.026), part(ear, 0.168, -0.028, 0, 0, 0, -0.2, 0.016, 0.034, 0.026)]);
  const eye = new THREE.SphereGeometry(0.023, S(8), S(6)), glint = new THREE.SphereGeometry(0.007, 6, 4), cheek = new THREE.CircleGeometry(0.026, 12);
  P.eyes = merge([
    part(eye, -0.06, 0.005, 0.152, 0, 0, 0, 1, 1.25, 0.6), part(eye, 0.06, 0.005, 0.152, 0, 0, 0, 1, 1.25, 0.6),
    part(new THREE.TorusGeometry(0.02, 0.0032, 4, 8, Math.PI * 0.6), 0, -0.04, 0.163, -0.15, 0, Math.PI * 1.2),   // a small smile
  ]);
  P.glints = merge([part(glint, -0.052, 0.018, 0.165), part(glint, 0.068, 0.018, 0.165)]);
  P.blush = merge([part(cheek, -0.093, -0.045, 0.147, 0, -0.24), part(cheek, 0.093, -0.045, 0.147, 0, 0.24)]);
  // arms: sleeve with a cuff at the elbow; forearm, mitten hand and thumb as one skin mesh per side
  P.upper = lathe([[0, -0.285], [0.03, -0.281], [0.047, -0.264], [0.052, -0.25], [0.048, -0.235], [0.05, -0.12], [0.056, -0.03], [0.054, 0.02], [0.035, 0.05], [0, 0.06]], S(8));
  const fore = lathe([[0, -0.215], [0.028, -0.21], [0.033, -0.19], [0.04, -0.08], [0.043, -0.02], [0.04, 0.015], [0.02, 0.035], [0, 0.04]], S(8));
  const palm = new THREE.SphereGeometry(1, S(8), S(6)), thumb = new THREE.SphereGeometry(1, 6, 4);
  P.fore = {};
  for (const [side, sx] of [['L', -1], ['R', 1]]) {
    P.fore[side] = merge([part(fore), part(palm, 0, -0.252, 0.004, 0, 0, 0, 0.036, 0.05, 0.026), part(thumb, -sx * 0.03, -0.238, 0.012, 0, 0, sx * 0.5, 0.013, 0.026, 0.014)]);
  }
  P.bookCover = RB(0.2, 0.03, 0.26, 0.008, 1);
  P.bookPages = new THREE.BoxGeometry(0.185, 0.02, 0.24);
  return (AVATAR_PARTS[key] = P);
}

function makeAvatar(shirt, { scale = 1, seed = 'x', minju = false } = {}) {
  const r = TX.rng(hashHue(seed) + 3);
  const g = new THREE.Group();
  const shirtMat = new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.7, map: TEX.fabric });
  const pantsMat = new THREE.MeshStandardMaterial({ color: minju ? '#FFFFFF' : PANTS[Math.floor(r() * PANTS.length)], roughness: 0.8 });
  const hairMat = new THREE.MeshStandardMaterial({ color: minju ? '#2b1d1a' : HAIR[Math.floor(r() * HAIR.length)], roughness: 0.55 });
  const P = avatarParts(minju);
  const body = new THREE.Group();
  body.position.y = SIT_H;
  g.add(body);
  const add = (geo, mat, x, y, z, parent = body, shadow = true) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = shadow; parent.add(m); return m; };

  add(P.pelvis, pantsMat, 0, 0.01, -0.02);
  add(P.torso, shirtMat, 0, 0, 0);
  add(P.neck, M.skin, 0, 0.6, 0, body, false);

  const legs = {};
  for (const [side, x] of [['L', -0.09], ['R', 0.09]]) {
    const hip = new THREE.Group();
    hip.position.set(x, -0.02, 0);
    body.add(hip);
    add(P.thigh, pantsMat, 0, 0, 0, hip);
    const knee = new THREE.Group();
    knee.position.set(0, -0.36, 0);
    hip.add(knee);
    add(P.shin, pantsMat, 0, 0, 0, knee);
    add(P.shoe, SHOE, 0, 0, 0, knee);
    hip.rotation.x = -Math.PI / 2; knee.rotation.x = Math.PI / 2;
    legs[side] = { hip, knee };
  }

  const head = new THREE.Group();
  head.position.set(0, 0.77, 0);
  body.add(head);
  add(P.skull, M.skin, 0, 0, 0, head);
  add(P.eyes, M.eye, 0, 0, 0, head, false);
  add(P.glints, M.white, 0, 0, 0, head, false);
  add(P.blush, M.blush, 0, 0, 0, head, false);
  // hair: one of five cuts, picked from the seed (Minju keeps her long hair)
  const style = minju ? 'minju' : Math.floor(r() * HAIR_STYLES.length);
  if (!P.hair[style]) P.hair[style] = minju ? hairGeometry(MINJU_HAIR, 2.4, 30) : hairGeometry(HAIR_STYLES[style], style * 1.7 + 0.6);
  add(P.hair[style], hairMat, 0, 0, 0, head);
  if (minju) {
    // headset: band over the hair, cushioned cups, a mic boom; and her bow
    const hs = new THREE.MeshStandardMaterial({ color: '#FFFFFF', roughness: 0.3, metalness: 0.2 });
    add(merge([
      part(new THREE.TorusGeometry(0.214, 0.014, 8, 40, Math.PI), 0, 0.02, 0),
      part(tube([[-0.2, -0.03, 0.02], [-0.19, -0.075, 0.07], [-0.13, -0.085, 0.15], [-0.075, -0.08, 0.185]], 0.006, 10, 6)),
      part(new THREE.SphereGeometry(0.014, 10, 8), -0.07, -0.08, 0.19),
    ]), hs, 0, 0, 0, head);
    const cup = lathe([[0, -0.012], [0.05, -0.012], [0.058, -0.004], [0.058, 0.012], [0.05, 0.024], [0.03, 0.03], [0, 0.031]], 20);
    add(merge([part(cup, 0.2, -0.015, 0, 0, 0, -Math.PI / 2), part(cup, -0.2, -0.015, 0, 0, 0, Math.PI / 2)]), new THREE.MeshStandardMaterial({ color: '#FF8FB8', roughness: 0.35 }), 0, 0, 0, head);
    const loop = new THREE.SphereGeometry(1, 12, 8);
    add(merge([
      part(loop, 0.05, 0, 0, 0, 0, 0.35, 0.05, 0.034, 0.022), part(loop, -0.05, 0, 0, 0, 0, -0.35, 0.05, 0.034, 0.022),
      part(loop, 0, 0, 0.004, 0, 0, 0, 0.02, 0.024, 0.022),
    ]), new THREE.MeshStandardMaterial({ color: '#FF5C9A', roughness: 0.4 }), 0.1, 0.19, -0.03, head).rotation.set(-0.3, 0, -0.35);
  }

  const arms = {};
  for (const [side, x] of [['L', -0.215], ['R', 0.215]]) {
    const upper = new THREE.Group();
    upper.position.set(x, 0.49, 0);
    body.add(upper);
    add(P.upper, shirtMat, 0, 0, 0, upper);
    const fore = new THREE.Group();
    fore.position.set(0, -0.26, 0);
    upper.add(fore);
    add(P.fore[side], M.skin, 0, 0, 0, fore);
    upper.rotation.x = -0.35; fore.rotation.x = -1.2;
    arms[side] = { upper, fore };
  }

  const book = new THREE.Group();
  const cover = new THREE.Mesh(P.bookCover, new THREE.MeshStandardMaterial({ color: PASTEL[Math.floor(r() * PASTEL.length)], roughness: 0.5 }));
  const pages = new THREE.Mesh(P.bookPages, M.paper);
  pages.position.y = 0.014;
  book.add(cover, pages);
  book.position.set(0, 0.27, 0.3);
  book.rotation.x = -0.75;
  book.visible = false;
  body.add(book);

  g.scale.setScalar(scale);
  g.userData = { body, head, arms, legs, book, shirt: shirtMat, gait: 0 };
  return g;
}
// Poses: sit-working, sit-thinking, sit-idle, stand-idle, stand-wave, walk, run.
// Every joint eases toward its target, so switching pose (sit -> stand -> walk) blends smoothly.
function setPose(avatar, pose, ph, motion, dt) {
  const { body, head, arms, legs, gait, book } = avatar.userData;
  if (book) book.visible = pose === 'stand-read';
  const k = 1 - Math.exp(-dt * 12);
  const T = (o, x, kk = k) => { o.rotation.x += (x - o.rotation.x) * kk; };
  const seated = pose.startsWith('sit');
  let bodyY = seated ? SIT_H : STAND_H, lean = 0, follow = k;
  if (seated) {
    T(legs.L.hip, -Math.PI / 2); T(legs.R.hip, -Math.PI / 2);
    T(legs.L.knee, Math.PI / 2); T(legs.R.knee, Math.PI / 2);
  }
  if (pose === 'sit-working') {
    T(arms.L.upper, -0.35); T(arms.R.upper, -0.35);
    arms.L.fore.rotation.x = -1.25 + motion * 0.12 * Math.sin(ph * 18);
    arms.R.fore.rotation.x = -1.25 + motion * 0.12 * Math.sin(ph * 18 + 1.7);
    head.rotation.x = 0.1 + motion * 0.03 * Math.sin(ph * 3); head.rotation.y = 0;
  } else if (pose === 'sit-thinking') {
    T(arms.L.upper, -0.3); T(arms.L.fore, -1.2);
    T(arms.R.upper, -0.95); T(arms.R.fore, -2.05);
    head.rotation.x = -0.12; head.rotation.y = motion * 0.3 * Math.sin(ph * 0.8);
  } else if (pose === 'sit-idle') {
    T(arms.L.upper, -0.15); T(arms.R.upper, -0.15); T(arms.L.fore, -1.05); T(arms.R.fore, -1.05);
    head.rotation.x = 0.04 + motion * 0.03 * Math.sin(ph * 1.2); head.rotation.y = 0;
  } else if (pose === 'walk' || pose === 'run') {
    const run = pose === 'run';
    const sn = Math.sin(gait), cs = Math.cos(gait), amp = run ? 0.85 : 0.5;
    T(legs.L.hip, -amp * sn, 1); T(legs.R.hip, amp * sn, 1);
    T(legs.L.knee, (run ? 1.4 : 0.75) * Math.max(0, -sn), 1); T(legs.R.knee, (run ? 1.4 : 0.75) * Math.max(0, sn), 1);
    T(arms.L.upper, amp * 0.9 * sn, 1); T(arms.R.upper, -amp * 0.9 * sn, 1);
    T(arms.L.fore, run ? -1.5 : -0.35); T(arms.R.fore, run ? -1.5 : -0.35);
    bodyY = STAND_H - (run ? 0.05 : 0) + (run ? 0.07 : 0.035) * Math.abs(cs);
    lean = run ? 0.22 : 0.05;
    follow = 1;
    head.rotation.x = run ? -0.12 : 0; head.rotation.y = 0;
  } else {
    T(legs.L.hip, 0); T(legs.R.hip, 0); T(legs.L.knee, 0); T(legs.R.knee, 0);
    T(arms.L.upper, -0.06); T(arms.L.fore, -0.25);
    if (pose === 'stand-read') {
      T(arms.L.upper, -0.55); T(arms.R.upper, -0.55); T(arms.L.fore, -1.15); T(arms.R.fore, -1.15);
      head.rotation.x = 0.4;
    } else if (pose === 'stand-wave') {
      T(arms.R.upper, -2.75);
      arms.R.fore.rotation.x = -0.35 + motion * 0.35 * Math.sin(ph * 8);
      head.rotation.x = -0.1;
    } else {
      T(arms.R.upper, -0.06); T(arms.R.fore, -0.25);
      head.rotation.x = 0.02;
    }
    head.rotation.y = pose === 'stand-read' ? 0 : motion * 0.15 * Math.sin(ph * 0.7);
    bodyY = STAND_H + motion * 0.006 * Math.sin(ph * 2.2); // breathing
  }
  body.position.y += (bodyY - body.position.y) * follow;
  body.rotation.x += (lean - body.rotation.x) * k;
}

function makeGlow(color, scale) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, color, transparent: true, depthWrite: false, opacity: 0, toneMapped: false }));
  s.scale.setScalar(scale);
  return s;
}

// -------------------------------------------------------------------- desk
const DG = {
  screen: new THREE.PlaneGeometry(0.9, 0.52),
  strip: new THREE.BoxGeometry(1.7, 0.022, 0.012),
  beacon: new THREE.SphereGeometry(0.1, 20, 14),
  hit: new THREE.BoxGeometry(2.6, 2.4, 2.6),
  // tower with a recessed front bezel and feet (the LEDs sit on the bezel at z = 0.222)
  server: merge([
    part(RB(0.36, 0.8, 0.44, 0.03, 2), 0, 0.01, 0), part(RB(0.3, 0.74, 0.02, 0.008, 1), 0, 0.01, 0.211),
    ...[[-0.13, -0.17], [0.13, -0.17], [-0.13, 0.17], [0.13, 0.17]].map(([x, z]) => part(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 8), x, -0.395, z)),
  ]),
  led: new THREE.BoxGeometry(0.05, 0.03, 0.01),
  // side table for a subagent: a rounded top on four splayed legs (origin at the top, 0.48 up)
  miniDesk: merge([
    part(RB(0.7, 0.04, 0.45, 0.015, 1)),
    ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, z]) => part(rod([x * 0.31, -0.48, z * 0.19], [x * 0.27, -0.01, z * 0.16], 0.012, 0.018, 6))),
  ]),
  laptop: RB(0.3, 0.012, 0.2, 0.005, 1),
  laptopLid: RB(0.3, 0.2, 0.01, 0.005, 1),
  stool: uvScale(lathe([[0, -0.15], [0.115, -0.15], [0.125, -0.14], [0.122, -0.12], [0.134, 0.07], [0.142, 0.1], [0.136, 0.13], [0.115, 0.146], [0, 0.15]], 16), 2),
  track: new THREE.RingGeometry(1.55, 1.68, 64),
  halo: new THREE.RingGeometry(1.75, 1.87, 64),
};

class Desk {
  constructor(slot, pos, matrix, lampPos) {
    this.slot = slot;
    this.sessionId = null;
    this.session = null;
    this.state = null;
    this.group = new THREE.Group();
    this.group.position.copy(pos);
    this.group.lookAt(0, 0, 0);
    this.matrix = matrix;
    const g = this.group;

    this.screenCanvas = document.createElement('canvas');
    this.screenCanvas.width = 256; this.screenCanvas.height = 148;
    this.screenTex = new THREE.CanvasTexture(this.screenCanvas);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    this.screenMat = new THREE.MeshBasicMaterial({ map: this.screenTex, toneMapped: false });
    const screen = new THREE.Mesh(DG.screen, this.screenMat);
    screen.position.set(0, 1.22, 0.2205);
    screen.rotation.y = Math.PI;
    g.add(screen);
    this.screenKey = null;
    this.screenOffset = 0;
    this.screenTimer = 0;
    this.seed = slot + 1;

    this.stripMat = new THREE.MeshBasicMaterial({ color: STATUS.ended, toneMapped: false });
    const strip = new THREE.Mesh(DG.strip, this.stripMat);
    strip.position.set(0, 0.69, 0.472);
    g.add(strip);

    this.beaconMat = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.beacon = new THREE.Mesh(DG.beacon, this.beaconMat);
    this.beacon.position.set(0, 2.05, 0);
    this.glow = makeGlow('#ffffff', 1.1);
    this.glow.position.copy(this.beacon.position);
    g.add(this.beacon, this.glow);

    this.labelCanvas = document.createElement('canvas');
    this.labelCanvas.width = 512; this.labelCanvas.height = 136;
    this.labelTex = new THREE.CanvasTexture(this.labelCanvas);
    this.labelTex.colorSpace = THREE.SRGBColorSpace;
    this.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.labelTex, transparent: true, depthWrite: false, toneMapped: false }));
    this.label.scale.set(2.6, 0.69, 1);
    this.label.position.set(0, 2.65, 0);
    this.label.visible = false;
    g.add(this.label);

    this.alert = new THREE.Sprite(new THREE.SpriteMaterial({ map: alertTexture, transparent: true, depthWrite: false, toneMapped: false }));
    this.alert.scale.setScalar(0.6);
    this.alert.position.set(0.95, 2.25, 0);
    this.alert.visible = false;
    g.add(this.alert);

    this.ringTrack = new THREE.Mesh(DG.track, new THREE.MeshBasicMaterial({ color: STATUS.ended, transparent: true, opacity: 0.25, side: THREE.DoubleSide, toneMapped: false }));
    this.ringTrack.rotation.x = -Math.PI / 2;
    this.ringTrack.position.y = 0.012;
    this.ringMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, side: THREE.DoubleSide, toneMapped: false });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(1.55, 1.68, 64, 1, 0, 0.001), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.016;
    this.ringTrack.visible = this.ring.visible = false;
    this.progress = -1;
    g.add(this.ringTrack, this.ring);

    this.halo = new THREE.Mesh(DG.halo, new THREE.MeshBasicMaterial({ color: '#C8325F', transparent: true, opacity: 0.8, side: THREE.DoubleSide, toneMapped: false }));
    this.halo.rotation.x = -Math.PI / 2;
    this.halo.position.y = 0.02;
    this.halo.visible = false;
    g.add(this.halo);

    this.server = new THREE.Group();
    const tower = new THREE.Mesh(DG.server, M.server);
    tower.position.y = 0.41;
    tower.castShadow = true;
    this.server.add(tower);
    this.leds = [];
    for (let i = 0; i < 6; i++) {
      const led = new THREE.Mesh(DG.led, new THREE.MeshBasicMaterial({ color: '#34d399', toneMapped: false }));
      led.position.set(0, 0.7 - i * 0.1, 0.222);
      led.visible = false;
      this.leds.push(led);
      this.server.add(led);
    }
    this.server.position.set(1.35, 0, -0.55);
    this.server.visible = false;
    g.add(this.server);

    this.minis = [];
    for (const [x, z] of [[-1.65, -0.15], [-1.65, 0.75], [1.65, 0.45], [-2.35, 0.3]]) {
      const mg = new THREE.Group();
      const md = new THREE.Mesh(DG.miniDesk, M.wood);
      md.position.y = 0.48;
      const lap = new THREE.Mesh(DG.laptop, M.dark);
      lap.position.set(0, 0.506, 0.03);
      const lid = new THREE.Mesh(DG.laptopLid, M.dark);
      lid.position.set(0, 0.6, 0.13); lid.rotation.x = 0.25;
      const stool = new THREE.Mesh(DG.stool, M.fabric);
      stool.position.set(0, 0.15, -0.42);
      for (const m of [md, lap, lid, stool]) { m.castShadow = true; mg.add(m); }
      mg.position.set(x, 0, z);
      mg.rotation.y = Math.PI / 2 * Math.sign(-x);
      mg.visible = false;
      g.add(mg);
      this.minis.push({ group: mg, avatar: null, agentId: null });
    }

    this.lampGlow = null;
    if (lampPos) {
      this.lampGlow = makeGlow('#FFD79A', 0.9);
      this.lampGlow.position.copy(lampPos);
      g.add(this.lampGlow);
    }

    this.hit = new THREE.Mesh(DG.hit, new THREE.MeshBasicMaterial({ visible: false }));
    this.hit.position.y = 1.1;
    this.hit.userData.desk = this;
    g.add(this.hit);

    this.avatar = null;
    this.phase = Math.random() * Math.PI * 2;
    this.setSession(null);
  }

  drawScreen() {
    const s = this.session;
    const on = !!s && s.status !== 'ended' && s.status !== 'stale';
    TX.drawScreen(this.screenCanvas.getContext('2d'), 256, 148, {
      seed: this.seed, offset: this.screenOffset, on,
      accent: s ? statusColor(s.status) : '#7CC4F5', label: s ? `${s.project} — ${STATUS_LABEL[s.status] || ''}` : '',
    });
    this.screenTex.needsUpdate = true;
  }

  setSession(s, approvalsCount = 0, selected = false) {
    this.session = s; this.asks = approvalsCount; this.selected = selected;
    const status = s ? s.status : null;
    const screenKey = s ? `${s.id}|${status}|${s.project}` : 'off';
    if (screenKey !== this.screenKey) { this.screenKey = screenKey; this.drawScreen(); }
    if (!s) {
      this.sessionId = null;
      this.label.visible = this.ringTrack.visible = this.ring.visible = this.server.visible = false;
      this.alert.visible = this.halo.visible = this.beacon.visible = false;
      this.stripMat.color.set('#D9DCE3');
      this.glow.material.opacity = 0;
      this.minis.forEach((m) => { m.group.visible = false; if (m.avatar) { m.group.remove(m.avatar); m.avatar = null; m.agentId = null; } });
      this.state = null;
      return;
    }
    this.beacon.visible = true;
    this.sessionId = s.id;
    const color = statusColor(status);
    const ended = status === 'ended' || status === 'stale';
    this.stripMat.color.set(color);
    this.beaconMat.color.set(color);
    this.glow.material.color.set(color);
    this.alert.visible = approvalsCount > 0 || status === 'waiting';
    this.halo.visible = selected;

    const sub = [STATUS_LABEL[status] || status, s.skill?.active ? `🧩 ${s.skill.name}` : shortModel(s.model), s.skill?.active ? '' : s.effort, s.queued ? `${s.queued} queued` : ''].filter(Boolean).join(' · ');
    const tag = MODE_TAG[s.permissionMode] || null;
    const key = `${s.project}|${sub}|${color}|${ended}|${L.bg}|${tag?.[0]}`;
    if (key !== this.labelKey) {
      this.labelKey = key;
      drawLabel(this.labelCanvas.getContext('2d'), 512, 136, s.project || s.id.slice(0, 8), sub, color, ended, false, tag);
      this.labelTex.needsUpdate = true;
    }
    this.label.visible = true;

    const p = progressOf(s);
    this.ringTrack.visible = this.ring.visible = p.total > 0 && !ended;
    if (p.total > 0) {
      const frac = p.done / p.total;
      if (Math.abs(frac - this.progress) > 0.001) {
        this.progress = frac;
        this.ring.geometry.dispose();
        this.ring.geometry = new THREE.RingGeometry(1.55, 1.68, 64, 1, Math.PI / 2, -Math.max(0.001, frac) * Math.PI * 2);
      }
      this.ringMat.color.set(frac >= 1 ? STATUS.standby : '#FF5C9A');
    }

    const bg = Object.values(s.background || {}).filter((b) => !/complete|done|killed|failed/i.test(b.status || ''));
    this.server.visible = bg.length > 0 && !ended;
    this.leds.forEach((l, i) => { l.visible = i < bg.length; });

    const subs = Object.values(s.subagents || {}).slice(0, this.minis.length);
    this.minis.forEach((m, i) => {
      const a = subs[i];
      if (!a || ended) {
        m.group.visible = false;
        if (m.avatar) { m.group.remove(m.avatar); m.avatar = null; m.agentId = null; }
        return;
      }
      m.group.visible = true;
      if (m.agentId !== a.id) {
        if (m.avatar) m.group.remove(m.avatar);
        m.avatar = makeAvatar(shirtColor(a.type || a.id), { scale: 0.6, seed: a.id });
        m.avatar.position.set(0, 0, -0.42);
        m.avatar.scale.setScalar(0.001); // pops in
        m.group.add(m.avatar);
        m.agentId = a.id;
      }
      m.done = a.status === 'done';
      m.avatar.userData.shirt.color.copy(m.done ? new THREE.Color(STATUS.ended) : shirtColor(a.type || a.id));
    });

    this.state = status;
  }

  tick(t, dt, env, camPos) {
    if (this.lampGlow) this.lampGlow.material.opacity = Math.min(1, env.lamp * 0.32);
    if (!this.sessionId) return;
    // labels fade out when the camera is right on top of them, so they never cover the view
    const near = THREE.MathUtils.clamp((camPos.distanceTo(this.group.position) - 4.5) / 4, 0.12, 1);
    this.label.material.opacity = this.selected ? 1 : near;
    this.alert.material.opacity = this.selected ? 1 : Math.max(0.35, near);
    const st = this.state;
    const ph = t + this.phase;
    const motion = REDUCED_MOTION ? 0 : 1;
    let pulse = 0.35;
    if (st === 'working') pulse = 0.55 + 0.35 * Math.sin(ph * 6);
    else if (st === 'thinking' || st === 'compacting') pulse = 0.45 + 0.3 * Math.sin(ph * 2.5);
    else if (st === 'waiting') pulse = 0.6 + 0.4 * Math.sin(ph * 9);
    else if (st === 'error') pulse = 0.5 + 0.5 * Math.sin(ph * 4);
    else if (st === 'standby') pulse = 0.5 + 0.2 * Math.sin(ph * 1.5);
    else if (st === 'ended' || st === 'stale') pulse = 0;
    this.glow.material.opacity = (motion ? pulse : Math.min(0.6, pulse + 0.2)) * env.glowGain;
    this.beacon.position.y = 2.05 + motion * 0.05 * Math.sin(ph * 2);
    this.glow.position.y = this.beacon.position.y;
    this.beacon.scale.setScalar(1 + motion * 0.25 * Math.max(0, pulse - 0.4));

    if (this.alert.visible) this.alert.position.y = 2.3 + motion * 0.15 * Math.abs(Math.sin(ph * 4));
    if (this.halo.visible) this.halo.material.opacity = 0.55 + motion * 0.3 * Math.sin(t * 3);
    if (this.server.visible && motion) this.leds.forEach((l, i) => { l.material.color.set(Math.sin(ph * 7 + i * 1.7) > 0 ? '#34d399' : '#0f5132'); });

    // live screen: code scrolls while the agent types
    if (st === 'working' && motion) {
      this.screenTimer += dt;
      if (this.screenTimer > 0.35) { this.screenTimer = 0; this.screenOffset++; this.drawScreen(); }
    }

    for (const m of this.minis) {
      if (!m.avatar) continue;
      const sc = m.avatar.scale.x;
      if (sc < 0.6) m.avatar.scale.setScalar(motion ? Math.min(0.6, sc + dt * 2.2 + (0.6 - sc) * dt * 4) : 0.6);
      setPose(m.avatar, m.done ? 'sit-idle' : 'sit-working', ph + 1, motion, dt);
    }
  }
}

export function progressOf(s) {
  const tasks = Object.values(s.tasks || {});
  if (tasks.length) return { done: tasks.filter((t) => t.done).length, total: tasks.length, items: tasks };
  if (s.todos?.length) return { done: s.todos.filter((t) => t.done).length, total: s.todos.length, items: s.todos };
  return { done: 0, total: 0, items: [] };
}

// ------------------------------------------------------------- instancing
function instanced(geo, mat, matrices, { shadow = true, receive = false, colors = null } = {}) {
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, matrices.length));
  mesh.count = matrices.length;
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
  if (colors) colors.forEach((c, i) => mesh.setColorAt(i, c));
  mesh.castShadow = shadow;
  mesh.receiveShadow = receive;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}
const local = (x, y, z, ry = 0, s = 1) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(s, s, s));

// ----------------------------------------------------------- walking
// Agents walk along the aisles between desk rings and cross a ring only through a gap
// between two desks, so they never cut through furniture.
const AISLES = [6.4, 12.2, 18.2, 24.3];
const GAPS = RINGS.map(({ n }, ri) => Array.from({ length: n }, (_, i) => (i / n) * Math.PI * 2 + (ri % 2 ? Math.PI / n : 0) + Math.PI / 2 + Math.PI / n));
const polar = (r, a) => new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const GATE = { aisle: 3, angle: Math.PI / 2, point: polar(28.6, Math.PI / 2) };
const WALK = 1.5, RUN = 3.6;

function arcTo(points, r, a0, a1) {
  const d = angDiff(a0, a1);
  const steps = Math.max(1, Math.ceil(Math.abs(d) * r / 1.1));
  for (let i = 1; i <= steps; i++) points.push(polar(r, a0 + (d * i) / steps));
  return a1;
}
function route(fromPos, to, lane = 0) {
  const r0 = Math.hypot(fromPos.x, fromPos.z);
  let i = AISLES.reduce((best, r, k) => (Math.abs(r - r0) < Math.abs(AISLES[best] - r0) ? k : best), 0);
  let a = Math.atan2(fromPos.z, fromPos.x);
  const pts = [polar(AISLES[i] + lane, a)];
  while (i !== to.aisle) {
    const step = to.aisle > i ? 1 : -1;
    const ring = step > 0 ? i : i - 1;
    let best = GAPS[ring][0], bestCost = Infinity;
    for (const g of GAPS[ring]) {
      const cost = Math.abs(angDiff(a, g)) * AISLES[i] + Math.abs(angDiff(g, to.angle)) * AISLES[i + step];
      if (cost < bestCost) { bestCost = cost; best = g; }
    }
    a = arcTo(pts, AISLES[i] + lane, a, best);
    i += step;
    pts.push(polar(AISLES[i] + lane, a));
  }
  arcTo(pts, AISLES[i] + lane, a, to.angle);
  pts.push(to.point.clone());
  return pts;
}
function minjuSpot(k) {
  const offs = [0, 0.36, -0.36, 0.72, -0.72, 1.08, -1.08];
  const a = -Math.PI / 2 + offs[k % offs.length];
  return { aisle: 0, angle: a, point: polar(4.2 + Math.floor(k / offs.length) * 0.9, a) };
}
const faceCenter = (p) => Math.atan2(-p.x, -p.z);
// Skill Library: a curved bookcase on Minju's west side; readers stand in front of it.
const LIB_ANGLE = Math.PI, LIB_R = 4.05;
function librarySpot(k) {
  const offs = [0, 0.26, -0.26, 0.52, -0.52];
  const a = LIB_ANGLE + offs[k % offs.length];
  return { aisle: 0, angle: a, point: polar(5.0 + Math.floor(k / offs.length) * 0.7, a) };
}

class Agent {
  constructor(scene, s) {
    this.id = s.id;
    this.scene = scene;
    this.avatar = makeAvatar(shirtColor(s.project || s.id), { seed: s.project || s.id });
    this.avatar.visible = false;
    scene.add(this.avatar);
    this.path = [];
    this.goal = null;      // 'desk' | 'minju' | 'gone'
    this.mode = 'hidden';  // 'walking' | 'seated' | 'minju' | 'hidden'
    this.run = false;
    this.spot = -1;
    this.status = s.status;
    this.phase = Math.random() * 10;
    this.lane = ((hashHue(s.id) % 5) - 2) * 0.22; // walkers keep to their own lane
    this.fade = 0;
  }
  deskTarget(desk) {
    const a = Math.atan2(desk.group.position.z, desk.group.position.x);
    return { aisle: desk.ringIndex + 1, angle: a, point: desk.chair.clone() };
  }
  place(target, mode, yaw) {
    this.avatar.position.copy(target.point);
    this.avatar.rotation.y = yaw;
    this.mode = mode;
    this.path = [];
    this.avatar.visible = mode !== 'hidden';
    this.fade = 1;
    this.avatar.scale.setScalar(1);
  }
  sync(s, desk, opts) {
    this.status = s.status;
    this.desk = desk;
    this.opts = opts;
    this.avatar.userData.shirt.color.copy(s.status === 'stale' ? new THREE.Color(STATUS.stale) : shirtColor(s.project || s.id));
    // a new skill call sends the agent to the Skill Library for a moment
    const skillAt = s.skill?.at || 0;
    if (skillAt !== (this.lastSkillAt ?? skillAt)) {
      if (!opts.initial && !REDUCED_MOTION && s.status !== 'ended') this.wantLibrary = true;
    }
    this.lastSkillAt = skillAt;
    const goal = s.status === 'waiting' ? 'minju' : s.status === 'ended' ? 'gone' : this.wantLibrary || this.goal === 'library' ? 'library' : 'desk';
    if (goal === this.goal) return;
    this.goTo(goal, opts.initial);
  }
  goTo(goal, instant = false) {
    const { takeSpot, freeSpot, takeShelf, freeShelf } = this.opts;
    const from = this.goal;
    this.goal = goal;
    if (from === 'minju' && goal !== 'minju') { freeSpot(this.spot); this.spot = -1; }
    if (from === 'library' && goal !== 'library') { freeShelf(this.shelf); this.shelf = -1; }
    let target, arrive;
    if (goal === 'desk') { target = this.deskTarget(this.desk); arrive = 'seated'; }
    else if (goal === 'minju') { this.spot = takeSpot(); target = minjuSpot(this.spot); arrive = 'minju'; }
    else if (goal === 'library') { this.shelf = takeShelf(); target = librarySpot(this.shelf); arrive = 'reading'; this.wantLibrary = false; this.readT = 0; }
    else { target = GATE; arrive = 'hidden'; }
    this.target = target;
    this.arrive = arrive;
    if (instant || REDUCED_MOTION || (this.mode === 'hidden' && goal === 'gone')) {
      this.place(target, arrive, arrive === 'seated' ? this.desk.yaw : faceCenter(target.point));
      return;
    }
    if (this.mode === 'hidden') { // arrive through the gate
      this.avatar.position.copy(GATE.point).add(new THREE.Vector3(0, 0, 1.2));
      this.avatar.rotation.y = Math.PI;
      this.avatar.visible = true;
      this.fade = 0;
    }
    this.run = goal === 'minju';
    this.path = route(this.avatar.position, target, this.lane);
    this.mode = 'walking';
  }
  leaveForGood() {
    if (this.goal === 'gone' && this.mode === 'hidden') return true;
    if (this.goal === 'library') { this.opts?.freeShelf(this.shelf); this.shelf = -1; }
    if (this.goal !== 'gone') {
      this.goal = 'gone'; this.target = GATE; this.arrive = 'hidden'; this.run = false;
      if (REDUCED_MOTION || this.mode === 'hidden') { this.place(GATE, 'hidden', 0); return true; }
      this.path = route(this.avatar.position, GATE, this.lane);
      this.mode = 'walking';
    }
    return false;
  }
  update(t, dt, motion) {
    const av = this.avatar;
    if (this.mode === 'hidden') { av.visible = false; return; }
    if (this.fade < 1) { this.fade = Math.min(1, this.fade + dt * 2.5); av.scale.setScalar(0.2 + 0.8 * this.fade); }
    const ph = t + this.phase;
    if (this.mode === 'walking') {
      const speed = this.run ? RUN : WALK;
      let step = speed * dt;
      while (step > 0 && this.path.length) {
        const next = this.path[0];
        const dx = next.x - av.position.x, dz = next.z - av.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist <= step) { av.position.set(next.x, 0, next.z); this.path.shift(); step -= dist; }
        else {
          av.position.x += (dx / dist) * step; av.position.z += (dz / dist) * step;
          const yaw = Math.atan2(dx, dz);
          av.rotation.y += angDiff(av.rotation.y, yaw) * Math.min(1, dt * 10);
          step = 0;
        }
      }
      av.userData.gait += speed * dt * (this.run ? 3.2 : 5.2);
      setPose(av, this.run ? 'run' : 'walk', ph, motion, dt);
      if (!this.path.length) {
        this.mode = this.arrive;
        if (this.arrive === 'hidden') { av.visible = false; return; }
        if (this.arrive === 'seated') av.position.copy(this.target.point);
      }
      return;
    }
    if (this.mode === 'seated') {
      av.rotation.y += angDiff(av.rotation.y, this.desk.yaw) * Math.min(1, dt * 6);
      const st = this.status;
      setPose(av, st === 'working' ? 'sit-working' : st === 'thinking' || st === 'compacting' ? 'sit-thinking' : 'sit-idle', ph, motion, dt);
    } else if (this.mode === 'minju') {
      av.rotation.y += angDiff(av.rotation.y, faceCenter(av.position)) * Math.min(1, dt * 6);
      setPose(av, 'stand-wave', ph, motion, dt);
    } else if (this.mode === 'reading') {
      av.rotation.y += angDiff(av.rotation.y, faceCenter(av.position)) * Math.min(1, dt * 6);
      setPose(av, 'stand-read', ph, motion, dt);
      this.readT += dt;
      if (this.readT > 2.8) this.goTo(this.status === 'waiting' ? 'minju' : this.status === 'ended' ? 'gone' : 'desk');
    }
  }
  dispose() { this.scene.remove(this.avatar); }
}

// ------------------------------------------------------- Grok Bot pavilion
const BOT_STATUS_COLOR = { working: '#2FA8D0', idle: '#8C93A6', waiting: '#F2A20C', error: '#E8506A', done: '#2FB58A' };
// A flat token with softened edges: n corners, alternating between two radii (equal radii give a
// plain polygon, unequal ones a star).
function polyShape(n, r0, r1, depth = 0.24) {
  const s = new THREE.Shape();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.PI / 2, rad = i % 2 ? r1 : r0;
    s[i ? 'lineTo' : 'moveTo'](Math.cos(a) * rad, Math.sin(a) * rad);
  }
  return extrude(s, depth, 0.035, 3, 1).translate(0, 0, -depth / 2);
}
const BOT_SHAPES = {
  circle: () => new THREE.SphereGeometry(0.32, 28, 18),
  square: () => RB(0.52, 0.52, 0.52, 0.08),
  triangle: () => polyShape(3, 0.4, 0.4),
  diamond: () => new THREE.OctahedronGeometry(0.38),
  star: () => polyShape(10, 0.42, 0.2),
  hexagon: () => polyShape(6, 0.36, 0.36),
};

// --------------------------------------------------------------- office
export function createOffice(container, { onSelect, hour = 10, uiTheme = 'light', quality = 'ultra' } = {}) {
  L = LABEL[uiTheme] || LABEL.light;

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.autoClear = false;
  renderer.setClearColor('#02030A');
  renderer.info.autoReset = false; // a frame is many render() calls now: frame() resets the counters once
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // HDR frame pipeline (render.js): bloom, ambient occlusion, one tone-mapping pass at the end.
  // Labels, alert badges, progress rings and halos are UI: they skip all of that and draw last.
  // Without float render targets the office is drawn straight to the canvas as before.
  const isUi = (o) => o.material.toneMapped === false
    && ((o.isSprite && o.material.map !== glowTexture && o.material.blending !== THREE.AdditiveBlending)
      || (o.isMesh && o.geometry.type === 'RingGeometry'));
  const query = new URLSearchParams(location.search); // ?direct forces the old straight-to-canvas path, to compare or to debug
  const pipeline = supportsHdr(renderer) && !query.has('direct') ? createPipeline(renderer, { isUi, stats: query.has('stats') }) : null;
  // what the office reflects: space, the Earth, its own floor and the key light (repainted in setTime)
  const EARTH_DIR = new THREE.Vector3(0, -Math.sin(52 * Math.PI / 180), -Math.cos(52 * Math.PI / 180)); // as in space.js
  const orbitEnv = createOrbitEnvironment(renderer, { earthDir: EARTH_DIR, earthAngle: 44 * Math.PI / 180 });

  // near 0.4: nothing comes closer (minDistance 4), and it buys 4x the depth precision at the
  // island's far edge, where the grass sits 8 mm above the floor
  const camera = new THREE.PerspectiveCamera(42, 1, 0.4, 1500);
  camera.position.set(0, 52, 66);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = 1.32;
  controls.minDistance = 4;
  controls.maxDistance = 85;
  // panning may not carry the target off the island (and the camera under it); see frame()
  let userCam = false;
  controls.addEventListener('start', () => { userCam = true; camAnim = null; }); // a drag wins over a fly-to

  // ---- space: stars, the Earth, the Sun, stations, satellites and meteors
  const space = createSpace({ renderer, scene, quality });

  // ---- lights
  const hemi = new THREE.HemisphereLight('#ffffff', '#ffffff', 1);
  scene.add(hemi);
  // key: the sun, the only shadow caster
  const sun = new THREE.DirectionalLight('#ffffff', 1);
  sun.castShadow = true;
  scene.add(sun, sun.target);
  // Shadow tuning, all in one place. The box is refitted to the island in setTime (fitSunShadow).
  // Striped or speckled floor (acne): raise slopeTexels. Shadows detached from thin legs: lower
  // normalBiasTexels. Something tall loses its shadow: raise yMax.
  const SHADOW = {
    mapSize: { ultra: 4096, standard: 1536 },
    radius: 36.6, yMin: -0.5, yMax: 9,   // the island disc and its tallest casters
    normalBiasTexels: 1.0,               // receivers move along their normal by this many texels
    slopeTexels: 0.9,                    // depth bias, in texels of floor slope as the sun sees it (0.4 was still clean)
    minBias: 0.004,                      // metres, on top of the slope term
  };
  // rim: cool back light opposite the sun, so avatars and furniture separate from the floor
  const rim = new THREE.DirectionalLight('#A9C7FF', 0);
  // earthshine: blue bounce from the Earth, ahead of the island and below it
  const earthshine = new THREE.DirectionalLight('#5E9BFF', 0);
  earthshine.position.copy(EARTH_DIR).multiplyScalar(50);
  scene.add(rim, earthshine);
  const minjuLight = new THREE.PointLight('#FF8FB8', 4, 16, 1.6);
  minjuLight.position.set(0, 4.5, 0);
  scene.add(minjuLight);

  // ---- floating island
  const floorMat = M.floor;
  const floor = new THREE.Mesh(new THREE.CircleGeometry(36, 128), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grass = new THREE.Mesh(new THREE.RingGeometry(27.2, 36, 128, 4), M.grass);
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = 0.008;
  grass.receiveShadow = true;
  scene.add(grass);
  const kerb = new THREE.Mesh(new THREE.TorusGeometry(27.2, 0.12, 8, 160), new THREE.MeshStandardMaterial({ color: '#F1E6DA', roughness: 0.6 }));
  kerb.rotation.x = -Math.PI / 2;
  kerb.position.y = 0.04;
  kerb.receiveShadow = true;
  scene.add(kerb);
  const rockMat = M.rock;
  const side = new THREE.Mesh(new THREE.CylinderGeometry(36, 34.6, 2.4, 128, 2, true), M.rockSide);
  side.position.y = -1.2;
  scene.add(side);
  {
    const g = new THREE.ConeGeometry(34.6, 20, 64, 8, true).toNonIndexed();
    const pos = g.attributes.position, r = TX.rng(13), seen = new Map();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (y < -9.9) continue; // keep the rim that meets the island side
      const key = `${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}`;
      if (!seen.has(key)) seen.set(key, [1 + (r() - 0.5) * 0.18, (r() - 0.5) * 1.6]);
      const [f, dy] = seen.get(key);
      pos.setXYZ(i, x * f, y + dy, z * f);
    }
    g.computeVertexNormals();
    const rock = new THREE.Mesh(g, rockMat);
    rock.rotation.x = Math.PI;
    rock.position.y = -2.4 - 10;
    scene.add(rock);
  }
  const rug = new THREE.Mesh(new THREE.CircleGeometry(5.8, 96), M.rug);
  rug.rotation.x = -Math.PI / 2;
  rug.position.y = 0.012;
  rug.receiveShadow = true;
  scene.add(rug);

  // ---- landmarks on the garden ring (kept clear of trees)
  const FOUNTAIN = new THREE.Vector3(-9, 0, 30.6);
  const GROK_POS = new THREE.Vector3(-24, 0, 20.6);
  const clearOf = (x, z, pad = 0) => !((Math.abs(x) < 2.6 + pad && z > 25) || Math.hypot(x - FOUNTAIN.x, z - FOUNTAIN.z) < 3.4 + pad || Math.hypot(x - GROK_POS.x, z - GROK_POS.z) < 4.4 + pad);

  // ---- wind: shared by swaying trees, falling leaves and the fountain spray
  const wind = { time: { value: 0 }, strength: { value: 0.5 }, dir: new THREE.Vector3(1, 0, 0.35).normalize() };
  M.leaf.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = wind.time;
    shader.uniforms.uWind = wind.strength;
    shader.vertexShader = 'uniform float uTime;\nuniform float uWind;\n' + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec2 ip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
      #else
        vec2 ip = vec2(0.0);
      #endif
      float hgt = max(0.0, position.y - 0.9);
      float ph = uTime * 1.6 + ip.x * 0.37 + ip.y * 0.21;
      transformed.x += (sin(ph) * 0.07 + 0.05) * hgt * uWind;
      transformed.z += (cos(ph * 1.3) * 0.05 + 0.02) * hgt * uWind;`);
  };
  M.leaf.customProgramCacheKey = () => 'leaf-sway';

  // ---- garden: trees, bushes, flowers, lamps, benches (all instanced)
  const garden = new THREE.Group();
  scene.add(garden);
  const detail = new THREE.Group(); // hidden on Standard quality
  scene.add(detail);
  M.leaf.flatShading = false; // canopies are smooth displaced blobs now, not faceted low-poly
  {
    const r = TX.rng(101);
    // A canopy is a cluster of noise-displaced spheres: [x, y, z, radius, squash, detail].
    // Keep them above y = 0.9, where the wind sway in the leaf shader starts.
    const canopy = (seed, blobs) => merge(blobs.map(([x, y, z, rad, sy, det], i) =>
      part(blob(det, seed * 10 + i, { amp: 0.15, freq: 1.7, oct: 2, puff: det > 3 ? 0.2 : 0.09, puffFreq: 2.6 }), x, y, z, 0, seed + i * 2.1, 0, rad, rad * sy, rad)));
    // Trunk: a flared, slightly crooked lathe with root lobes, plus tapered branches into the canopy.
    const trunkGeo = (seed, h, girth, branches) => {
      const g = lathe([[0.36, 0], [0.27, 0.07], [0.2, 0.24], [0.165, 0.6], [0.145, 1.2], [0.12, h]].map(([rad, y]) => [rad * girth, y]), 10).toNonIndexed();
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i), a = Math.atan2(z, x);
        const k = 1 + 0.22 * Math.cos(a * 5 + seed) * (1 - THREE.MathUtils.smoothstep(y, 0, 0.4)) + 0.05 * Math.sin(a * 3 + y * 4 + seed);
        p.setXYZ(i, x * k + 0.07 * Math.sin(y * 1.4 + seed), y, z * k + 0.05 * Math.sin(y * 1.1 + seed * 2));
      }
      smoothNormals(g);
      return merge([part(g), ...branches.map(([a, b, r0, r1]) => part(rod(a, b, r0, r1, 6)))]);
    };
    const TREES = [
      { // round and full
        trunk: trunkGeo(1, 1.95, 1, [[[0.05, 1.3, 0], [0.5, 1.95, 0.15], 0.075, 0.04], [[0.02, 1.4, 0], [-0.42, 1.9, -0.2], 0.065, 0.035]]),
        crown: canopy(1, [[0, 2.25, 0, 1.05, 0.95, 5], [0.62, 1.85, 0.25, 0.68, 0.9, 4], [-0.55, 1.9, -0.3, 0.7, 0.9, 4], [0.05, 2.98, 0.05, 0.6, 0.9, 3], [-0.1, 1.95, 0.62, 0.55, 0.9, 2]]),
      },
      { // tall and narrow
        trunk: trunkGeo(2, 2.2, 0.85, [[[0.02, 1.5, 0], [0.34, 1.95, -0.12], 0.055, 0.03]]),
        crown: canopy(2, [[0, 2.1, 0, 0.82, 1.1, 5], [0.08, 2.95, -0.04, 0.68, 1.05, 4], [-0.04, 3.6, 0.04, 0.46, 1.1, 3], [0.46, 1.75, -0.18, 0.45, 0.9, 2], [-0.4, 2.3, 0.25, 0.48, 1, 2]]),
      },
      { // wide umbrella
        trunk: trunkGeo(3, 1.75, 1.1, [[[0, 1.2, 0], [-0.62, 1.85, 0.05], 0.085, 0.04], [[0, 1.25, 0], [0.6, 1.9, 0.18], 0.085, 0.04], [[0, 1.4, 0], [0, 2.0, -0.4], 0.06, 0.03]]),
        crown: canopy(3, [[-0.72, 2.15, 0, 0.82, 0.72, 4], [0.72, 2.22, 0.2, 0.86, 0.72, 4], [0, 2.5, -0.42, 0.82, 0.75, 4], [0.1, 2.3, 0.62, 0.62, 0.75, 3], [0, 2.75, 0.1, 0.55, 0.7, 2]]),
      },
      { // forked, two crowns
        trunk: trunkGeo(4, 1.7, 0.95, [[[0, 1.1, 0], [-0.48, 2.0, 0.08], 0.09, 0.045], [[0, 1.2, 0], [0.5, 2.25, -0.1], 0.085, 0.04]]),
        crown: canopy(4, [[-0.52, 2.3, 0.1, 0.8, 0.95, 4], [0.56, 2.62, -0.1, 0.86, 0.95, 5], [0, 1.95, 0.5, 0.5, 0.85, 2], [0.1, 3.1, 0.05, 0.5, 0.9, 3], [-0.2, 2.75, -0.35, 0.5, 0.9, 2]]),
      },
    ];
    const BUSHES = [
      canopy(7, [[0, 0.42, 0, 0.56, 0.8, 4], [0.4, 0.33, 0.15, 0.4, 0.85, 3], [-0.36, 0.32, -0.2, 0.42, 0.8, 3]]),
      canopy(8, [[0.1, 0.36, 0, 0.5, 0.75, 4], [-0.38, 0.3, 0.2, 0.4, 0.8, 3], [0.3, 0.28, -0.34, 0.36, 0.8, 3], [0, 0.62, 0.05, 0.3, 0.9, 2]]),
    ];
    const pickR = TX.rng(202); // variant and tint come from their own stream, so positions match earlier builds
    const tint = (shade) => new THREE.Color(shade * (0.9 + pickR() * 0.2), shade, shade * (0.86 + pickR() * 0.22));
    const treeM = TREES.map(() => []), treeC = TREES.map(() => []), bushM = BUSHES.map(() => []), bushC = BUSHES.map(() => []), flowerM = [], flowerC = [], tops = [];
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2 + (r() - 0.5) * 0.08, rad = 30 + r() * 4.5;
      const x = Math.sin(a) * rad, z = Math.cos(a) * rad, rot = r() * 6, sc = 0.85 + r() * 0.6, shade = 0.88 + r() * 0.24;
      const v = Math.floor(pickR() * TREES.length), c = tint(shade);
      if (!clearOf(x, z, 0.8)) continue;
      treeM[v].push(local(x, 0, z, rot, sc));
      treeC[v].push(c);
      tops.push(new THREE.Vector3(x, 0, z));
    }
    for (let i = 0; i < 90; i++) {
      const a = r() * Math.PI * 2, rad = 28 + r() * 7.2;
      const x = Math.sin(a) * rad, z = Math.cos(a) * rad, rot = r() * 6, sc = 0.35 + r() * 0.3, shade = 0.92 + r() * 0.2;
      const v = i % BUSHES.length, c = tint(shade);
      if (!clearOf(x, z)) continue;
      bushM[v].push(local(x, 0, z, rot, 0.55 + (sc - 0.35) * 2.2));
      bushC[v].push(c);
    }
    for (let i = 0; i < 700; i++) {
      const a = r() * Math.PI * 2, rad = 27.8 + r() * 7.8;
      const x = Math.sin(a) * rad, z = Math.cos(a) * rad, sc = 0.7 + r() * 0.6, col = PASTEL[Math.floor(r() * PASTEL.length)];
      if (!clearOf(x, z, -1.2)) continue;
      flowerM.push(local(x, 0.07, z, pickR() * 6, sc));
      flowerC.push(new THREE.Color(col));
    }
    garden.userData.treeTops = tops;
    TREES.forEach((t, v) => {
      garden.add(instanced(t.trunk, M.trunk, treeM[v]));
      garden.add(instanced(t.crown, M.leaf, treeM[v], { colors: treeC[v] }));
    });
    BUSHES.forEach((b, v) => detail.add(instanced(b, M.leaf, bushM[v], { colors: bushC[v] })));
    // Flowers: a five-petal cupped bloom (tinted per instance) on a stem with a yellow eye and two leaves.
    const bloom = new THREE.BufferGeometry();
    {
      const N = 10, pos = [0, 0.078, 0], uv = [0.5, 0.5], idx = [];
      for (const rho of [0.55, 1]) {
        for (let i = 0; i < N; i++) {
          const a = (i / N) * Math.PI * 2, rad = 0.086 * rho * (0.58 + 0.42 * Math.abs(Math.cos(a * 2.5)) ** 0.7);
          pos.push(Math.cos(a) * rad, 0.078 + 0.05 * rho ** 1.3, Math.sin(a) * rad);
          uv.push(0.5 + Math.cos(a) * rho * 0.5, 0.5 + Math.sin(a) * rho * 0.5);
        }
      }
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        idx.push(0, 1 + j, 1 + i, 1 + i, 1 + j, 1 + N + j, 1 + i, 1 + N + j, 1 + N + i);
      }
      bloom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      bloom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      bloom.setIndex(idx);
      bloom.computeVertexNormals();
    }
    const stemParts = [
      [part(rod([0, -0.07, 0], [0, 0.08, 0], 0.006, 0.005, 3)), [0.36, 0.62, 0.36]],
      [part(new THREE.SphereGeometry(0.026, 5, 3), 0, 0.092, 0, 0, 0, 0, 1, 0.75, 1), [1, 0.82, 0.3]],
      [part(new THREE.SphereGeometry(1, 4, 2), 0.03, -0.02, 0.005, 0, 0, -1.0, 0.012, 0.04, 0.02), [0.4, 0.68, 0.4]],
      [part(new THREE.SphereGeometry(1, 4, 2), -0.028, -0.035, -0.008, 0, 0, 1.1, 0.012, 0.036, 0.02), [0.4, 0.68, 0.4]],
    ];
    const stem = merge(stemParts.map(([g]) => g));
    {
      const col = [];
      for (const [g, c] of stemParts) for (let i = 0; i < g.attributes.position.count; i++) col.push(...c);
      stem.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    }
    detail.add(instanced(bloom, new THREE.MeshStandardMaterial({ roughness: 0.6, side: THREE.DoubleSide }), flowerM, { shadow: false, colors: flowerC }));
    detail.add(instanced(stem, new THREE.MeshStandardMaterial({ roughness: 0.7, vertexColors: true }), flowerM, { shadow: false }));
  }
  const streetLampHeads = [];
  {
    const n = 14, postM = [], benchM = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.11;
      const p = new THREE.Vector3(Math.sin(a) * 26.6, 0, Math.cos(a) * 26.6);
      postM.push(local(p.x, 0, p.z, a));
      streetLampHeads.push(p);
      if (i % 2 === 0) benchM.push(local(Math.sin(a + 0.1) * 28.6, 0, Math.cos(a + 0.1) * 28.6, a + 0.1 + Math.PI));
    }
    // lamp post: one turned profile from the stepped base up to the lantern seat; cage bars and a
    // roof with a finial round the glass
    const postParts = [
      part(lathe([
        [0, 0], [0.2, 0, 1], [0.2, 0.05, 1], [0.17, 0.07], [0.17, 0.12, 1], [0.12, 0.17], [0.088, 0.22], [0.076, 0.5], [0.09, 0.52], [0.09, 0.56], [0.072, 0.58],
        [0.058, 2.9], [0.078, 2.92], [0.078, 2.98], [0.058, 3.0], [0.058, 3.12], [0.1, 3.19], [0.175, 3.235], [0.175, 3.27, 1], [0.1, 3.275],
      ], 16)),
      part(lathe([[0, 3.755], [0.215, 3.755, 1], [0.225, 3.775], [0.13, 3.9], [0.045, 3.97], [0.03, 4.0], [0.046, 4.03], [0.03, 4.065], [0, 4.075]], 16)),
    ];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      postParts.push(part(rod([Math.cos(a) * 0.165, 3.27, Math.sin(a) * 0.165], [Math.cos(a) * 0.19, 3.76, Math.sin(a) * 0.19], 0.012, 0.012, 4)));
    }
    const post = merge(postParts);
    const bulb = merge([part(lathe([[0.125, 3.272], [0.15, 3.45], [0.158, 3.6], [0.15, 3.756]], 16))]);
    garden.add(instanced(post, M.metalDark, postM));
    garden.add(instanced(bulb, M.lampGlow, postM, { shadow: false }));
    // bench: rounded slats on two cast side frames (legs, seat rail, armrest and back support in one outline)
    const benchWood = merge([
      ...[-0.14, 0, 0.14].map((z) => part(RB(1.6, 0.04, 0.12, 0.012, 1), 0, 0.45, z)),
      part(RB(1.6, 0.11, 0.035, 0.012, 1), 0, 0.6, -0.218, -0.225), part(RB(1.6, 0.11, 0.035, 0.012, 1), 0, 0.77, -0.247, -0.225),
    ]);
    const sideShape = new THREE.Shape([[0.25, 0], [0.25, 0.66], [0.22, 0.69], [-0.235, 0.69], [-0.29, 0.93], [-0.335, 0.92], [-0.262, 0.5], [-0.245, 0], [-0.195, 0], [-0.205, 0.38], [0.2, 0.38], [0.2, 0]].map(([z, y]) => new THREE.Vector2(z, y)));
    sideShape.holes.push(new THREE.Path([[0.2, 0.43], [0.2, 0.64], [-0.222, 0.64], [-0.208, 0.43]].map(([z, y]) => new THREE.Vector2(z, y))));
    const sideGeo = extrude(sideShape, 0.05, 0.008, 1, 1);
    const benchMetal = boxUV(merge([part(sideGeo, -0.675, 0, 0, 0, -Math.PI / 2), part(sideGeo, 0.725, 0, 0, 0, -Math.PI / 2)]));
    garden.add(instanced(benchWood, M.wood, benchM));
    garden.add(instanced(benchMetal, M.metalDark, benchM));
  }
  const streetGlows = streetLampHeads.map((p) => {
    const s = makeGlow('#FFD79A', 3.2);
    s.position.set(p.x, 3.5, p.z);
    scene.add(s);
    return s;
  });

  // ---- arrivals gate: agents walk in (and out) through here
  const gate = new THREE.Group();
  gate.position.copy(GATE.point);
  {
    const archMat = new THREE.MeshPhysicalMaterial({ color: '#FFFFFF', roughness: 0.2, clearcoat: 1 });
    // arch, two turned pillars (stepped plinth, collar) and banded joints along the arch: one mesh
    const pillar = lathe([
      [0, 0], [0.26, 0, 1], [0.26, 0.1, 1], [0.22, 0.12], [0.22, 0.2, 1], [0.175, 0.24], [0.165, 0.3], [0.135, 1.3], [0.162, 1.34], [0.162, 1.42], [0.135, 1.46], [0.13, 1.5],
    ], 20);
    const band = lathe([[0.125, -0.045], [0.156, -0.038], [0.156, 0.038], [0.125, 0.045]], 14);
    const arch = new THREE.Mesh(merge([
      part(new THREE.TorusGeometry(1.5, 0.13, 14, 56, Math.PI), 0, 1.5, 0),
      part(pillar, -1.5, 0, 0), part(pillar, 1.5, 0, 0),
      ...[1, 2, 3, 4, 5].map((k) => { const t = (k / 6) * Math.PI; return part(band, Math.cos(t) * 1.5, 1.5 + Math.sin(t) * 1.5, 0, 0, 0, t); }),
    ]), archMat);
    arch.castShadow = true;
    const portalTex = canvasTexture(256, 256, (ctx, w) => {
      const g = ctx.createRadialGradient(w / 2, w / 2, 10, w / 2, w / 2, w / 2);
      g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(0.45, 'rgba(255,143,184,0.55)'); g.addColorStop(1, 'rgba(124,196,245,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, w);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 3;
      for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.arc(w / 2, w / 2, 30 + i * 16, i, i + 2.4); ctx.stroke(); }
    });
    const portal = new THREE.Mesh(new THREE.CircleGeometry(1.35, 48), new THREE.MeshBasicMaterial({ map: portalTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    portal.position.y = 1.45;
    gate.add(arch, portal);
    gate.userData.portal = portal;
  }
  scene.add(gate);

  // fountain with ballistic spray
  const fountain = new THREE.Group();
  fountain.position.copy(FOUNTAIN);
  const spray = { n: 320, pos: null, vel: null, points: null };
  {
    const stone = new THREE.MeshStandardMaterial({ color: '#F1E6DA', roughness: 0.55, side: THREE.DoubleSide });
    // basin, pedestal and upper bowl are turned profiles: mouldings outside, a rolled rim, a real inside
    const stonework = new THREE.Mesh(merge([
      part(lathe([
        [1.86, 0], [1.86, 0.08, 1], [1.8, 0.1], [1.775, 0.16], [1.76, 0.33], [1.79, 0.38], [1.84, 0.42], [1.845, 0.47], [1.8, 0.5],
        [1.66, 0.5], [1.62, 0.475], [1.6, 0.42], [1.58, 0.1, 1], [0, 0.1],
      ], 56)),
      part(lathe([[0.3, 0.1], [0.3, 0.3, 1], [0.24, 0.34], [0.2, 0.42], [0.15, 0.5], [0.13, 0.8], [0.16, 0.9], [0.185, 0.94], [0.14, 0.98], [0.12, 1.02]], 20)),
      part(lathe([
        [0.1, 0.98], [0.2, 1.0], [0.38, 1.07], [0.47, 1.15], [0.5, 1.19], [0.5, 1.22], [0.475, 1.235], [0.45, 1.215], [0.34, 1.13], [0.18, 1.08], [0.07, 1.075, 1],
        [0.07, 1.3], [0.09, 1.33], [0.05, 1.4], [0.03, 1.43], [0, 1.435],
      ], 32)),
    ]), stone);
    stonework.castShadow = stonework.receiveShadow = true;
    // water: the pool with a few standing ripples, and the little pool in the upper bowl
    const pool = new THREE.RingGeometry(0.14, 1.6, 48, 7).rotateX(-Math.PI / 2);
    {
      const p = pool.attributes.position;
      for (let i = 0; i < p.count; i++) { const d = Math.hypot(p.getX(i), p.getZ(i)); p.setY(i, 0.36 + 0.005 * Math.sin(d * 13) * (1 - d / 1.6)); }
      pool.computeVertexNormals();
    }
    const water = new THREE.Mesh(merge([part(pool), part(new THREE.RingGeometry(0.07, 0.425, 28, 1).rotateX(-Math.PI / 2), 0, 1.2, 0)]),
      new THREE.MeshPhysicalMaterial({ color: '#7CC4F5', roughness: 0.08, transparent: true, opacity: 0.85, clearcoat: 1 }));
    fountain.add(stonework, water);
    spray.pos = new Float32Array(spray.n * 3);
    spray.vel = new Float32Array(spray.n * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(spray.pos, 3));
    spray.points = new THREE.Points(geo, new THREE.PointsMaterial({ color: '#DDF3FF', size: 0.07, transparent: true, opacity: 0.85, depthWrite: false }));
    spray.points.frustumCulled = false;
    fountain.add(spray.points);
    for (let i = 0; i < spray.n; i++) spray.pos[i * 3 + 1] = -10;
  }
  scene.add(fountain);
  function respawnDrop(i) {
    const a = Math.random() * Math.PI * 2, sp = 0.35 + Math.random() * 0.5;
    spray.pos[i * 3] = 0; spray.pos[i * 3 + 1] = 1.45; spray.pos[i * 3 + 2] = 0;
    spray.vel[i * 3] = Math.cos(a) * sp; spray.vel[i * 3 + 1] = 3.0 + Math.random() * 0.9; spray.vel[i * 3 + 2] = Math.sin(a) * sp;
  }

  // falling leaves and petals: gravity, drag towards the wind, flutter, land, then fade and respawn
  const LEAF_N = 170;
  const leafMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.13, 0.085), new THREE.MeshStandardMaterial({ roughness: 0.7, side: THREE.DoubleSide }), LEAF_N);
  leafMesh.frustumCulled = false;
  const leaves = Array.from({ length: LEAF_N }, (_, i) => ({ p: new THREE.Vector3(0, -50, 0), v: new THREE.Vector3(), rot: new THREE.Euler(), spin: new THREE.Vector3(), rest: Math.random() * 6, landed: true, i }));
  {
    const cols = ['#FFB3CC', '#FF8FB8', '#FFD86B', '#9ED69A', '#FFC4D8', '#F6E3A0'];
    leaves.forEach((l, i) => leafMesh.setColorAt(i, new THREE.Color(cols[i % cols.length])));
  }
  detail.add(leafMesh);
  const _m4 = new THREE.Matrix4(), _qq = new THREE.Quaternion(), _sc = new THREE.Vector3();
  function respawnLeaf(l) {
    const tops = garden.userData.treeTops;
    const tp = tops[Math.floor(Math.random() * tops.length)];
    l.p.set(tp.x + (Math.random() - 0.5) * 2.2, 2.2 + Math.random() * 1.6, tp.z + (Math.random() - 0.5) * 2.2);
    l.v.set(0, 0, 0);
    l.spin.set(Math.random() * 4 - 2, Math.random() * 4 - 2, Math.random() * 4 - 2);
    l.landed = false;
  }

  // Grok Bot pavilion: one floating shape per reported bot
  const grok = new THREE.Group();
  grok.position.copy(GROK_POS);
  grok.rotation.y = faceCenter(GROK_POS);
  const grokBots = new Map();
  {
    const white = new THREE.MeshPhysicalMaterial({ color: '#FFFFFF', roughness: 0.25, clearcoat: 0.8 });
    const black = new THREE.MeshStandardMaterial({ color: '#0A0A0A', roughness: 0.35, metalness: 0.3 });
    // stepped base, three ribs rising to a crown ring (clear of the bots' orbit and below the label)
    const ribs = [0, 1, 2].map((k) => part(tube([[2.78, 0.2, 0], [2.74, 1.3, 0], [2.4, 2.3, 0], [1.6, 2.86, 0], [1.0, 2.95, 0]], 0.06, 22, 8), 0, 0, 0, 0, (k / 3) * Math.PI * 2 + Math.PI / 6));
    const feet = [0, 1, 2].map((k) => part(lathe([[0.16, 0], [0.16, 0.04, 1], [0.1, 0.08], [0.07, 0.2]], 12), 2.78, 0.25, 0).rotateY((k / 3) * Math.PI * 2 + Math.PI / 6));
    const base = new THREE.Mesh(merge([
      part(lathe([[0, 0], [3.15, 0, 1], [3.15, 0.1], [3.11, 0.14, 1], [3.06, 0.14, 1], [3.06, 0.2], [3.0, 0.25, 1], [0, 0.25]], 72)),
      ...ribs, ...feet,
      part(new THREE.TorusGeometry(1.0, 0.07, 10, 48), 0, 2.95, 0, Math.PI / 2),
    ]), white);
    const plinth = new THREE.Mesh(merge([
      part(lathe([[2.96, 0.25], [2.96, 0.285], [2.93, 0.296], [2.89, 0.285], [2.88, 0.25]], 72)),
      part(lathe([[0.62, 0.25], [0.62, 0.31, 1], [0.55, 0.33], [0.5, 0.4], [0.4, 0.75], [0.42, 1.0], [0.47, 1.1], [0.47, 1.15, 1], [0.43, 1.155], [0, 1.155]], 36)),
    ]), black);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.42, 32), new THREE.MeshBasicMaterial({ color: '#FFFFFF', toneMapped: false }));
    disc.rotation.x = -Math.PI / 2; disc.position.y = 1.16;
    for (const m of [base, plinth]) { m.castShadow = m.receiveShadow = true; grok.add(m); }
    grok.add(disc);
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 512; labelCanvas.height = 136;
    const labelTex = new THREE.CanvasTexture(labelCanvas);
    labelTex.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex, transparent: true, depthWrite: false, toneMapped: false }));
    label.scale.set(3, 0.8, 1);
    label.position.y = 3.6;
    grok.add(label);
    grok.userData.label = { canvas: labelCanvas, tex: labelTex };
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(3.1, 3.1, 4, 16), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = 2;
    hit.userData.grok = true;
    grok.add(hit);
    grok.userData.hit = hit;
  }
  scene.add(grok);
  let grokData = { name: 'Grok Bot', bots: [] };
  function drawGrokLabel() {
    const { canvas, tex } = grok.userData.label;
    const n = grokData.bots.length, need = grokData.bots.filter((b) => b.status === 'waiting').length;
    drawLabel(canvas.getContext('2d'), 512, 136, grokData.name || 'Grok Bot', n ? `${n} bot${n > 1 ? 's' : ''}${need ? ` · ${need} need you` : ''}` : 'No bots reporting', need ? STATUS.waiting : '#0A0A0A', !n);
    tex.needsUpdate = true;
  }
  function setExternal(list) {
    grokData = (list || []).find((x) => x.source === 'grok') || { name: 'Grok Bot', bots: [] };
    const seen = new Set();
    grokData.bots.slice(0, 8).forEach((b, i, arr) => {
      seen.add(b.id);
      let e = grokBots.get(b.id);
      if (!e || e.shape !== b.shape) {
        if (e) grok.remove(e.group);
        const group = new THREE.Group();
        const mat = new THREE.MeshPhysicalMaterial({ color: b.color || PASTEL[i % PASTEL.length], roughness: 0.25, clearcoat: 0.6 });
        const mesh = new THREE.Mesh(BOT_SHAPES[b.shape](), mat);
        mesh.castShadow = true;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.035, 8, 48), new THREE.MeshBasicMaterial({ toneMapped: false }));
        ring.rotation.x = Math.PI / 2; ring.position.y = -0.5;
        const alert = new THREE.Sprite(new THREE.SpriteMaterial({ map: alertTexture, transparent: true, depthWrite: false, toneMapped: false }));
        alert.scale.setScalar(0.45); alert.position.y = 0.7;
        group.add(mesh, ring, alert);
        grok.add(group);
        e = { group, mesh, ring, alert, shape: b.shape, phase: Math.random() * 6 };
        grokBots.set(b.id, e);
      }
      const a = (i / Math.max(arr.length, 1)) * Math.PI * 2;
      e.home = new THREE.Vector3(Math.cos(a) * 1.9, 1.7, Math.sin(a) * 1.9);
      e.status = b.status;
      e.mesh.material.color.set(b.color || PASTEL[i % PASTEL.length]);
      e.ring.material.color.set(BOT_STATUS_COLOR[b.status] || BOT_STATUS_COLOR.idle);
      e.alert.visible = b.status === 'waiting';
      if (REDUCED_MOTION) e.group.position.copy(e.home);
    });
    for (const [id, e] of grokBots) if (!seen.has(id)) { grok.remove(e.group); grokBots.delete(id); }
    drawGrokLabel();
  }

  // ---- Skill Library bookcase
  const library = new THREE.Group();
  {
    const caseMat = new THREE.MeshStandardMaterial({ color: '#FFFFFF', roughness: 0.4 });
    const caseGeo = merge([
      part(RB(0.72, 1.7, 0.04, 0.01, 1), 0, 0.85, -0.14),               // back
      part(RB(0.04, 1.74, 0.32, 0.01, 1), -0.34, 0.87, 0), part(RB(0.04, 1.74, 0.32, 0.01, 1), 0.34, 0.87, 0),
      ...[0.04, 0.46, 0.88, 1.3, 1.68].map((y) => part(RB(0.72, 0.035, 0.32, 0.008, 1), 0, y, 0)),
      part(RB(0.76, 0.05, 0.35, 0.012, 1), 0, 1.745, 0.005),            // cornice
      part(RB(0.7, 0.05, 0.02, 0.006, 1), 0, 0.022, 0.13),              // kick board
    ]);
    // A book in unit size (scaled per instance to thickness, height, depth): spine and two boards
    // take the instance colour; the page block is a separate white mesh set back from the edges.
    const coverGeo = merge([
      part(new THREE.BoxGeometry(1, 1, 0.07), 0, 0, 0.465),
      part(new THREE.BoxGeometry(0.13, 1, 0.93), -0.435, 0, -0.035), part(new THREE.BoxGeometry(0.13, 1, 0.93), 0.435, 0, -0.035),
    ]);
    const pagesGeo = new THREE.BoxGeometry(0.74, 0.94, 0.9).translate(0, 0, -0.02);
    const caseM = [], bookM = [], bookC = [];
    const r = TX.rng(55);
    for (let k = -2; k <= 2; k++) {
      const a = LIB_ANGLE + k * 0.165;
      const p = polar(LIB_R, a);
      const seg = local(p.x, 0, p.z, Math.atan2(Math.cos(a), Math.sin(a))); // front faces away from Minju
      caseM.push(seg);
      const put = (x, y, w, h, d, tilt) => {
        const front = 0.125 - r() * 0.025;
        bookM.push(seg.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(x, y, front - d / 2), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, tilt)), new THREE.Vector3(w, h, d))));
        bookC.push(new THREE.Color(PASTEL[Math.floor(r() * PASTEL.length)]).offsetHSL(0, 0, (r() - 0.5) * 0.15));
      };
      for (const y of [0.06, 0.48, 0.9, 1.32]) {
        let x = -0.3;
        while (x < 0.27) {
          const w = 0.03 + r() * 0.04, h = 0.22 + r() * 0.15, d = 0.17 + r() * 0.05, roll = r();
          if (roll < 0.07) { x += w + 0.015; continue; }                       // a gap on the shelf
          if (roll < 0.14 && x + h * 0.8 < 0.3) {                              // a short stack lying flat
            let top = y;
            for (let s = 0; s < 3; s++) { const t = 0.028 + r() * 0.028, len = h * 0.8 - s * 0.025; put(x + h * 0.4, top + t / 2, t, len, d, Math.PI / 2); top += t + 0.001; }
            x += h * 0.8 + 0.012;
            continue;
          }
          if (x + w > 0.3) break;
          const lean = roll > 0.9 ? 0.16 : 0, slip = h * lean * 0.5;
          put(x + slip + w / 2, y + h / 2, w, h, d, lean);
          x += w + 0.004 + slip * 2;
        }
      }
    }
    library.add(instanced(caseGeo, caseMat, caseM));
    library.add(instanced(coverGeo, new THREE.MeshStandardMaterial({ roughness: 0.6 }), bookM, { colors: bookC }));
    library.add(instanced(pagesGeo, M.paper, bookM, { shadow: false }));
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 512; labelCanvas.height = 136;
    const labelTex = new THREE.CanvasTexture(labelCanvas);
    labelTex.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex, transparent: true, depthWrite: false, toneMapped: false }));
    label.scale.set(2.1, 0.56, 1);
    label.position.copy(polar(LIB_R - 0.2, LIB_ANGLE)).setY(2.45);
    library.add(label);
    library.userData.label = { canvas: labelCanvas, tex: labelTex };
    const hit = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.2, 4), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.copy(polar(LIB_R + 0.2, LIB_ANGLE)).setY(1.1);
    hit.userData.library = true;
    library.add(hit);
    library.userData.hit = hit;
  }
  scene.add(library);
  function drawLibraryLabel() {
    const { canvas, tex } = library.userData.label;
    drawLabel(canvas.getContext('2d'), 512, 136, 'Skill Library', 'Skills · Plugins · MCP', '#8A7CF0', false, true);
    tex.needsUpdate = true;
  }

  // ---- Minju's dispatch desk
  // A C-shaped counter round her seat: she faces -Z (where agents come to wave), the way in is
  // behind her at +Z. Counter, plinth wall and light strip all share that opening.
  const minju = new THREE.Group();
  scene.add(minju);
  const mj = { ring: new THREE.MeshBasicMaterial({ color: '#FF5C9A', toneMapped: false }), holo: [] };
  {
    const a0 = Math.PI * 0.12, arc = Math.PI * 1.76;
    // counter top in section: bullnosed inner and outer edges, and a recessed field that holds a birch inlay
    const topProfile = [
      [2.235, 0.8], [3.165, 0.8], [3.19, 0.81], [3.2, 0.835], [3.2, 0.895], [3.19, 0.92], [3.165, 0.93],
      [3.07, 0.93, 1], [3.062, 0.922, 1], [2.338, 0.922, 1], [2.33, 0.93, 1],
      [2.235, 0.93], [2.21, 0.92], [2.2, 0.895], [2.2, 0.835], [2.21, 0.81], [2.235, 0.8],
    ];
    const deskGeo = merge([part(lathe(topProfile, 112, a0, arc)), latheCap(topProfile, a0), latheCap(topProfile, a0 + arc, true)]);
    const desk = new THREE.Mesh(deskGeo, new THREE.MeshPhysicalMaterial({ color: '#FFFFFF', roughness: 0.18, clearcoat: 0.8, clearcoatRoughness: 0.15 }));
    desk.castShadow = desk.receiveShadow = true;
    minju.add(desk);
    // inlay: grain runs round the counter, one board every two metres like the agents' desks
    const inlay = new THREE.Mesh(uvScale(lathe([[3.06, 0.928], [2.34, 0.928]], 112, a0, arc), 0.5, 1), M.wood);
    inlay.receiveShadow = true;
    minju.add(inlay);
    const glowRing = new THREE.Mesh(new THREE.TorusGeometry(2.7, 0.025, 6, 112, arc), mj.ring);
    glowRing.rotation.x = -Math.PI / 2;
    glowRing.rotation.z = Math.PI * 1.62;
    glowRing.position.y = 0.78;
    minju.add(glowRing);
    // plinth wall: kick plate, two shadow grooves and a cornice under the counter
    const wall = (y) => 2.6 - (y - 0.09) * (0.14 / 0.61);
    const groove = (y) => [[wall(y - 0.01), y - 0.01, 1], [wall(y) - 0.014, y - 0.004], [wall(y) - 0.014, y + 0.004], [wall(y + 0.01), y + 0.01, 1]];
    const wallProfile = [
      [2.5, 0], [2.66, 0, 1], [2.66, 0.07], [2.645, 0.085], [2.6, 0.09, 1], ...groove(0.3), ...groove(0.52),
      [2.46, 0.7, 1], [2.5, 0.72], [2.5, 0.8, 1], [2.38, 0.8, 1], [2.5, 0],
    ];
    const pedestal = new THREE.Mesh(
      merge([part(lathe(wallProfile, 88, a0, arc)), latheCap(wallProfile, a0), latheCap(wallProfile, a0 + arc, true)]),
      new THREE.MeshStandardMaterial({ color: '#FFD6E5', roughness: 0.5, side: THREE.DoubleSide }));
    pedestal.castShadow = pedestal.receiveShadow = true;
    minju.add(pedestal);

    // three monitors with dashboards, facing Minju, each on a pole with a jointed arm
    const dash = (seed) => canvasTexture(256, 148, (ctx, w, h) => {
      const r = TX.rng(seed);
      ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#FF5C9A'; ctx.fillRect(0, 0, w, 12);
      for (let i = 0; i < 8; i++) { ctx.fillStyle = PASTEL[i % PASTEL.length]; const bh = 20 + r() * 70; ctx.fillRect(14 + i * 15, h - 14 - bh, 10, bh); }
      ctx.lineWidth = 12; ctx.strokeStyle = '#F2F3F7'; ctx.beginPath(); ctx.arc(200, 70, 30, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#7CC4F5'; ctx.beginPath(); ctx.arc(200, 70, 30, -Math.PI / 2, -Math.PI / 2 + r() * 5); ctx.stroke();
      for (let i = 0; i < 3; i++) { ctx.fillStyle = '#E3E6EC'; ctx.fillRect(150, 112 + i * 9, 90, 4); }
    });
    const joint = new THREE.CylinderGeometry(0.028, 0.028, 0.05, 12);
    const monDark = merge([
      part(RB(1.2, 0.72, 0.035, 0.014, 2), 0, 1.4, 2.6175),
      part(RB(0.7, 0.42, 0.05, 0.02, 1), 0, 1.4, 2.66),
      part(RB(0.14, 0.14, 0.03, 0.008, 1), 0, 1.4, 2.7),
      part(tube([[0.2, 1.22, 2.675], [0.24, 1.08, 2.76], [0.2, 0.97, 2.9], [0.17, 0.92, 2.93]], 0.008, 8, 5)),
      part(lathe([[0.018, 0], [0.032, 0], [0.032, 0.004], [0.018, 0.004]], 10), 0.17, 0.928, 2.93),
    ]);
    const monArm = merge([
      part(lathe([[0, 0], [0.07, 0], [0.076, 0.006], [0.076, 0.016], [0.04, 0.024], [0.024, 0.03], [0.024, 0.5], [0.03, 0.5], [0.03, 0.56], [0, 0.565]], 14), 0, 0.928, 3.0),
      part(lathe([[0.024, 0], [0.036, 0.004], [0.036, 0.05], [0.024, 0.054]], 14), 0, 1.373, 3.0),
      part(rod([0, 1.4, 3.0], [-0.17, 1.4, 2.87], 0.017, 0.017, 8, true)),
      part(joint, -0.17, 1.4, 2.87),
      part(rod([-0.17, 1.4, 2.87], [0, 1.4, 2.745], 0.017, 0.017, 8, true)),
      part(joint, 0, 1.4, 2.745),
      part(new THREE.CylinderGeometry(0.022, 0.022, 0.1, 10), 0, 1.4, 2.722, 0, 0, Math.PI / 2),
    ]);
    const darkParts = [], armParts = [
      part(new THREE.TorusGeometry(2.36, 0.02, 6, 16, 0.5), 0, 0.12, 0, Math.PI / 2, 0, -Math.PI / 2 - 0.25),   // foot rail
      ...[-0.2, 0.2].map((a) => part(rod([Math.sin(a) * 2.36, 0.12, -Math.cos(a) * 2.36], [Math.sin(a) * 2.5, 0.12, -Math.cos(a) * 2.5], 0.014, 0.014, 6))),
    ];
    for (const [ang, seed] of [[-0.6, 1], [0, 2], [0.6, 3]]) {
      const holder = new THREE.Group();
      holder.rotation.y = Math.PI + ang;
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(1.13, 0.65), new THREE.MeshBasicMaterial({ map: dash(seed), toneMapped: false }));
      scr.position.set(0, 1.4, 2.598);
      scr.rotation.y = Math.PI;
      holder.add(scr);
      minju.add(holder);
      darkParts.push(spunY(monDark, Math.PI + ang));
      armParts.push(spunY(monArm, Math.PI + ang));
    }
    const mons = new THREE.Mesh(boxUV(merge(darkParts)), M.dark), monArms = new THREE.Mesh(boxUV(merge(armParts)), M.metalDark);
    mons.castShadow = monArms.castShadow = true;
    minju.add(mons, monArms);

    // keyboard and mouse
    const kb = new THREE.Group();
    const kbBody = new THREE.Mesh(boxUV(merge([
      part(RB(0.5, 0.02, 0.16, 0.008, 1)),
      part(new THREE.SphereGeometry(1, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0.4, -0.01, 0.01, 0, 0, 0, 0.032, 0.03, 0.052),
    ])), M.plastic);
    kbBody.castShadow = true;
    const kbKeys = new THREE.Mesh(new THREE.PlaneGeometry(0.47, 0.14), M.keys);
    kbKeys.rotation.x = -Math.PI / 2; kbKeys.position.y = 0.011;
    kb.add(kbBody, kbKeys);
    kb.position.set(0, 0.94, -2.31);
    kb.rotation.y = Math.PI;
    minju.add(kb);

    // a bowl of ramyeon (allegedly not hers) and a bubble tea; everything merged per material
    const snack = new THREE.Group();
    const bowlMat = new THREE.MeshStandardMaterial({ color: '#E8506A', roughness: 0.3, side: THREE.DoubleSide });
    const soupMat = new THREE.MeshStandardMaterial({ color: '#E87B3A', roughness: 0.25 });
    const noodleMat = new THREE.MeshStandardMaterial({ color: '#FFE08A', roughness: 0.5 });
    const stickMat = new THREE.MeshStandardMaterial({ color: '#C99A72' });
    const TEA = [-1.9, 0, -0.08];   // bubble tea, relative to the bowl
    const bowlProfile = [
      [0, 0.006], [0.05, 0.006], [0.056, 0], [0.07, 0], [0.076, 0.012], [0.088, 0.022], [0.126, 0.062], [0.152, 0.115], [0.16, 0.15], [0.164, 0.158],
      [0.161, 0.164], [0.155, 0.158], [0.148, 0.12], [0.12, 0.066], [0.08, 0.036], [0, 0.03],
    ];
    const r = TX.rng(77);
    const noodles = [];
    for (let i = 0; i < 6; i++) { // loose coils lying in the soup
      const cx = (r() - 0.5) * 0.09, cz = (r() - 0.5) * 0.09, rad = 0.035 + r() * 0.04, ph = r() * 6, pts = [];
      for (let k = 0; k < 9; k++) {
        const a = (k / 9) * Math.PI * 2;
        const rr = Math.min(rad * (1 + 0.22 * Math.sin(a * 3 + ph)), 0.13 - Math.hypot(cx, cz));
        pts.push([cx + Math.cos(a) * rr, 0.133 + 0.007 * Math.sin(a * 2 + ph) + i * 0.0015, cz + Math.sin(a) * rr]);
      }
      noodles.push(part(tube(pts, 0.0065, 30, 5, true)));
    }
    noodles.push(part(new THREE.SphereGeometry(0.019, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), -0.075, 0.146, 0.05, 0, 0, 0, 1, 0.6, 1)); // yolk
    const scallions = [];
    for (let i = 0; i < 8; i++) {
      const a = r() * Math.PI * 2, d = 0.02 + r() * 0.09;
      scallions.push(part(new THREE.TorusGeometry(0.007, 0.0028, 4, 8), Math.cos(a) * d, 0.142 + r() * 0.004, Math.sin(a) * d, Math.PI / 2 + (r() - 0.5) * 0.8, 0, r() * 3));
    }
    const pieces = [
      [merge([
        part(lathe(bowlProfile, 30)),
        part(rod([0.008, 0.1, 0], [0.028, 0.222, 0.012], 0.0048, 0.0048, 6, true), ...TEA),                    // straw
        part(lathe([[0.0412, 0.04], [0.0447, 0.085]], 16), ...TEA),                                           // cup sleeve
      ]), bowlMat],
      [new THREE.CircleGeometry(0.149, 30).rotateX(-Math.PI / 2).translate(0, 0.13, 0), soupMat],
      [merge(noodles), noodleMat],
      [merge([
        part(rod([-0.2, 0.171, 0.085], [0.17, 0.169, -0.02], 0.0058, 0.004, 6, true)),
        part(rod([-0.2, 0.171, 0.06], [0.172, 0.169, 0.005], 0.0058, 0.004, 6, true)),
      ]), stickMat],
      [merge([
        part(new THREE.SphereGeometry(0.036, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), -0.075, 0.131, 0.05, 0, 0, 0, 1, 0.5, 1.25), // egg white
        part(lathe([[0, 0], [0.034, 0], [0.037, 0.004], [0.046, 0.12], [0.049, 0.122], [0.049, 0.128], [0.044, 0.133], [0.036, 0.15], [0.02, 0.16], [0, 0.162]], 18), ...TEA),
      ]), M.ceramic],
      [merge(scallions), M.succulent],
      [merge([part(RB(0.085, 0.1, 0.004, 0.002, 1), 0.07, 0.165, -0.1, -0.5, -0.5, 0)]), M.dark],            // a sheet of gim tucked in at the rim
    ];
    for (const [geo, mat] of pieces) { const m = new THREE.Mesh(geo, mat); m.castShadow = true; snack.add(m); }
    snack.position.set(1.15, 0.928, -2.42);
    minju.add(snack);

    // tall pouf (a turned profile with a base ring and piping round the seat), pulled in so her
    // hands reach the keys; her feet rest on a rail fixed to the inside of the plinth
    const stool = new THREE.Mesh(uvScale(lathe([
      [0, 0], [0.25, 0], [0.266, 0.012], [0.27, 0.03], [0.26, 0.046], [0.27, 0.2], [0.3, 0.48], [0.308, 0.53], [0.3, 0.57], [0.27, 0.596], [0.19, 0.607], [0, 0.61],
    ], 28), 2), M.fabric);
    stool.position.set(0, 0, -1.9);
    stool.castShadow = true;
    minju.add(stool);
    const avatar = makeAvatar(new THREE.Color('#FF8FB8'), { scale: 1.12, seed: 'minju', minju: true });
    avatar.position.set(0, 0.1, -1.9);
    avatar.rotation.y = Math.PI;
    minju.add(avatar);
    minju.userData.avatar = avatar;

    // hologram: a nested wire core inside two instrument rings (graduations, nodes, dashes)
    const holo = new THREE.Group();
    holo.position.y = 4.2;
    mj.holo = [
      new THREE.MeshBasicMaterial({ color: '#FF5C9A', wireframe: true, transparent: true, opacity: 0.9, toneMapped: false }),
      new THREE.MeshBasicMaterial({ color: '#7CC4F5', transparent: true, opacity: 0.8, toneMapped: false }),
      new THREE.MeshBasicMaterial({ color: '#FFB3CC', transparent: true, opacity: 0.6, toneMapped: false }),
    ];
    const core = new THREE.Mesh(merge([part(new THREE.IcosahedronGeometry(0.55, 1)), part(new THREE.IcosahedronGeometry(0.26, 0), 0, 0, 0, 0.5, 0.3, 0)]), mj.holo[0]);
    const ring1 = [part(new THREE.TorusGeometry(1.0, 0.02, 6, 96)), part(new THREE.TorusGeometry(0.88, 0.007, 4, 72))];
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2, len = i % 3 ? 0.05 : 0.1;
      ring1.push(part(new THREE.BoxGeometry(len, 0.012, 0.012), Math.cos(a) * (0.985 - len / 2), Math.sin(a) * (0.985 - len / 2), 0, 0, 0, a));
    }
    for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2 + 0.4; ring1.push(part(new THREE.SphereGeometry(0.05, 10, 8), Math.cos(a), Math.sin(a), 0)); }
    const ring2 = [part(new THREE.TorusGeometry(1.42, 0.006, 4, 96))];
    for (let i = 0; i < 12; i++) ring2.push(part(new THREE.TorusGeometry(1.3, 0.018, 6, 8, 0.36), 0, 0, 0, 0, 0, (i / 12) * Math.PI * 2));
    const r1 = new THREE.Mesh(merge(ring1), mj.holo[1]);
    const r2 = new THREE.Mesh(merge(ring2), mj.holo[2]);
    const coreGlow = makeGlow('#FF5C9A', 3.2);
    holo.add(core, r1, r2, coreGlow);
    minju.add(holo);
    minju.userData.holo = { holo, core, r1, r2, coreGlow };

    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 512; labelCanvas.height = 136;
    const labelTex = new THREE.CanvasTexture(labelCanvas);
    labelTex.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex, transparent: true, depthWrite: false, toneMapped: false }));
    label.scale.set(3.4, 0.9, 1);
    label.position.y = 5.9;
    minju.add(label);
    minju.userData.label = { canvas: labelCanvas, tex: labelTex };

    const hit = new THREE.Mesh(new THREE.CylinderGeometry(3.3, 3.3, 6, 16), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = 3;
    hit.userData.minju = true;
    minju.add(hit);
    minju.userData.hit = hit;
  }
  function drawMinjuLabel() {
    const { canvas, tex } = minju.userData.label;
    drawLabel(canvas.getContext('2d'), 512, 136, "Minju's Desk", 'Dispatch · Ask Input', '#FF5C9A', false, true);
    tex.needsUpdate = true;
  }

  // ---- desks (static parts instanced across every slot)
  const desks = [];
  const deskMatrices = [];
  const props = { mug: [], mugC: [], plant: [], lamp: [], note: [], noteC: [] };
  RINGS.forEach(({ r, n }, ri) => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (ri % 2 ? Math.PI / n : 0) + Math.PI / 2;
      const dummy = new THREE.Object3D();
      dummy.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      dummy.lookAt(0, 0, 0);
      dummy.updateMatrix();
      const m = dummy.matrix.clone();
      deskMatrices.push(m);
      const pr = TX.rng(desks.length * 17 + 5);
      const hasLamp = pr() < 0.55;
      if (pr() < 0.75) { props.mug.push(m.clone().multiply(local(0.62, 0.78, -0.22, pr() * 6))); props.mugC.push(new THREE.Color(PASTEL[Math.floor(pr() * PASTEL.length)])); }
      if (pr() < 0.5) props.plant.push(m.clone().multiply(local(0.78, 0.78, 0.3, pr() * 6)));
      if (hasLamp) props.lamp.push(m.clone().multiply(local(-0.82, 0.78, 0.32, 0)));
      if (pr() < 0.6) { props.note.push(m.clone().multiply(local(-0.52, 0.781, -0.2, (pr() - 0.5) * 0.6))); props.noteC.push(new THREE.Color(PASTEL[Math.floor(pr() * PASTEL.length)])); }
      const d = new Desk(desks.length, dummy.position, m, hasLamp ? new THREE.Vector3(-0.57, 1.12, 0.32) : null);
      d.ringIndex = ri;
      d.chair = polar(r + 0.84, a);
      d.yaw = faceCenter(dummy.position);
      scene.add(d.group);
      desks.push(d);
    }
  });
  {
    const T = deskTemplates();
    const P = propTemplates();
    const add = (geo, mat, list, opts) => scene.add(instanced(geo, mat, list, opts));
    add(T.wood, M.wood, deskMatrices, { receive: true });
    add(T.frame, M.frame, deskMatrices);
    add(T.dark, M.dark, deskMatrices);
    add(T.plastic, M.plastic, deskMatrices);
    add(T.keys, M.keys, deskMatrices, { shadow: false });
    add(T.fabric, M.fabric, deskMatrices);
    add(T.chairFrame, M.chairFrame, deskMatrices);
    const pd = new THREE.Group();
    detail.add(pd);
    pd.add(instanced(P.mug, M.ceramic, props.mug, { colors: props.mugC }));
    pd.add(instanced(P.pot, M.ceramic, props.plant));
    pd.add(instanced(P.leaves, M.succulent, props.plant));
    pd.add(instanced(P.notebook, M.paper, props.note, { colors: props.noteC }));
    scene.add(instanced(P.lampBody, M.frame, props.lamp));
    scene.add(instanced(P.lampBulb, M.lampGlow, props.lamp, { shadow: false }));
  }
  const seatOrder = desks.map((d, i) => i).sort((a, b) => {
    const ra = desks[a].group.position.length(), rb = desks[b].group.position.length();
    if (Math.abs(ra - rb) > 1) return ra - rb;
    return desks[b].group.position.z - desks[a].group.position.z;
  });
  const assignment = new Map();

  const cables = new Map();
  function cableFor(desk) {
    let line = cables.get(desk);
    if (!line) {
      const p = desk.group.position;
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0.03, 0), new THREE.Vector3(p.x / 2, 0.03, p.z / 2), new THREE.Vector3(p.x, 0.03, p.z));
      line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(24)), new THREE.LineBasicMaterial({ transparent: true, opacity: 0, toneMapped: false }));
      scene.add(line);
      cables.set(desk, line);
    }
    return line;
  }
  function refreshCable(desk, line) {
    const s = desk.session;
    if (!s) { line.material.opacity = 0; return; }
    const ended = s.status === 'ended' || s.status === 'stale';
    line.material.color.set(statusColor(s.status));
    line.material.opacity = ended ? 0.08 : s.status === 'waiting' ? 0.9 : 0.55;
  }

  const packetGeo = new THREE.SphereGeometry(0.1, 12, 8);
  const packets = [];
  function pulse(sessionId, dir = 'in', color) {
    const desk = assignment.get(sessionId);
    if (!desk || REDUCED_MOTION || packets.length > 80) return;
    const p = desk.group.position;
    const from = dir === 'in' ? new THREE.Vector3(p.x, 2.0, p.z) : new THREE.Vector3(0, 4.2, 0);
    const to = dir === 'in' ? new THREE.Vector3(0, 4.2, 0) : new THREE.Vector3(p.x, 2.0, p.z);
    const mid = from.clone().add(to).multiplyScalar(0.5);
    mid.y += 3 + p.length() * 0.12;
    const c = color || (dir === 'in' ? STATUS.working : '#FF5C9A');
    const mesh = new THREE.Mesh(packetGeo, new THREE.MeshBasicMaterial({ color: c, toneMapped: false }));
    const glow = makeGlow(c, 0.8);
    glow.material.opacity = 0.9 * env.glowGain;
    if (env.additive) glow.material.blending = THREE.AdditiveBlending;
    mesh.add(glow);
    scene.add(mesh);
    packets.push({ mesh, glow, curve: new THREE.QuadraticBezierCurve3(from, mid, to), t: 0, speed: 1 / (0.9 + p.length() * 0.03) });
  }

  // ---- time of day
  // ---- lamps at night: a pool of light on the ground under each one (both tiers), and on ultra
  // three real point lights that sit in whichever lamps are nearest to what the camera looks at
  const lampSpots = [
    ...streetGlows.map((s) => ({ position: s.position.clone(), power: 10, range: 13, d: 0 })),
    // desk lamps: the bulb hangs 0.25 m along the arm, 0.35 m over the desk top (see propTemplates)
    ...props.lamp.map((m) => ({ position: new THREE.Vector3(0.25, 0.3, 0).applyMatrix4(m), power: 0.12, range: 3, d: 0 })),
  ];
  const lampPools = createLightPools([
    ...streetGlows.map((s) => ({ position: new THREE.Vector3(s.position.x, 0.03, s.position.z), radius: 6.5 })),
    ...props.lamp.map((m) => ({ position: new THREE.Vector3(0.25, 0.008, 0).applyMatrix4(m), radius: 0.45 })),
  ], '#FFB870');
  scene.add(lampPools.mesh);
  const lampLights = [0, 1, 2].map(() => {
    const l = new THREE.PointLight('#FFC58A', 0, 12, 1.8);
    scene.add(l);
    return l;
  });
  function updateLampLights() {
    // only in close-ups: from the overview every lamp must look the same
    const zoom = 1 - THREE.MathUtils.smoothstep(camera.position.distanceTo(controls.target), 16, 34);
    if (quality !== 'ultra' || env.lamp < 0.02 || zoom <= 0) { for (const l of lampLights) l.intensity = 0; return; }
    for (const s of lampSpots) s.d = s.position.distanceTo(controls.target);
    lampSpots.sort((a, b) => a.d - b.d);
    // a light fades to nothing before it hops to another lamp: the weight is zero at the 4th nearest
    const edge = lampSpots[lampLights.length].d;
    lampLights.forEach((l, i) => {
      const s = lampSpots[i];
      l.position.copy(s.position);
      l.distance = s.range;
      l.intensity = s.power * env.lamp * zoom * THREE.MathUtils.clamp((edge - s.d) / 2.5, 0, 1);
    });
  }

  const ENV_SKY = 0.3; // how much of the hemisphere fill the reflections see overhead
  const env = { lamp: 0, glowGain: 0.5, additive: null, hour };
  const sunDir = new THREE.Vector3();
  function setTime(h) {
    env.hour = h;
    const k = sampleTime(h);
    const dayness = THREE.MathUtils.clamp((k.sunInt - 0.45) / 2.15, 0, 1);
    const night = THREE.MathUtils.clamp(k.lamp / 2.2, 0, 1);
    hemi.color.copy(k.c.hemiSky); hemi.groundColor.copy(k.c.hemiGround); hemi.intensity = k.hemiInt * 0.85;
    sun.color.copy(k.c.sun); sun.intensity = k.sunInt;
    sunDir.copy(k.sp).normalize();
    const fit = fitSunShadow(sun, sunDir, { ...SHADOW, mapSize: sun.shadow.mapSize.x });
    sun.shadow.normalBias = fit.texel * SHADOW.normalBiasTexels;
    sun.shadow.bias = -(SHADOW.minBias + fit.floorSlope * SHADOW.slopeTexels) / fit.depth;
    rim.position.set(-sunDir.x, 0.6 * Math.hypot(sunDir.x, sunDir.z) + 0.15, -sunDir.z).multiplyScalar(50);
    rim.intensity = 0.3 + 0.3 * dayness;
    earthshine.intensity = 0.1 + 0.45 * dayness; // the Earth's day side faces us by day
    renderer.toneMappingExposure = k.exposure;
    // the environment carries its own brightness per hour, so its intensity stays put
    scene.environmentIntensity = 1;
    const sunLin = k.c.sun.clone().multiplyScalar(k.sunInt), skyLin = k.c.hemiSky.clone().multiplyScalar(k.hemiInt * 0.85);
    const floorLin = sunLin.clone().multiplyScalar(Math.max(sunDir.y, 0)).add(skyLin).multiplyScalar(0.8 / Math.PI);
    orbitEnv.set(h, {
      sunDir: sunDir.clone(),
      sun: sunLin.multiplyScalar(2.2).toArray(),
      sky: skyLin.clone().multiplyScalar(ENV_SKY).toArray(),
      floor: [floorLin.r, floorLin.g * 0.97, floorLin.b * 0.95],
      earth: [0.10, 0.24, 0.6].map((v) => v * (0.12 + 1.0 * dayness)),
    });
    lampPools.set(k.lamp * 0.16);
    if (pipeline) {
      // only what is brighter than the sunlit floor blooms: a high bar by day, lower and wider at night
      Object.assign(pipeline.look, {
        threshold: 1.1 + 1.1 * dayness, knee: 0.5, bloom: 0.2 - 0.09 * dayness, spread: 0.62,
        ao: 0.75, saturation: 1.04, contrast: 0.06, vignette: 0.14 + 0.1 * night,
      });
    }
    M.leaf.color.copy(k.c.foliage);
    space.setTime(h, k, dayness);
    const win = THREE.MathUtils.clamp(k.window / 1.4, 0, 1);
    env.lamp = k.lamp;
    M.lampGlow.emissiveIntensity = k.lamp * 1.4;
    for (const s of streetGlows) s.material.opacity = Math.min(1, k.lamp * (pipeline ? 0.34 : 0.38)); // bloom adds its own
    minjuLight.intensity = 4 + k.window * 10;
    env.glowGain = 0.5 + 0.5 * (1 - dayness);
    const additive = win > 0.5;
    if (additive !== env.additive) {
      env.additive = additive;
      scene.traverse((o) => {
        if (o.isSprite && o.material.map === glowTexture) { o.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending; o.material.needsUpdate = true; }
      });
    }
    minju.userData.holo.coreGlow.material.opacity = 0.8 * env.glowGain;
  }

  // ---- quality
  function setQuality(q) {
    quality = q === 'standard' ? 'standard' : 'ultra';
    pipeline?.setQuality(quality);
    for (const l of lampLights) l.visible = quality === 'ultra'; // standard does not pay for them at all
    const size = Math.min(SHADOW.mapSize[quality], renderer.capabilities.maxTextureSize);
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      sun.shadow.map?.dispose(); sun.shadow.map = null;
    }
    detail.visible = quality === 'ultra';
    space.setQuality(quality);
    resize();
    setTime(env.hour);
  }

  function setUiTheme(name) {
    L = LABEL[name] || LABEL.light;
    drawMinjuLabel();
    drawGrokLabel();
    drawLibraryLabel();
    for (const d of desks) { d.labelKey = null; if (d.session) d.setSession(d.session, d.asks, d.selected); }
  }

  // ---- update from data
  const agents = new Map();
  const spots = new Set();
  const takeSpot = () => { let k = 0; while (spots.has(k)) k++; spots.add(k); return k; };
  const freeSpot = (k) => spots.delete(k);
  const shelves = new Set();
  const takeShelf = () => { let k = 0; while (shelves.has(k)) k++; shelves.add(k); return k; };
  const freeShelf = (k) => shelves.delete(k);
  let firstUpdate = true;
  function update(sessions, approvals, selId) {
    const live = new Set(sessions.map((s) => s.id));
    for (const ag of agents.values()) if (!live.has(ag.id)) { if (ag.spot >= 0) { freeSpot(ag.spot); ag.spot = -1; } ag.leaving = true; }
    for (const [id, desk] of assignment) {
      if (!live.has(id)) { desk.setSession(null); assignment.delete(id); cableFor(desk).material.opacity = 0; }
    }
    const ordered = [...sessions].sort((a, b) => a.startedAt - b.startedAt);
    for (const s of ordered) {
      let desk = assignment.get(s.id);
      if (!desk) {
        const free = seatOrder.find((i) => !desks[i].sessionId);
        if (free === undefined) continue;
        desk = desks[free];
        assignment.set(s.id, desk);
      }
      desk.setSession(s, approvals.filter((a) => a.sessionId === s.id).length, s.id === selId);
      refreshCable(desk, cableFor(desk));
      let ag = agents.get(s.id);
      if (!ag) { ag = new Agent(scene, s); agents.set(s.id, ag); }
      ag.leaving = false;
      ag.sync(s, desk, { initial: firstUpdate, takeSpot, freeSpot, takeShelf, freeShelf });
    }
    firstUpdate = false;
  }

  // ---- camera
  let camAnim = null;
  function flyTo(target, offset, ms = 1100) {
    camAnim = { t0: performance.now(), ms, fromT: controls.target.clone(), toT: target.clone(), fromC: camera.position.clone(), toC: target.clone().add(offset) };
  }
  const narrow = () => camera.aspect < 0.9;
  function focus(sessionId) {
    if (sessionId === 'library') {
      const out = polar(1, LIB_ANGLE);
      flyTo(polar(LIB_R + 0.8, LIB_ANGLE).setY(1.2), out.multiplyScalar(8.5).add(new THREE.Vector3(0, 4.2, 3)));
      return;
    }
    if (sessionId === 'grok') {
      const out = GROK_POS.clone().normalize();
      flyTo(GROK_POS.clone().setY(1.8), out.multiplyScalar(-7.5).add(new THREE.Vector3(out.z * 4, 5.5, -out.x * 4)));
      return;
    }
    if (sessionId === 'minju' || !sessionId) {
      // over Minju's shoulder: her dashboards, keyboard and (definitely not her) ramyeon
      if (narrow()) flyTo(new THREE.Vector3(0, 1.2, -2.3), new THREE.Vector3(1.2, 3.4, 4.6));
      else flyTo(new THREE.Vector3(0.2, 1.25, -2.4), new THREE.Vector3(1.6, 2.2, 3.4));
      return;
    }
    const desk = assignment.get(sessionId);
    if (!desk) return;
    const p = desk.group.position;
    const outward = p.clone().setY(0).normalize();
    const tgt = new THREE.Vector3(p.x, 1.2, p.z);
    if (narrow()) { flyTo(tgt.clone().add(new THREE.Vector3(0, 0, 3)), new THREE.Vector3(0, 14, 9)); return; }
    flyTo(tgt, outward.multiplyScalar(-7).add(new THREE.Vector3(0, 6, 0)).add(new THREE.Vector3(outward.z * 2, 0, -outward.x * 2)));
  }
  function overview() {
    if (narrow()) flyTo(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 62, 22), 1300);
    else flyTo(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 26, 58), 1300);
  }

  // ---- picking
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let down = null;
  const hitTargets = () => [minju.userData.hit, grok.userData.hit, library.userData.hit, ...desks.filter((d) => d.sessionId).map((d) => d.hit)];
  function pick(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(hitTargets(), false)[0];
    if (!hit) return null;
    if (hit.object.userData.minju) return 'minju';
    if (hit.object.userData.grok) return 'grok';
    if (hit.object.userData.library) return 'library';
    return hit.object.userData.desk?.sessionId || null;
  }
  renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const id = pick(e);
    if (id) onSelect?.(id);
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (e.buttons) return;
    renderer.domElement.style.cursor = pick(e) ? 'pointer' : 'grab';
  });

  // Device pixels are capped per tier, and by a pixel budget on top: the HDR targets cost several
  // times what the bare canvas did, so a 5K window must not quietly allocate a gigabyte.
  function pixelRatio(w, h) {
    const cap = quality === 'ultra' ? 2 : 1.25, budget = quality === 'ultra' ? 6.5e6 : 3.3e6;
    return Math.min(devicePixelRatio, Math.max(1, Math.min(cap, Math.sqrt(budget / Math.max(1, w * h)))));
  }
  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setPixelRatio(pixelRatio(w, h)); // the pipeline's targets follow the drawing buffer on the next frame
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w < 700 ? 55 : 42;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  // devicePixelRatio can change with no resize at all (browser zoom, a move to another monitor)
  (function watchDpr() {
    matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { resize(); watchDpr(); }, { once: true });
  })();

  drawMinjuLabel();
  drawGrokLabel();
  drawLibraryLabel();
  setQuality(quality);
  setTime(hour);
  document.fonts?.ready.then(() => setUiTheme(L === LABEL.dark ? 'dark' : 'light'));

  const clock = new THREE.Clock();
  overview();
  camAnim.ms = REDUCED_MOTION ? 1 : 2400;
  function frame() {
    const dt = Math.min(clock.getDelta(), 0.2) * TIME_SCALE; // tolerate slow frames without teleporting after a tab switch
    const t = clock.elapsedTime;
    renderer.info.reset();
    if (camAnim) {
      const k = Math.min(1, (performance.now() - camAnim.t0) / camAnim.ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      controls.target.lerpVectors(camAnim.fromT, camAnim.toT, e);
      camera.position.lerpVectors(camAnim.fromC, camAnim.toC, e);
      if (k >= 1) camAnim = null;
    }
    if (userCam) {
      // keep the pivot on the island: no panning off into space or under the floor
      const tg = controls.target, r = Math.hypot(tg.x, tg.z);
      if (r > 38) { tg.x *= 38 / r; tg.z *= 38 / r; }
      tg.y = THREE.MathUtils.clamp(tg.y, 0, 10);
    }
    controls.update();
    updateLampLights();
    orbitEnv.update(performance.now(), scene);

    const { holo, core, r1, r2 } = minju.userData.holo;
    const mu = minju.userData.avatar;
    if (!REDUCED_MOTION) {
      core.rotation.y += dt * 0.6; core.rotation.x += dt * 0.25;
      r1.rotation.x = Math.PI / 2 + Math.sin(t * 0.7) * 0.4; r1.rotation.y += dt * 0.8;
      r2.rotation.x = Math.PI / 2 + Math.cos(t * 0.5) * 0.5; r2.rotation.z += dt * 0.5;
      holo.position.y = 4.2 + Math.sin(t * 1.3) * 0.12;
    }
    setPose(mu, 'sit-working', t, REDUCED_MOTION ? 0 : 1, dt);
    mu.rotation.y = Math.PI;

    for (const d of desks) d.tick(t, dt, env, camera.position);
    const motion = REDUCED_MOTION ? 0 : 1;
    for (const [id, ag] of agents) {
      if (ag.leaving && ag.leaveForGood()) { ag.dispose(); agents.delete(id); continue; }
      ag.update(t, dt, motion);
    }
    if (motion) animateWorld(t, dt);
    space.update(t, dt, motion, camera);

    for (let i = packets.length - 1; i >= 0; i--) {
      const p = packets[i];
      p.t += dt * p.speed;
      if (p.t >= 1) { scene.remove(p.mesh); p.mesh.material.dispose(); p.glow.material.dispose(); packets.splice(i, 1); continue; }
      p.mesh.position.copy(p.curve.getPoint(p.t));
    }
    if (pipeline) {
      pipeline.render(scene, camera, (prepare) => space.render(camera, prepare));
    } else {
      renderer.clear();
      space.render(camera);
      renderer.clearDepth();
      renderer.render(scene, camera);
    }
  }
  // wind gusts, swaying trees, leaves, fountain, Grok bots, the gate portal
  function animateWorld(t, dt) {
    wind.time.value = t;
    wind.strength.value = 0.45 + 0.25 * Math.sin(t * 0.13) + 0.35 * Math.max(0, Math.sin(t * 0.41) * Math.sin(t * 0.07 + 1)) ** 3;
    const ws = wind.strength.value;

    if (detail.visible) {
      for (const l of leaves) {
        if (l.landed) {
          l.rest -= dt;
          if (l.rest <= 0) respawnLeaf(l);
        } else {
          l.v.y += (-1.4 - l.v.y) * Math.min(1, dt * 1.6);                  // light: terminal velocity ~1.4 m/s
          l.v.x += (wind.dir.x * ws * 1.6 - l.v.x) * Math.min(1, dt * 1.2); // drag towards the wind
          l.v.z += (wind.dir.z * ws * 1.6 - l.v.z) * Math.min(1, dt * 1.2);
          l.p.addScaledVector(l.v, dt);
          l.p.x += Math.sin(t * 3 + l.i) * 0.35 * dt;                        // flutter
          l.rot.x += l.spin.x * dt; l.rot.y += l.spin.y * dt; l.rot.z += l.spin.z * dt;
          if (l.p.y <= 0.02 || Math.hypot(l.p.x, l.p.z) > 36) { l.p.y = 0.02; l.rot.set(-Math.PI / 2, l.rot.y, 0); l.landed = true; l.rest = 3 + Math.random() * 6; }
        }
        _qq.setFromEuler(l.rot);
        const k = l.landed ? THREE.MathUtils.clamp(l.rest, 0.001, 1) : 1;  // fade out by shrinking
        _m4.compose(l.p, _qq, _sc.set(k, k, k));
        leafMesh.setMatrixAt(l.i, _m4);
      }
      leafMesh.instanceMatrix.needsUpdate = true;
    }

    const P = spray.pos, V = spray.vel;
    for (let i = 0; i < spray.n; i++) {
      const j = i * 3;
      if (P[j + 1] < 0.36) { if (Math.random() < 0.25) respawnDrop(i); else P[j + 1] = -10; continue; }
      V[j + 1] -= 9.8 * dt;
      V[j] += wind.dir.x * ws * 0.6 * dt; V[j + 2] += wind.dir.z * ws * 0.6 * dt;
      P[j] += V[j] * dt; P[j + 1] += V[j + 1] * dt; P[j + 2] += V[j + 2] * dt;
    }
    spray.points.geometry.attributes.position.needsUpdate = true;

    gate.userData.portal.rotation.z += dt * 0.8;
    for (const e of grokBots.values()) {
      const p = e.home, st = e.status;
      const bob = st === 'waiting' ? Math.abs(Math.sin(t * 6 + e.phase)) * 0.35 : Math.sin(t * 1.5 + e.phase) * 0.08;
      e.group.position.set(p.x, p.y + bob, p.z);
      e.mesh.rotation.y += dt * (st === 'working' ? 2.4 : st === 'done' ? 0.2 : 0.6);
      e.mesh.rotation.x = st === 'working' ? Math.sin(t * 2 + e.phase) * 0.3 : 0;
      e.ring.scale.setScalar(st === 'working' ? 1 + 0.1 * Math.sin(t * 6 + e.phase) : 1);
    }
  }

  renderer.setAnimationLoop(frame);
  document.addEventListener('visibilitychange', () => {
    renderer.setAnimationLoop(document.hidden ? null : frame);
    if (!document.hidden) clock.getDelta();
  });

  // Whole-frame totals: frame() resets the counters once per frame, so calls and triangles now
  // include space, the shadow map, the post passes and the UI layer. `stages.office` is the office
  // pass alone, which is what this used to report.
  if (new URLSearchParams(location.search).has('stats')) window.__officeStats = () => ({ ...renderer.info.render, programs: renderer.info.programs?.length, stages: pipeline?.counts, pipeline: pipeline ? pipeline.describe() : 'direct' });
  if (new URLSearchParams(location.search).has('stats')) window.__officeTime = (h) => setTime(h);
  if (new URLSearchParams(location.search).has('stats')) window.__officeQuality = (q) => setQuality(q);
  if (new URLSearchParams(location.search).has('stats')) window.__officeLook = (o) => Object.assign(pipeline?.look ?? {}, o);
  if (new URLSearchParams(location.search).has('stats')) window.__officeLights = { hemi, sun, rim, earthshine, lampLights, lampPools, renderer, scene, SHADOW };
  if (new URLSearchParams(location.search).has('stats')) window.__officeFocus = (id) => focus(id);
  if (new URLSearchParams(location.search).has('stats')) window.__officeView = (x, y, z, tx = 0, ty = 0, tz = 0) => { camAnim = null; userCam = false; controls.target.set(tx, ty, tz); camera.position.set(x, y, z); };
  if (new URLSearchParams(location.search).has('stats')) window.__officeAgents = () => [...agents.values()].map((a) => ({ id: a.id.slice(0, 6), status: a.status, goal: a.goal, mode: a.mode, run: a.run, left: a.path.length, pos: a.avatar.position.toArray().map((n) => +n.toFixed(1)), visible: a.avatar.visible }));

  return {
    update, pulse, focus, overview, setTime, setQuality, setUiTheme, setExternal,
    get hour() { return env.hour; }, get quality() { return quality; }, get capacity() { return desks.length; },
  };
}
