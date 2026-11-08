// The 3D office: a Minju City island floating in orbit above the Earth (see space.js). Minju's round dispatch desk sits in the middle,
// agent desks stand on rings around it, and a garden ring with lamps and trees circles the edge.
//
// Lighting follows a time of day (the same six keyframes as Minju City). Static furniture is
// built once per kind and drawn with InstancedMesh, so ~40 detailed desks cost a few draw calls.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
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
const K_NIGHT = { sun: 0x9DB4FF, sunInt: 0.5, sunPos: [-40, 80, -60], hemiSky: 0x5466A8, hemiGround: 0x1C1830, hemiInt: 0.5, foliage: 0x3E6E58, window: 1.7, lamp: 2.2, stars: 1, exposure: 1.15 };
const K_PREDAWN = { sun: 0x8FA6FF, sunInt: 0.45, sunPos: [100, 14, 35], hemiSky: 0x5A6BB0, hemiGround: 0x241E3C, hemiInt: 0.5, foliage: 0x4A7A60, window: 1.4, lamp: 1.8, stars: 0.55, exposure: 1.12 };
const K_DAWN = { sun: 0xFFB98A, sunInt: 1.4, sunPos: [95, 24, 35], hemiSky: 0xFFD1B8, hemiGround: 0x8F7AA8, hemiInt: 0.8, foliage: 0x9CC48A, window: 0.7, lamp: 0.5, stars: 0.1, exposure: 1.05 };
const K_DAY = { sun: 0xFFF4E0, sunInt: 2.6, sunPos: [75, 70, 40], hemiSky: 0xDDEEFF, hemiGround: 0xFFE2EC, hemiInt: 1.05, foliage: 0x86D28F, window: 0, lamp: 0, stars: 0, exposure: 1.0 };
const K_DAY2 = { ...K_DAY, sunPos: [-35, 78, 40] };
const K_SUNSET = { sun: 0xFF9A6B, sunInt: 1.8, sunPos: [-95, 22, 35], hemiSky: 0xFFC2A8, hemiGround: 0x8A6A9E, hemiInt: 0.75, foliage: 0x9DBE78, window: 0.7, lamp: 0.55, stars: 0.12, exposure: 1.05 };
const K_DUSK = { sun: 0xFF7F6B, sunInt: 0.8, sunPos: [-100, 14, 35], hemiSky: 0x8A7AC0, hemiGround: 0x3A2E56, hemiInt: 0.6, foliage: 0x5E8466, window: 1.3, lamp: 1.5, stars: 0.6, exposure: 1.1 };
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
const TEX = {
  wood: TX.woodTexture(), terrazzo: TX.terrazzoTexture(), grass: TX.grassTexture(), fabric: TX.fabricTexture(),
  rock: TX.rockTexture(), rug: TX.rugTexture(), keys: TX.keyboardTexture(),
};
const M = {
  wood: new THREE.MeshStandardMaterial({ map: TEX.wood, roughness: 0.55, metalness: 0 }),
  frame: new THREE.MeshStandardMaterial({ color: '#F6F6F8', roughness: 0.35, metalness: 0.35 }),
  dark: new THREE.MeshStandardMaterial({ color: '#2B2F3A', roughness: 0.35, metalness: 0.4 }),
  plastic: new THREE.MeshStandardMaterial({ color: '#FAFAFC', roughness: 0.35 }),
  keys: new THREE.MeshStandardMaterial({ map: TEX.keys, roughness: 0.5 }),
  fabric: new THREE.MeshStandardMaterial({ map: TEX.fabric, color: '#FFC4D8', roughness: 0.9 }),
  chairFrame: new THREE.MeshStandardMaterial({ color: '#3A3F4D', roughness: 0.4, metalness: 0.6 }),
  ceramic: new THREE.MeshStandardMaterial({ color: '#FFFFFF', roughness: 0.25 }),
  paper: new THREE.MeshStandardMaterial({ color: '#FFFFFF', roughness: 0.8 }),
  leaf: new THREE.MeshStandardMaterial({ color: '#86D28F', roughness: 0.85, flatShading: true }),
  succulent: new THREE.MeshStandardMaterial({ color: '#7FC49A', roughness: 0.6 }),
  trunk: new THREE.MeshStandardMaterial({ color: '#B8865E', roughness: 0.95 }),
  lampGlow: new THREE.MeshStandardMaterial({ color: '#FFF6E6', emissive: '#FFD79A', emissiveIntensity: 0, roughness: 0.3 }),
  skin: new THREE.MeshStandardMaterial({ color: '#F3D3BF', roughness: 0.65 }),
  eye: new THREE.MeshStandardMaterial({ color: '#2B2340', roughness: 0.2 }),
  white: new THREE.MeshBasicMaterial({ color: '#FFFFFF' }),
  blush: new THREE.MeshBasicMaterial({ color: '#FF9DB8', transparent: true, opacity: 0.55, depthWrite: false }),
  shoe: new THREE.MeshStandardMaterial({ color: '#F4F4F6', roughness: 0.5 }),
  server: new THREE.MeshStandardMaterial({ color: '#E7EAF2', roughness: 0.35, metalness: 0.3 }),
  metalDark: new THREE.MeshStandardMaterial({ color: '#4A4F5E', roughness: 0.45, metalness: 0.6 }),
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

function lumpy(radius, detail, seed, amount = 0.18) {
  const g = new THREE.IcosahedronGeometry(radius, detail);
  const r = TX.rng(seed);
  const pos = g.attributes.position;
  const map = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    if (!map.has(key)) map.set(key, 1 + (r() - 0.5) * 2 * amount);
    const f = map.get(key);
    pos.setXYZ(i, pos.getX(i) * f, pos.getY(i) * f * 0.9, pos.getZ(i) * f);
  }
  g.computeVertexNormals();
  return g;
}

// ----------------------------------------------------- desk templates
// Desk-local space: +Z faces Minju; the agent sits at -Z.
function deskTemplates() {
  const legBox = new THREE.BoxGeometry(0.05, 0.72, 0.05);
  const frame = [];
  for (const x of [-0.9, 0.9]) {
    frame.push(part(legBox, x, 0.36, -0.42), part(legBox, x, 0.36, 0.42));
    frame.push(part(RB(0.06, 0.03, 0.96, 0.01), x, 0.015, 0));
    frame.push(part(new THREE.BoxGeometry(0.04, 0.04, 0.88), x, 0.7, 0));
  }
  frame.push(part(new THREE.BoxGeometry(1.76, 0.04, 0.04), 0, 0.69, 0.36));
  frame.push(part(RB(1.7, 0.3, 0.018, 0.008), 0, 0.53, 0.46)); // modesty panel facing Minju
  frame.push(part(new THREE.BoxGeometry(0.9, 0.06, 0.1), 0, 0.66, 0.3)); // cable tray

  const wood = [part(RB(2.0, 0.05, 1.0, 0.02, 4), 0, 0.755, 0)];

  const dark = [
    part(RB(0.96, 0.58, 0.035, 0.015), 0, 1.22, 0.24),
    part(RB(0.5, 0.3, 0.06, 0.02), 0, 1.2, 0.28),
    part(RB(0.06, 0.32, 0.03, 0.01), 0, 0.95, 0.3, -0.08),
    part(RB(0.3, 0.015, 0.2, 0.007), 0, 0.789, 0.27),
  ];
  const plastic = [
    part(RB(0.46, 0.018, 0.15, 0.007), 0, 0.789, -0.17),
    part(new THREE.SphereGeometry(1, 16, 10), 0.36, 0.795, -0.17, 0, 0, 0, 0.032, 0.018, 0.052),
  ];
  const keys = [part(new THREE.PlaneGeometry(0.43, 0.13), 0, 0.7995, -0.17, -Math.PI / 2)];

  // office chair at z = -0.85, back towards -Z
  const cz = -0.85;
  const fabric = [
    part(RB(0.52, 0.08, 0.5, 0.035, 4), 0, 0.47, cz),
    part(RB(0.5, 0.55, 0.07, 0.03, 4), 0, 0.84, cz - 0.26, -0.12),
  ];
  const chairFrame = [
    part(new THREE.BoxGeometry(0.4, 0.03, 0.4), 0, 0.42, cz),
    part(new THREE.CylinderGeometry(0.025, 0.025, 0.32, 12), 0, 0.26, cz),
    part(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 12), 0, 0.09, cz),
    part(new THREE.BoxGeometry(0.03, 0.42, 0.03), 0, 0.62, cz - 0.24, -0.12),
  ];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    chairFrame.push(part(new THREE.BoxGeometry(0.3, 0.025, 0.04), Math.cos(a) * 0.15, 0.07, cz + Math.sin(a) * 0.15, 0, -a));
    chairFrame.push(part(new THREE.SphereGeometry(0.028, 10, 8), Math.cos(a) * 0.29, 0.03, cz + Math.sin(a) * 0.29));
  }
  for (const x of [-0.29, 0.29]) {
    chairFrame.push(part(new THREE.BoxGeometry(0.03, 0.2, 0.03), x, 0.55, cz - 0.05));
    chairFrame.push(part(RB(0.06, 0.03, 0.26, 0.012), x, 0.66, cz - 0.02));
  }

  return {
    frame: merge(frame), wood: merge(wood), dark: merge(dark), plastic: merge(plastic), keys: merge(keys),
    fabric: merge(fabric), chairFrame: merge(chairFrame),
  };
}

function propTemplates() {
  const mug = merge([
    part(new THREE.CylinderGeometry(0.038, 0.034, 0.09, 20), 0, 0.045, 0),
    part(new THREE.TorusGeometry(0.024, 0.007, 8, 16), 0.042, 0.05, 0),
  ]);
  const pot = merge([part(new THREE.CylinderGeometry(0.06, 0.045, 0.1, 18), 0, 0.05, 0)]);
  const leafParts = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2, tilt = i % 2 ? 0.6 : 0.35;
    leafParts.push(part(new THREE.SphereGeometry(1, 10, 8), Math.cos(a) * 0.025, 0.13, Math.sin(a) * 0.025, Math.sin(a) * tilt, 0, -Math.cos(a) * tilt, 0.022, 0.06, 0.012));
  }
  const leaves = merge(leafParts);
  const lampBody = merge([
    part(new THREE.CylinderGeometry(0.07, 0.075, 0.02, 20), 0, 0.01, 0),
    part(new THREE.CylinderGeometry(0.01, 0.01, 0.42, 8), 0, 0.22, 0),
    part(new THREE.CylinderGeometry(0.01, 0.01, 0.26, 8), 0.12, 0.42, 0, 0, 0, Math.PI / 2),
    part(new THREE.ConeGeometry(0.075, 0.1, 20, 1, true), 0.25, 0.38, 0, Math.PI),
  ]);
  const lampBulb = merge([part(new THREE.SphereGeometry(0.03, 12, 8), 0.25, 0.35, 0)]);
  const notebook = merge([part(RB(0.2, 0.014, 0.27, 0.005), 0, 0.007, 0)]);
  return { mug, pot, leaves, lampBody, lampBulb, notebook };
}

// --------------------------------------------------------------- avatar
// Seated pelvis height and standing pelvis height for the rig below.
const SIT_H = 0.54, STAND_H = 0.865;

function makeAvatar(shirt, { scale = 1, seed = 'x', minju = false } = {}) {
  const r = TX.rng(hashHue(seed) + 3);
  const g = new THREE.Group();
  const shirtMat = new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.7, map: TEX.fabric });
  const pantsMat = new THREE.MeshStandardMaterial({ color: minju ? '#FFFFFF' : PANTS[Math.floor(r() * PANTS.length)], roughness: 0.8 });
  const hairMat = new THREE.MeshStandardMaterial({ color: minju ? '#2b1d1a' : HAIR[Math.floor(r() * HAIR.length)], roughness: 0.55 });
  const body = new THREE.Group();
  body.position.y = SIT_H;
  g.add(body);
  const add = (geo, mat, x, y, z, parent = body) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m; };

  add(new THREE.CapsuleGeometry(0.15, 0.14, 6, 14), pantsMat, 0, 0.02, -0.02).rotation.z = Math.PI / 2;
  const torso = add(new THREE.CapsuleGeometry(0.16, 0.26, 8, 18), shirtMat, 0, 0.3, 0);
  torso.scale.set(1, 1, 0.8);
  add(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 12), M.skin, 0, 0.6, 0);

  const legs = {};
  for (const [side, x] of [['L', -0.09], ['R', 0.09]]) {
    const hip = new THREE.Group();
    hip.position.set(x, -0.02, 0);
    body.add(hip);
    add(new THREE.CapsuleGeometry(0.068, 0.24, 6, 12), pantsMat, 0, -0.18, 0, hip);
    const knee = new THREE.Group();
    knee.position.set(0, -0.36, 0);
    hip.add(knee);
    add(new THREE.CapsuleGeometry(0.058, 0.3, 6, 12), pantsMat, 0, -0.21, 0, knee);
    add(RB(0.09, 0.07, 0.17, 0.03), M.shoe, 0, -0.45, 0.04, knee);
    hip.rotation.x = -Math.PI / 2; knee.rotation.x = Math.PI / 2;
    legs[side] = { hip, knee };
  }

  const head = new THREE.Group();
  head.position.set(0, 0.77, 0);
  body.add(head);
  const skull = add(new THREE.SphereGeometry(0.17, 28, 20), M.skin, 0, 0, 0, head);
  skull.scale.set(1, 1.04, 0.98);
  for (const x of [-0.06, 0.06]) {
    const eye = add(new THREE.SphereGeometry(0.023, 14, 10), M.eye, x, 0.005, 0.152, head);
    eye.scale.set(1, 1.25, 0.6);
    add(new THREE.SphereGeometry(0.007, 8, 6), M.white, x + 0.008, 0.018, 0.165, head).castShadow = false;
    const blush = add(new THREE.CircleGeometry(0.026, 16), M.blush, x * 1.55, -0.045, 0.145, head);
    blush.rotation.y = x * 4; blush.castShadow = false;
  }
  const cap = add(new THREE.SphereGeometry(0.182, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.56), hairMat, 0, 0.01, -0.005, head);
  cap.rotation.x = -0.32;
  const bangs = add(new THREE.SphereGeometry(0.18, 24, 10, Math.PI * 0.08, Math.PI * 0.84, Math.PI * 0.14, Math.PI * 0.2), hairMat, 0, 0.012, 0.012, head);
  bangs.scale.set(1.02, 1, 1.04);
  if (minju || r() < 0.45) {
    const back = add(new THREE.CapsuleGeometry(0.15, minju ? 0.34 : 0.14, 6, 14), hairMat, 0, minju ? -0.2 : -0.08, -0.07, head);
    back.scale.set(1.12, 1, 0.7);
  }
  if (minju) {
    const hs = new THREE.MeshStandardMaterial({ color: '#FFFFFF', roughness: 0.3, metalness: 0.2 });
    add(new THREE.TorusGeometry(0.2, 0.018, 8, 32, Math.PI), hs, 0, 0.03, 0, head);
    for (const x of [-0.19, 0.19]) add(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 18), new THREE.MeshStandardMaterial({ color: '#FF8FB8', roughness: 0.35 }), x, -0.01, 0, head).rotation.z = Math.PI / 2;
    const bow = add(new THREE.SphereGeometry(0.045, 12, 8), new THREE.MeshStandardMaterial({ color: '#FF5C9A', roughness: 0.4 }), 0.1, 0.15, -0.06, head);
    bow.scale.set(1.4, 0.8, 0.6);
  }

  const arms = {};
  for (const [side, x] of [['L', -0.215], ['R', 0.215]]) {
    const upper = new THREE.Group();
    upper.position.set(x, 0.49, 0);
    body.add(upper);
    add(new THREE.CapsuleGeometry(0.052, 0.18, 6, 10), shirtMat, 0, -0.13, 0, upper);
    const fore = new THREE.Group();
    fore.position.set(0, -0.26, 0);
    upper.add(fore);
    add(new THREE.CapsuleGeometry(0.045, 0.18, 6, 10), M.skin, 0, -0.12, 0, fore);
    add(new THREE.SphereGeometry(0.048, 12, 10), M.skin, 0, -0.25, 0, fore);
    upper.rotation.x = -0.35; fore.rotation.x = -1.2;
    arms[side] = { upper, fore };
  }

  const book = new THREE.Group();
  const cover = new THREE.Mesh(RB(0.2, 0.03, 0.26, 0.008), new THREE.MeshStandardMaterial({ color: PASTEL[Math.floor(r() * PASTEL.length)], roughness: 0.5 }));
  const pages = new THREE.Mesh(new THREE.BoxGeometry(0.185, 0.02, 0.24), M.paper);
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
  server: RB(0.36, 0.82, 0.44, 0.03),
  led: new THREE.BoxGeometry(0.05, 0.03, 0.01),
  miniDesk: RB(0.7, 0.04, 0.45, 0.015),
  laptop: RB(0.3, 0.012, 0.2, 0.005),
  laptopLid: RB(0.3, 0.2, 0.01, 0.005),
  stool: new THREE.CylinderGeometry(0.14, 0.12, 0.3, 16),
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
const BOT_SHAPES = {
  circle: () => new THREE.SphereGeometry(0.32, 28, 18),
  square: () => RB(0.52, 0.52, 0.52, 0.08),
  triangle: () => new THREE.ConeGeometry(0.36, 0.6, 3),
  diamond: () => new THREE.OctahedronGeometry(0.38),
  star: () => new THREE.DodecahedronGeometry(0.36),
  hexagon: () => new THREE.CylinderGeometry(0.34, 0.34, 0.3, 6),
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
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1500);
  camera.position.set(0, 52, 66);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = 1.32;
  controls.minDistance = 4;
  controls.maxDistance = 85;

  // ---- space: stars, the Earth, the Sun, stations, satellites and meteors
  const space = createSpace({ renderer, scene, quality });

  // ---- lights
  const hemi = new THREE.HemisphereLight('#ffffff', '#ffffff', 1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#ffffff', 1);
  sun.castShadow = true;
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 140 });
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  const minjuLight = new THREE.PointLight('#FF8FB8', 4, 16, 1.6);
  minjuLight.position.set(0, 4.5, 0);
  scene.add(minjuLight);

  // ---- floating island
  const floorMat = new THREE.MeshStandardMaterial({ map: TEX.terrazzo, roughness: 0.6, metalness: 0 });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(36, 128), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grass = new THREE.Mesh(new THREE.RingGeometry(27.2, 36, 128, 4), new THREE.MeshStandardMaterial({ map: TEX.grass, roughness: 0.95 }));
  grass.rotation.x = -Math.PI / 2;
  grass.position.y = 0.008;
  grass.receiveShadow = true;
  scene.add(grass);
  const kerb = new THREE.Mesh(new THREE.TorusGeometry(27.2, 0.12, 8, 160), new THREE.MeshStandardMaterial({ color: '#F1E6DA', roughness: 0.6 }));
  kerb.rotation.x = -Math.PI / 2;
  kerb.position.y = 0.04;
  kerb.receiveShadow = true;
  scene.add(kerb);
  const rockMat = new THREE.MeshStandardMaterial({ map: TEX.rock, roughness: 0.95, flatShading: true });
  const side = new THREE.Mesh(new THREE.CylinderGeometry(36, 34.6, 2.4, 128, 2, true), rockMat);
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
  const rug = new THREE.Mesh(new THREE.CircleGeometry(5.8, 96), new THREE.MeshStandardMaterial({ map: TEX.rug, roughness: 1 }));
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
  {
    const r = TX.rng(101);
    const crown = merge([
      part(lumpy(1, 2, 1), 0, 2.1, 0, 0, 0, 0, 1.05, 1.05, 1.05),
      part(lumpy(1, 2, 2), 0.55, 1.75, 0.2, 0, 0, 0, 0.7, 0.7, 0.7),
      part(lumpy(1, 2, 3), -0.5, 1.8, -0.25, 0, 0, 0, 0.72, 0.72, 0.72),
      part(lumpy(1, 2, 4), 0.1, 2.75, 0.05, 0, 0, 0, 0.6, 0.6, 0.6),
    ]);
    const trunk = merge([
      part(new THREE.CylinderGeometry(0.13, 0.22, 1.9, 10), 0, 0.95, 0),
      part(new THREE.CylinderGeometry(0.05, 0.08, 0.8, 8), 0.25, 1.5, 0, 0, 0, -0.7),
    ]);
    const treeM = [], treeC = [], bushM = [], bushC = [], flowerM = [], flowerC = [];
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2 + (r() - 0.5) * 0.08, rad = 30 + r() * 4.5;
      const x = Math.sin(a) * rad, z = Math.cos(a) * rad, rot = r() * 6, sc = 0.85 + r() * 0.6, shade = 0.88 + r() * 0.24;
      if (!clearOf(x, z, 0.8)) continue;
      treeM.push(local(x, 0, z, rot, sc));
      treeC.push(new THREE.Color().setHSL(0, 0, shade));
    }
    for (let i = 0; i < 90; i++) {
      const a = r() * Math.PI * 2, rad = 28 + r() * 7.2;
      const x = Math.sin(a) * rad, z = Math.cos(a) * rad, rot = r() * 6, sc = 0.35 + r() * 0.3, shade = 0.92 + r() * 0.2;
      if (!clearOf(x, z)) continue;
      bushM.push(local(x, -0.9, z, rot, sc));
      bushC.push(new THREE.Color().setHSL(0, 0, shade));
    }
    for (let i = 0; i < 700; i++) {
      const a = r() * Math.PI * 2, rad = 27.8 + r() * 7.8;
      const x = Math.sin(a) * rad, z = Math.cos(a) * rad, sc = 0.7 + r() * 0.6, col = PASTEL[Math.floor(r() * PASTEL.length)];
      if (!clearOf(x, z, -1.2)) continue;
      flowerM.push(local(x, 0.07, z, 0, sc));
      flowerC.push(new THREE.Color(col));
    }
    garden.userData.treeTops = treeM.map((m) => new THREE.Vector3().setFromMatrixPosition(m));
    garden.add(instanced(trunk, M.trunk, treeM));
    garden.add(instanced(crown, M.leaf, treeM, { colors: treeC }));
    detail.add(instanced(crown, M.leaf, bushM, { colors: bushC }));
    detail.add(instanced(new THREE.IcosahedronGeometry(0.08, 1), new THREE.MeshStandardMaterial({ roughness: 0.6 }), flowerM, { shadow: false, colors: flowerC }));
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
    const post = merge([
      part(new THREE.CylinderGeometry(0.06, 0.09, 3.2, 12), 0, 1.6, 0),
      part(new THREE.CylinderGeometry(0.16, 0.2, 0.15, 16), 0, 0.075, 0),
      part(new THREE.CylinderGeometry(0.17, 0.12, 0.08, 16), 0, 3.25, 0),
      part(new THREE.ConeGeometry(0.26, 0.2, 16), 0, 3.82, 0),
    ]);
    const bulb = merge([part(new THREE.CylinderGeometry(0.14, 0.12, 0.5, 16), 0, 3.52, 0)]);
    garden.add(instanced(post, M.metalDark, postM));
    garden.add(instanced(bulb, M.lampGlow, postM, { shadow: false }));
    const slat = new THREE.BoxGeometry(1.6, 0.04, 0.12);
    const benchWood = merge([
      part(slat, 0, 0.45, -0.14), part(slat, 0, 0.45, 0), part(slat, 0, 0.45, 0.14),
      part(slat, 0, 0.66, -0.24, 0.25), part(slat, 0, 0.82, -0.28, 0.25),
    ]);
    const benchMetal = merge([
      part(new THREE.BoxGeometry(0.06, 0.45, 0.45), -0.7, 0.22, 0), part(new THREE.BoxGeometry(0.06, 0.45, 0.45), 0.7, 0.22, 0),
      part(new THREE.BoxGeometry(0.05, 0.5, 0.05), -0.7, 0.65, -0.26, 0.25), part(new THREE.BoxGeometry(0.05, 0.5, 0.05), 0.7, 0.65, -0.26, 0.25),
    ]);
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
    const arch = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.13, 16, 64, Math.PI), archMat);
    arch.position.y = 1.5;
    arch.castShadow = true;
    for (const x of [-1.5, 1.5]) {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 1.5, 16), archMat);
      pillar.position.set(x, 0.75, 0);
      pillar.castShadow = true;
      gate.add(pillar);
    }
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
    const basin = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.8, 0.45, 48, 1, true), stone);
    basin.position.y = 0.22;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(1.72, 0.1, 10, 64), stone);
    rim.rotation.x = Math.PI / 2; rim.position.y = 0.45;
    const water = new THREE.Mesh(new THREE.CircleGeometry(1.7, 48), new THREE.MeshPhysicalMaterial({ color: '#7CC4F5', roughness: 0.08, transparent: true, opacity: 0.85, clearcoat: 1 }));
    water.rotation.x = -Math.PI / 2; water.position.y = 0.36;
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 1.0, 16), stone);
    column.position.y = 0.5;
    const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), stone);
    bowl.position.y = 1.15;
    for (const m of [basin, rim, column, bowl]) { m.castShadow = true; fountain.add(m); }
    fountain.add(water);
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
    const base = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.15, 0.25, 64), white);
    base.position.y = 0.125;
    const band = new THREE.Mesh(new THREE.TorusGeometry(3.02, 0.04, 8, 96), black);
    band.rotation.x = Math.PI / 2; band.position.y = 0.26;
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 0.9, 32), black);
    plinth.position.y = 0.7;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.42, 32), new THREE.MeshBasicMaterial({ color: '#FFFFFF', toneMapped: false }));
    disc.rotation.x = -Math.PI / 2; disc.position.y = 1.16;
    for (const m of [base, band, plinth]) { m.castShadow = m.receiveShadow = true; grok.add(m); }
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
      part(RB(0.72, 1.7, 0.04, 0.01), 0, 0.85, -0.14),               // back
      part(RB(0.04, 1.7, 0.32, 0.01), -0.34, 0.85, 0), part(RB(0.04, 1.7, 0.32, 0.01), 0.34, 0.85, 0),
      ...[0.04, 0.46, 0.88, 1.3, 1.68].map((y) => part(RB(0.72, 0.035, 0.32, 0.008), 0, y, 0)),
    ]);
    const caseM = [], bookM = [], bookC = [];
    const r = TX.rng(55);
    for (let k = -2; k <= 2; k++) {
      const a = LIB_ANGLE + k * 0.165;
      const p = polar(LIB_R, a);
      const seg = local(p.x, 0, p.z, Math.atan2(Math.cos(a), Math.sin(a))); // front faces away from Minju
      caseM.push(seg);
      for (const y of [0.06, 0.48, 0.9, 1.32]) {
        let x = -0.3;
        while (x < 0.28) {
          const w = 0.035 + r() * 0.035, h = 0.24 + r() * 0.13;
          if (r() < 0.08) { x += w; continue; }
          bookM.push(seg.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(x + w / 2, y + h / 2, 0.01), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, r() < 0.12 ? 0.18 : 0)), new THREE.Vector3(w, h, 0.22))));
          bookC.push(new THREE.Color(PASTEL[Math.floor(r() * PASTEL.length)]).offsetHSL(0, 0, (r() - 0.5) * 0.15));
          x += w + 0.004;
        }
      }
    }
    library.add(instanced(caseGeo, caseMat, caseM));
    library.add(instanced(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.6 }), bookM, { colors: bookC }));
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
  const minju = new THREE.Group();
  scene.add(minju);
  const mj = { ring: new THREE.MeshBasicMaterial({ color: '#FF5C9A', toneMapped: false }), holo: [] };
  {
    const shape = new THREE.Shape();
    const a0 = Math.PI * 0.62, a1 = Math.PI * 2.38;
    shape.absarc(0, 0, 3.2, a0, a1, false);
    shape.absarc(0, 0, 2.2, a1, a0, true);
    const deskGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.1, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 4, curveSegments: 96 });
    const desk = new THREE.Mesh(deskGeo, new THREE.MeshPhysicalMaterial({ color: '#FFFFFF', roughness: 0.18, clearcoat: 0.8, clearcoatRoughness: 0.15 }));
    desk.rotation.x = -Math.PI / 2;
    desk.position.y = 0.8;
    desk.castShadow = desk.receiveShadow = true;
    minju.add(desk);
    const glowRing = new THREE.Mesh(new THREE.TorusGeometry(2.7, 0.03, 8, 160, Math.PI * 1.76), mj.ring);
    glowRing.rotation.x = -Math.PI / 2;
    glowRing.rotation.z = Math.PI * 0.62;
    glowRing.position.y = 0.78;
    minju.add(glowRing);
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.6, 0.78, 96, 1, true, a0 - Math.PI / 2, a1 - a0), new THREE.MeshStandardMaterial({ color: '#FFD6E5', roughness: 0.5, side: THREE.DoubleSide }));
    pedestal.position.y = 0.39;
    minju.add(pedestal);

    // three monitors with dashboards, facing Minju (she sits on the -Z side of the ring)
    const dash = (seed) => canvasTexture(256, 148, (ctx, w, h) => {
      const r = TX.rng(seed);
      ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#FF5C9A'; ctx.fillRect(0, 0, w, 12);
      for (let i = 0; i < 8; i++) { ctx.fillStyle = PASTEL[i % PASTEL.length]; const bh = 20 + r() * 70; ctx.fillRect(14 + i * 15, h - 14 - bh, 10, bh); }
      ctx.lineWidth = 12; ctx.strokeStyle = '#F2F3F7'; ctx.beginPath(); ctx.arc(200, 70, 30, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#7CC4F5'; ctx.beginPath(); ctx.arc(200, 70, 30, -Math.PI / 2, -Math.PI / 2 + r() * 5); ctx.stroke();
      for (let i = 0; i < 3; i++) { ctx.fillStyle = '#E3E6EC'; ctx.fillRect(150, 112 + i * 9, 90, 4); }
    });
    for (const [ang, seed] of [[-0.6, 1], [0, 2], [0.6, 3]]) {
      const holder = new THREE.Group();
      holder.rotation.y = Math.PI + ang;
      const mon = new THREE.Mesh(RB(1.2, 0.72, 0.04, 0.02), M.dark);
      mon.position.set(0, 1.4, 2.62);
      mon.castShadow = true;
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(1.13, 0.65), new THREE.MeshBasicMaterial({ map: dash(seed), toneMapped: false }));
      scr.position.set(0, 1.4, 2.598);
      scr.rotation.y = Math.PI;
      const neck = new THREE.Mesh(RB(0.06, 0.4, 0.03, 0.01), M.dark);
      neck.position.set(0, 1.07, 2.66);
      holder.add(mon, scr, neck);
      minju.add(holder);
    }
    // keyboard + a bowl of ramyeon (allegedly not hers)
    const kb = new THREE.Group();
    const kbBody = new THREE.Mesh(RB(0.5, 0.02, 0.16, 0.008), M.plastic);
    const kbKeys = new THREE.Mesh(new THREE.PlaneGeometry(0.47, 0.14), M.keys);
    kbKeys.rotation.x = -Math.PI / 2; kbKeys.position.y = 0.011;
    kb.add(kbBody, kbKeys);
    kb.position.set(0, 0.95, -2.42);
    kb.rotation.y = Math.PI;
    minju.add(kb);
    const bowl = new THREE.Group();
    const bowlBody = new THREE.Mesh(new THREE.SphereGeometry(0.16, 28, 14, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#E8506A', roughness: 0.3, side: THREE.DoubleSide }));
    bowlBody.position.y = 0.16;
    const soup = new THREE.Mesh(new THREE.CircleGeometry(0.15, 28), new THREE.MeshStandardMaterial({ color: '#E87B3A', roughness: 0.25 }));
    soup.rotation.x = -Math.PI / 2; soup.position.y = 0.13;
    bowl.add(bowlBody, soup);
    const noodleMat = new THREE.MeshStandardMaterial({ color: '#FFE08A', roughness: 0.5 });
    for (let i = 0; i < 7; i++) {
      const n = new THREE.Mesh(new THREE.TorusGeometry(0.035 + i * 0.012, 0.007, 6, 24), noodleMat);
      n.rotation.x = Math.PI / 2; n.position.set((i % 3 - 1) * 0.02, 0.135, (i % 2) * 0.02); bowl.add(n);
    }
    for (const dx of [0.02, 0.05]) {
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.36, 6), new THREE.MeshStandardMaterial({ color: '#C99A72' }));
      stick.position.set(dx, 0.2, 0); stick.rotation.z = 1.1; bowl.add(stick);
    }
    bowl.position.set(1.15, 0.93, -2.42);
    bowl.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    minju.add(bowl);

    const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.28, 0.5, 24), M.fabric);
    stool.position.set(0, 0.25, -1.45);
    stool.castShadow = true;
    minju.add(stool);
    const avatar = makeAvatar(new THREE.Color('#FF8FB8'), { scale: 1.12, seed: 'minju', minju: true });
    avatar.position.set(0, -0.02, -1.45);
    avatar.rotation.y = Math.PI;
    minju.add(avatar);
    minju.userData.avatar = avatar;

    const holo = new THREE.Group();
    holo.position.y = 4.2;
    mj.holo = [
      new THREE.MeshBasicMaterial({ color: '#FF5C9A', wireframe: true, transparent: true, opacity: 0.9, toneMapped: false }),
      new THREE.MeshBasicMaterial({ color: '#7CC4F5', transparent: true, opacity: 0.8, toneMapped: false }),
      new THREE.MeshBasicMaterial({ color: '#FFB3CC', transparent: true, opacity: 0.6, toneMapped: false }),
    ];
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 1), mj.holo[0]);
    const r1 = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.02, 8, 128), mj.holo[1]);
    const r2 = new THREE.Mesh(new THREE.TorusGeometry(1.3, 0.016, 8, 128), mj.holo[2]);
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
  const env = { lamp: 0, glowGain: 0.5, additive: null, hour };
  const sunDir = new THREE.Vector3();
  function setTime(h) {
    env.hour = h;
    const k = sampleTime(h);
    const dayness = THREE.MathUtils.clamp((k.sunInt - 0.45) / 2.15, 0, 1);
    hemi.color.copy(k.c.hemiSky); hemi.groundColor.copy(k.c.hemiGround); hemi.intensity = k.hemiInt * 0.85;
    sun.color.copy(k.c.sun); sun.intensity = k.sunInt;
    sunDir.copy(k.sp).normalize();
    sun.position.copy(sunDir).multiplyScalar(60);
    sun.target.position.set(0, 0, 0);
    renderer.toneMappingExposure = k.exposure;
    scene.environmentIntensity = (0.12 + 0.4 * dayness) * (quality === 'ultra' ? 1 : 0.7);
    M.leaf.color.copy(k.c.foliage);
    space.setTime(h, k, dayness);
    const win = THREE.MathUtils.clamp(k.window / 1.4, 0, 1);
    env.lamp = k.lamp;
    M.lampGlow.emissiveIntensity = k.lamp * 1.4;
    for (const s of streetGlows) s.material.opacity = Math.min(1, k.lamp * 0.38);
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
    renderer.setPixelRatio(Math.min(devicePixelRatio, quality === 'ultra' ? 2 : 1.25));
    const size = quality === 'ultra' ? 4096 : 1536;
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

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w < 700 ? 55 : 42;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);

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
    if (camAnim) {
      const k = Math.min(1, (performance.now() - camAnim.t0) / camAnim.ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      controls.target.lerpVectors(camAnim.fromT, camAnim.toT, e);
      camera.position.lerpVectors(camAnim.fromC, camAnim.toC, e);
      if (k >= 1) camAnim = null;
    }
    controls.update();

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
    renderer.clear();
    space.render(camera);
    renderer.clearDepth();
    renderer.render(scene, camera);
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

  if (new URLSearchParams(location.search).has('stats')) window.__officeStats = () => ({ ...renderer.info.render, programs: renderer.info.programs?.length });
  if (new URLSearchParams(location.search).has('stats')) window.__officeFocus = (id) => focus(id);
  if (new URLSearchParams(location.search).has('stats')) window.__officeView = (x, y, z, tx = 0, ty = 0, tz = 0) => { camAnim = null; controls.target.set(tx, ty, tz); camera.position.set(x, y, z); };
  if (new URLSearchParams(location.search).has('stats')) window.__officeAgents = () => [...agents.values()].map((a) => ({ id: a.id.slice(0, 6), status: a.status, goal: a.goal, mode: a.mode, run: a.run, left: a.path.length, pos: a.avatar.position.toArray().map((n) => +n.toFixed(1)), visible: a.avatar.visible }));

  return {
    update, pulse, focus, overview, setTime, setQuality, setUiTheme, setExternal,
    get hour() { return env.hour; }, get quality() { return quality; }, get capacity() { return desks.length; },
  };
}
