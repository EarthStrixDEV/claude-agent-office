// Space around the office: stars and the Milky Way, the Earth below with clouds and city lights,
// the Sun behind it rising over its rim, a space station, a ring station, satellites, an asteroid
// belt and shooting meteors.
//
// The far things (sky, Earth, Sun) live in their own scene with their own camera, so they can sit
// thousands of units away without costing the desks any depth precision. They are drawn first and
// the office is drawn over them. The near things (stations, satellites, rocks, meteors) go into the
// office scene and are lit by its sun.
//
// The Earth's surface, its clouds and the sky are painted once on the GPU into textures at start-up,
// so each frame only samples them.
import * as THREE from 'three';
import * as TX from './textures.js';
import { part, merge, RB, mapUV, lathe, rod, blob } from './mesh.js';

const DEG = Math.PI / 180;
// The Earth sits ahead of the default view and below it: its rim crosses the top of the screen,
// beyond the island's far edge. The Sun is behind it.
const EARTH_DIST = 2600;
const EARTH_ANG = 44 * DEG;                       // angular radius seen from the office
const EARTH_R = EARTH_DIST * Math.sin(EARTH_ANG);
const EARTH_DIR = new THREE.Vector3(0, -Math.sin(52 * DEG), -Math.cos(52 * DEG));
const SUN_DIST = 7000;
const SKY_R = 9000;

const NOISE = /* glsl */ `
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
float fbm(vec3 p, int oct) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 8; i++) { if (i >= oct) break; s += a * noise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s;
}`;

// One shader, three passes: 0 = Earth surface (sRGB albedo + city lights in alpha),
// 1 = clouds (r) and ocean mask (g), 2 = sky (sRGB). Pixel (u, v) maps to the same direction
// as SphereGeometry's uv, so the textures wrap the spheres exactly.
const BAKE = /* glsl */ `
uniform float uPass;
varying vec2 vUv;
const float PI = 3.141592653589793;
const float LAND = 0.584;
${NOISE}
void main() {
  float th = PI * (1.0 - vUv.y), ph = 2.0 * PI * vUv.x;
  vec3 p = vec3(-cos(ph) * sin(th), cos(th), sin(ph) * sin(th));

  if (uPass > 1.5) {
    vec3 bandN = normalize(vec3(0.42, 0.8, -0.42));
    float b = dot(p, bandN);
    float mw = exp(-b * b * 16.0);
    float n1 = fbm(p * 3.0 + 2.0, 6), n2 = fbm(p * 9.0 + 5.0, 5);
    vec3 col = mix(vec3(0.0025, 0.003, 0.009), vec3(0.004, 0.004, 0.013), smoothstep(-0.5, 0.8, p.y));
    col += mw * (0.012 + 0.07 * n1 * n1) * vec3(0.66, 0.6, 0.88);
    col *= 1.0 - mw * smoothstep(0.48, 0.66, n2) * 0.6;
    float neb = smoothstep(0.5, 0.78, fbm(p * 1.7 + 9.0, 6));
    vec3 nebC = mix(vec3(0.15, 0.025, 0.11), vec3(0.015, 0.07, 0.13), smoothstep(0.35, 0.65, fbm(p * 2.4 + 1.0, 4)));
    col += neb * nebC * 0.28 * (0.6 + 0.8 * fbm(p * 6.0, 4));
    gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
    return;
  }

  vec3 q = vec3(fbm(p * 1.6 + 4.0, 5), fbm(p * 1.6 + 11.3, 5), fbm(p * 1.6 + 23.7, 5));
  float hgt = fbm(p * 1.3 + q * 1.4, 7);
  float land = smoothstep(LAND, LAND + 0.01, hgt);
  float lat = abs(p.y);

  if (uPass > 0.5) {
    vec3 w = vec3(fbm(p * 1.1 + 7.0, 4)) * 1.6;
    float c = fbm(p * 2.2 + w, 6) + 0.07 * cos(p.y * 9.0);
    float wisps = fbm(p * vec3(9.0, 22.0, 9.0) + 3.0, 5);
    float cloud = smoothstep(0.55, 0.69, c) * 0.88 + smoothstep(0.6, 0.78, wisps) * 0.3 * smoothstep(0.45, 0.56, c);
    gl_FragColor = vec4(clamp(cloud, 0.0, 1.0), 1.0 - land, 0.0, 1.0);
    return;
  }

  float shelf = smoothstep(LAND - 0.06, LAND, hgt);
  vec3 ocean = mix(vec3(0.003, 0.014, 0.06), vec3(0.012, 0.07, 0.17), shelf);
  ocean = mix(ocean, vec3(0.03, 0.18, 0.26), shelf * shelf * shelf * 0.7);
  float dry = fbm(p * 4.0 + 11.0, 5);
  float belt = 1.0 - smoothstep(0.0, 0.17, abs(lat - 0.33));
  float desert = smoothstep(0.47, 0.6, dry * 0.75 + belt * 0.42 - (hgt - LAND) * 0.6);
  vec3 green = mix(vec3(0.035, 0.12, 0.04), vec3(0.16, 0.22, 0.08), smoothstep(0.35, 0.65, dry));
  vec3 lc = mix(green, vec3(0.5, 0.37, 0.22), desert);
  lc = mix(lc, vec3(0.26, 0.23, 0.2), smoothstep(LAND + 0.07, LAND + 0.13, hgt));
  lc = mix(lc, vec3(0.13, 0.15, 0.1), smoothstep(0.58, 0.78, lat) * (1.0 - desert));
  lc *= 0.85 + 0.3 * fbm(p * 30.0, 3);
  vec3 col = mix(ocean, lc, land);
  float ice = smoothstep(0.89, 0.94, lat + (fbm(p * 6.0, 4) - 0.5) * 0.12);
  col = mix(col, vec3(0.82, 0.88, 0.94), ice);

  float coast = 1.0 - smoothstep(LAND, LAND + 0.05, hgt);
  float region = smoothstep(0.52, 0.7, fbm(p * 6.0 + 2.0, 4) + coast * 0.12) * (1.0 - smoothstep(0.62, 0.8, lat)) * (1.0 - desert * 0.75);
  float dots = smoothstep(0.6, 0.82, noise(p * 150.0)) + 0.7 * smoothstep(0.68, 0.9, noise(p * 330.0));
  float city = land * (1.0 - ice) * region * (0.2 + dots);
  gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), clamp(city, 0.0, 1.0));
}`;

function bake(renderer, size) {
  const mk = (w, h) => new THREE.WebGLRenderTarget(w, h, {
    generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false, anisotropy: 8,
  });
  const targets = [mk(size, size / 2), mk(size / 2, size / 4), mk(2048, 1024)];
  const mat = new THREE.ShaderMaterial({
    uniforms: { uPass: { value: 0 } }, depthTest: false, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: BAKE,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const sc = new THREE.Scene();
  sc.add(quad);
  const cam = new THREE.Camera();
  const prev = renderer.getRenderTarget();
  targets.forEach((rt, i) => { mat.uniforms.uPass.value = i; renderer.setRenderTarget(rt); renderer.render(sc, cam); });
  renderer.setRenderTarget(prev);
  quad.geometry.dispose(); mat.dispose();
  return { surface: targets[0].texture, clouds: targets[1].texture, sky: targets[2].texture };
}

const EARTH_VS = /* glsl */ `
varying vec2 vUv; varying vec3 vN; varying vec3 vW;
void main() {
  vUv = uv;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const EARTH_FS = /* glsl */ `
uniform sampler2D uSurf; uniform sampler2D uCloud;
uniform vec3 uL; uniform vec3 uCam; uniform float uCloudOff; uniform float uCity;
varying vec2 vUv; varying vec3 vN; varying vec3 vW;
void main() {
  vec4 s = texture2D(uSurf, vUv);
  vec3 alb = pow(s.rgb, vec3(2.2));
  float cl = texture2D(uCloud, vUv + vec2(uCloudOff, 0.0)).r;
  float ocean = texture2D(uCloud, vUv).g;
  vec3 n = normalize(vN), V = normalize(uCam - vW);
  float ndl = dot(n, uL);
  float lit = max(ndl, 0.0);
  float day = smoothstep(-0.08, 0.22, ndl);
  vec3 col = alb * (lit * 1.9 + 0.01);
  vec3 H = normalize(uL + V);
  col += ocean * (1.0 - cl) * pow(max(dot(n, H), 0.0), 160.0) * 0.5 * day * vec3(1.0, 0.88, 0.72);
  col = mix(col, vec3(0.92, 0.94, 0.97) * (lit * 0.95 + 0.006), cl * 0.88);
  col += s.a * (1.0 - day) * (1.0 - cl * 0.8) * vec3(1.0, 0.6, 0.27) * 1.5 * uCity;
  float mu = max(dot(n, V), 0.0);
  float fr = pow(1.0 - mu, 3.0);
  col += vec3(0.01, 0.03, 0.08) * day * fr;
  col += vec3(0.16, 0.42, 1.0) * fr * (smoothstep(-0.25, 0.5, ndl) * 0.9 + 0.03);
  col += vec3(1.0, 0.4, 0.12) * exp(-ndl * ndl * 30.0) * fr * 0.8;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Thin sky-blue halo outside the rim, orange where day turns to night, faint on the night side.
const ATMO_FS = /* glsl */ `
uniform vec3 uCenter; uniform vec3 uCam; uniform vec3 uL; uniform float uR; uniform float uRa;
varying vec3 vW;
void main() {
  vec3 rd = normalize(vW - uCam);
  vec3 oc = uCenter - uCam;
  vec3 closest = uCam + rd * dot(oc, rd);
  float b = length(closest - uCenter);
  float t = clamp((uRa - b) / (uRa - uR), 0.0, 1.0);
  float g = pow(t, 3.0) * 0.35 + pow(t, 14.0) * 0.9;
  float sd = dot(normalize(closest - uCenter), uL);
  vec3 c = mix(vec3(1.0, 0.45, 0.16), vec3(0.3, 0.6, 1.0), smoothstep(-0.05, 0.45, sd));
  float k = smoothstep(-0.35, 0.3, sd) + 0.05;
  gl_FragColor = vec4(c * g * k, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const SKY_FS = /* glsl */ `
uniform sampler2D uSky; uniform float uGain;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(pow(texture2D(uSky, vUv).rgb, vec3(2.2)) * uGain, 1.0);
  #include <colorspace_fragment>
}`;

const STAR_VS = /* glsl */ `
attribute float aSize; attribute vec3 aColor; attribute float aPhase;
uniform float uPx; uniform float uTime;
varying vec3 vC; varying float vTw;
void main() {
  vC = aColor;
  vTw = 0.78 + 0.22 * sin(uTime * (1.5 + aPhase * 2.5) + aPhase * 40.0);
  gl_PointSize = aSize * uPx;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const STAR_FS = /* glsl */ `
uniform float uGain;
varying vec3 vC; varying float vTw;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(vC * a * a * vTw * uGain, 1.0);
}`;

function glowSprite(tex, color, scale, opacity = 1) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
  }));
  s.scale.setScalar(scale);
  return s;
}

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _m = new THREE.Matrix4(), _s = new THREE.Vector3();

export function createSpace({ renderer, scene, quality = 'ultra' }) {
  const big = quality === 'ultra' && renderer.capabilities.maxTextureSize >= 4096;
  const T = bake(renderer, big ? 4096 : 2048);
  const glowTex = TX.sunTexture();

  // ================================================================ far: sky, Earth, Sun
  const bg = new THREE.Scene();
  const bgCam = new THREE.PerspectiveCamera(42, 1, 10, SKY_R * 1.2);

  const skyMat = new THREE.ShaderMaterial({
    uniforms: { uSky: { value: T.sky }, uGain: { value: 1 } }, side: THREE.BackSide, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: SKY_FS,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(SKY_R, 96, 48), skyMat);
  sky.renderOrder = -2;
  bg.add(sky);

  const starMat = new THREE.ShaderMaterial({
    uniforms: { uPx: { value: 1 }, uTime: { value: 0 }, uGain: { value: 1 } },
    vertexShader: STAR_VS, fragmentShader: STAR_FS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  {
    const r = TX.rng(77), n = 6500;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), phase = new Float32Array(n);
    const band = new THREE.Vector3(0.42, 0.8, -0.42).normalize();
    const tints = [[0.7, 0.8, 1], [0.85, 0.9, 1], [1, 1, 1], [1, 0.95, 0.82], [1, 0.82, 0.62], [1, 0.72, 0.85], [0.7, 1, 0.95]];
    for (let i = 0; i < n; i++) {
      // a third of the stars crowd the Milky Way band
      let d;
      do {
        const u = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
        d = _v.set(s * Math.cos(a), u, s * Math.sin(a));
      } while (i % 3 === 0 && Math.abs(d.dot(band)) > 0.18 + r() * 0.1);
      d.multiplyScalar(SKY_R * 0.92);
      pos.set([d.x, d.y, d.z], i * 3);
      const big = r() ** 9;
      size[i] = 1.1 + big * 4.2 + r() * 0.8;
      const t = tints[Math.floor(r() ** 1.6 * tints.length)];
      const b = 0.35 + r() * 0.5 + big * 1.4;
      col.set([t[0] * b, t[1] * b, t[2] * b], i * 3);
      phase[i] = r();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    const stars = new THREE.Points(g, starMat);
    stars.renderOrder = -1;
    stars.frustumCulled = false;
    bg.add(stars);
  }

  const earthPos = EARTH_DIR.clone().multiplyScalar(EARTH_DIST);
  const earthMat = new THREE.ShaderMaterial({
    uniforms: {
      uSurf: { value: T.surface }, uCloud: { value: T.clouds }, uL: { value: new THREE.Vector3(0, 1, 0) },
      uCam: { value: new THREE.Vector3() }, uCloudOff: { value: 0 }, uCity: { value: 1 },
    },
    vertexShader: EARTH_VS, fragmentShader: EARTH_FS,
  });
  // poles off to the side, so we look down on the tropics rather than an ice cap
  const upP = new THREE.Vector3(0, 1, 0).addScaledVector(EARTH_DIR, -EARTH_DIR.y).normalize();
  const rightP = new THREE.Vector3().crossVectors(EARTH_DIR, upP).normalize();
  const earthTilt = new THREE.Group();
  earthTilt.position.copy(earthPos);
  earthTilt.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0),
    new THREE.Vector3().addScaledVector(rightP, -0.85).addScaledVector(upP, 0.3).addScaledVector(EARTH_DIR, -0.42).normalize());
  const earth = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 192, 96), earthMat);
  earth.rotation.y = 2.2;
  earthTilt.add(earth);
  bg.add(earthTilt);
  const atmoMat = new THREE.ShaderMaterial({
    uniforms: {
      uCenter: { value: earthPos }, uCam: { value: new THREE.Vector3() }, uL: earthMat.uniforms.uL,
      uR: { value: EARTH_R }, uRa: { value: EARTH_R * 1.045 },
    },
    vertexShader: 'varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: ATMO_FS,
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R * 1.045, 128, 64), atmoMat);
  atmo.position.copy(earthPos);
  bg.add(atmo);

  // the Sun: hidden by the Earth's depth when it is behind it
  const sun = new THREE.Group();
  const sunCore = glowSprite(glowTex, '#FFF6E8', SUN_DIST * 0.2);
  const sunRays = glowSprite(TX.sunRaysTexture(), '#FFE6C4', SUN_DIST * 0.34, 0.75);
  sun.add(sunCore, sunRays);
  bg.add(sun);
  // glare that spills over the Earth's rim once the Sun is clear of it
  const glare = glowSprite(glowTex, '#FFD9B0', SUN_DIST * 0.6, 0);
  glare.material.depthTest = false;
  glare.renderOrder = 5;
  bg.add(glare);

  // the Sun's path: it rises over the Earth's left rim, slides along it through the day,
  // sets behind the right rim and stays behind the Earth at night
  const sunDir = new THREE.Vector3();
  const state = { lamp: 0, sunVis: 0 };
  function setTime(hour, k, dayness) {
    const h = ((hour % 24) + 24) % 24;
    const arc = THREE.MathUtils.clamp((h - 6) / 12, 0, 1);
    const up = THREE.MathUtils.smoothstep(h, 4.6, 6.4) * (1 - THREE.MathUtils.smoothstep(h, 17.8, 19.6));
    const phi = THREE.MathUtils.lerp(-0.62, 0.62, arc);
    const rho = (EARTH_ANG + (2 + 2.5 * Math.sin(Math.PI * arc)) * DEG) * (0.55 + 0.45 * up);
    sunDir.copy(EARTH_DIR).multiplyScalar(Math.cos(rho))
      .addScaledVector(_v.copy(upP).multiplyScalar(Math.cos(phi)).addScaledVector(rightP, Math.sin(phi)), Math.sin(rho)).normalize();
    sun.position.copy(sunDir).multiplyScalar(SUN_DIST);
    // light the Earth from the Sun, swung towards us by day so more of the day side shows
    const L = earthMat.uniforms.uL.value;
    L.copy(sun.position).sub(earthPos).normalize().addScaledVector(EARTH_DIR, -0.9 * up).normalize();
    state.sunVis = up;
    starMat.uniforms.uGain.value = 0.7 + 0.3 * k.stars;
    skyMat.uniforms.uGain.value = 0.75 + 0.25 * k.stars;
    state.lamp = k.lamp;
    for (const m of lampMats) m.emissiveIntensity = 0.6 + k.lamp * 1.6;
  }

  // ================================================================ near: in the office scene
  const near = new THREE.Group();
  scene.add(near);
  const M = {
    white: new THREE.MeshStandardMaterial({ color: '#E8E9EE', roughness: 0.45, metalness: 0.15 }),
    metal: new THREE.MeshStandardMaterial({ color: '#9AA1AD', roughness: 0.3, metalness: 0.85 }),
    dark: new THREE.MeshStandardMaterial({ color: '#2A2F3B', roughness: 0.5, metalness: 0.5 }),
    foil: new THREE.MeshStandardMaterial({ map: TX.foilTexture(), roughness: 0.32, metalness: 1 }),
    solar: new THREE.MeshStandardMaterial({ map: TX.solarPanelTexture(), roughness: 0.28, metalness: 0.55, side: THREE.DoubleSide, emissive: '#0B1A3C', emissiveIntensity: 0.4 }),
    truss: new THREE.MeshStandardMaterial({ map: TX.trussTexture(), roughness: 0.4, metalness: 0.7, alphaTest: 0.5, side: THREE.DoubleSide }),
    window: new THREE.MeshStandardMaterial({ color: '#2B2410', emissive: '#FFD9A0', emissiveIntensity: 1 }),
  };
  const lampMats = [M.window];
  const blinkers = [];
  const blink = (parent, x, y, z, color, scale, rate, phase) => {
    const s = glowSprite(glowTex, color, scale, 0);
    s.position.set(x, y, z);
    s.userData = { rate, phase };
    parent.add(s);
    blinkers.push(s);
  };

  // Every craft below is modelled as lists of pieces per material and merged, so a whole station
  // costs a handful of draw calls however much detail it carries.
  const bins = () => ({ white: [], metal: [], dark: [], foil: [], solar: [], window: [] });
  const build = (group, B) => {
    for (const [key, list] of Object.entries(B)) if (list.length) group.add(new THREE.Mesh(merge(list), M[key]));
    return group;
  };
  const QX = Math.PI / 2;
  // A pressurised module along +Y: end cones down to the docking collar, raised bands round the hull.
  const moduleGeo = (len, r, seg = 28) => {
    const h = len / 2, c = Math.min(0.5 * r, h * 0.3), band = (y) => [[r, y - 0.1], [r + 0.04, y - 0.07], [r + 0.04, y + 0.07], [r, y + 0.1]];
    return lathe([[0, -h], [0.56 * r, -h, 1], [0.62 * r, -h + 0.03], [r, -h + c], ...band(-h * 0.36), ...band(h * 0.36), [r, h - c], [0.62 * r, h - 0.03], [0.56 * r, h, 1], [0, h]], seg);
  };
  const collarGeo = (r) => lathe([[r, -0.12, 1], [r + 0.07, -0.09], [r + 0.07, 0.09], [r, 0.12, 1]], 20);
  // A dish along +Y (opening upwards) with its feed on three struts.
  const dishGeo = (r, B, place) => {
    const d = 0.3 * r;
    B.white.push(place(lathe([[0, -0.04 * r], [0.33 * r, 0], [0.66 * r, 0.1 * r], [r, d], [1.02 * r, d + 0.02 * r], [r, d + 0.03 * r], [0.66 * r, 0.14 * r], [0.33 * r, 0.04 * r], [0, 0]], 24)));
    B.metal.push(place(lathe([[0, 0.62 * r], [0.07 * r, 0.62 * r, 1], [0.1 * r, 0.76 * r], [0.04 * r, 0.8 * r], [0, 0.8 * r]], 10)));
    for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2; B.metal.push(place(rod([Math.cos(a) * r * 0.92, d * 0.9, Math.sin(a) * r * 0.92], [Math.cos(a) * r * 0.06, 0.66 * r, Math.sin(a) * r * 0.06], 0.02 * r, 0.02 * r, 4))); }
  };
  // A solar blanket lying in XZ, long side along Z, in a frame with battens. Cells keep their
  // proportions: four across the short side, rows along the long one.
  const blanket = (B, w, len, x, y, z, turn = 0, t = 0.03) => {
    const place = (g) => g.rotateY(turn).translate(x, y, z);
    B.solar.push(place(mapUV(part(new THREE.BoxGeometry(w, t, len)), (px, py, pz) => [px / w + 0.5, (pz / w) * 0.25])));
    const rail = Math.max(0.035, w * 0.035);
    for (const s of [-1, 1]) {
      B.metal.push(place(part(new THREE.BoxGeometry(rail, rail * 1.4, len + rail), s * w / 2, 0, 0)));
      B.metal.push(place(part(new THREE.BoxGeometry(w, rail * 1.4, rail), 0, 0, s * len / 2)));
    }
    const n = Math.max(1, Math.round(len / (w * 1.6)));
    for (let i = 1; i < n; i++) B.metal.push(place(part(new THREE.BoxGeometry(w, rail, rail * 0.8), 0, 0, -len / 2 + (len * i) / n)));
  };

  // ---- space station: a long truss, eight solar wings, radiators and a string of modules
  const station = new THREE.Group();
  {
    const g = station, B = bins();
    // the alpha-tested lattice still reads best from 100 m away; real longerons and bulkhead frames give it depth
    const truss = new THREE.Mesh(new THREE.BoxGeometry(36, 1.1, 1.1), M.truss);
    g.add(truss);
    for (const y of [-0.55, 0.55]) for (const z of [-0.55, 0.55]) B.metal.push(part(rod([-18, y, z], [18, y, z], 0.05, 0.05, 6)));
    for (let i = 0; i <= 8; i++) {
      const x = -18 + i * 4.5, c = [[-0.55, -0.55], [0.55, -0.55], [0.55, 0.55], [-0.55, 0.55]];
      c.forEach(([y, z], k) => { const [y2, z2] = c[(k + 1) % 4]; B.metal.push(part(rod([x, y, z], [x, y2, z2], 0.04, 0.04, 4))); });
    }
    // solar wings: a mast through a gimbal canister, two framed blankets either side of it
    for (const x of [-17.4, -14.1, 14.1, 17.4]) {
      B.metal.push(part(rod([x, 0, -11.6], [x, 0, 11.6], 0.09, 0.09, 6, true)));
      B.foil.push(part(RB(1.2, 1.3, 1.6, 0.12, 1), x, 0, 0));
      for (const s of [-1, 1]) {
        B.metal.push(part(new THREE.CylinderGeometry(0.3, 0.3, 0.36, 14), x, 0, s * 0.95, QX));
        for (const o of [-0.66, 0.66]) blanket(B, 1.12, 10.3, x + o, 0, s * 6.35);
      }
    }
    // rotary joints between the inboard and outboard truss
    for (const x of [-11.2, 11.2]) {
      B.metal.push(part(lathe([[0.56, -0.7], [0.75, -0.6], [0.78, -0.22], [0.87, -0.16], [0.87, 0.16], [0.78, 0.22], [0.75, 0.6], [0.56, 0.7]], 24), x, 0, 0, 0, 0, QX));
    }
    // radiators: ribbed panels hanging from a boom
    for (const x of [-6.4, 6.4]) {
      B.metal.push(part(rod([x, -0.55, -2.3], [x, -0.75, 2.3], 0.07, 0.07, 6, true)));
      for (let i = 0; i < 3; i++) {
        const px = x + (i - 1) * 0.5, pz = (i - 1) * 1.9;
        B.white.push(part(new THREE.BoxGeometry(0.05, 5.2, 1.7), px, -3.3, pz));
        for (let k = 0; k < 6; k++) B.white.push(part(new THREE.BoxGeometry(0.11, 0.06, 1.74), px, -5.7 + k * 0.96, pz));
        B.metal.push(part(new THREE.BoxGeometry(0.14, 0.1, 1.8), px, -0.68, pz));
      }
    }
    // the pressurised stack along Z, hung under the truss
    const Y = -1.6;
    const mods = [[-9.6, 4.6, 0.95, 'white'], [-3.7, 4.8, 1, 'white'], [2.4, 5, 1, 'white'], [7.2, 4, 0.9, 'foil'], [10.4, 2.2, 0.62, 'dark']];
    for (const [z, len, r, key] of mods) {
      B[key].push(part(moduleGeo(len, r), 0, Y, z, QX));
      for (const e of [-1, 1]) B.metal.push(part(collarGeo(0.56 * r), 0, Y, z + e * (len / 2 + 0.02), QX));
      if (key !== 'white') continue;
      for (const s of [-1, 1]) {
        const a = s * 0.62; // handrails along the upper flanks, portholes below them
        B.metal.push(part(rod([Math.sin(a) * (r + 0.09), Y + Math.cos(a) * (r + 0.09), z - len / 2 + 0.9], [Math.sin(a) * (r + 0.09), Y + Math.cos(a) * (r + 0.09), z + len / 2 - 0.9], 0.025, 0.025, 4)));
        for (let k = -1; k <= 1; k++) {
          const b = s * 1.25, wz = z + k * len * 0.24;
          B.window.push(part(new THREE.CylinderGeometry(0.11, 0.11, 0.04, 10), Math.sin(b) * (r + 0.02), Y + Math.cos(b) * (r + 0.02), wz, 0, 0, -b));
          B.metal.push(part(rod([Math.sin(a) * r, Y + Math.cos(a) * r, wz + 0.5], [Math.sin(a) * (r + 0.09), Y + Math.cos(a) * (r + 0.09), wz + 0.5], 0.02, 0.02, 4)));
        }
      }
    }
    // nodes: short drums with berthing ports up to the truss, down and to both sides
    const nodeGeo = lathe([[0.6, -1.05], [0.95, -0.85], [1.15, -0.45], [1.15, 0.45], [0.95, 0.85], [0.6, 1.05]], 28);
    for (const z of [-6.6, -0.6]) {
      B.white.push(part(nodeGeo, 0, Y, z, QX));
      B.metal.push(part(collarGeo(0.56), 0, Y + 1.12, z), part(collarGeo(0.56), 0, Y - 1.12, z));
      B.metal.push(part(collarGeo(0.56), 1.12, Y, z, 0, 0, QX), part(collarGeo(0.56), -1.12, Y, z, 0, 0, QX));
    }
    for (const s of [-1, 1]) B[s < 0 ? 'white' : 'foil'].push(part(moduleGeo(3.6, 0.9), s * 2.95, Y, -0.6, 0, 0, QX));
    // cupola under the forward node: six glowing panes in a frame
    {
      const pane = lathe([[0, -0.3], [0.36, -0.3], [0.6, 0.05]], 6).toNonIndexed();
      pane.computeVertexNormals();
      B.window.push(part(pane, 0, Y - 1.5, -6.6));
      B.metal.push(part(new THREE.CylinderGeometry(0.64, 0.64, 0.2, 12), 0, Y - 1.36, -6.6));
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2, a2 = ((i + 1) / 6) * Math.PI * 2, p = (rad, ang, y) => [Math.sin(ang) * rad, Y - 1.5 + y, -6.6 + Math.cos(ang) * rad];
        B.metal.push(part(rod(p(0.37, a, -0.3), p(0.61, a, 0.05), 0.03, 0.03, 4)), part(rod(p(0.37, a, -0.3), p(0.37, a2, -0.3), 0.03, 0.03, 4)));
      }
    }
    // aft: two small wings on yokes, and a visiting capsule on the last port
    for (const s of [-1, 1]) {
      blanket(B, 0.7, 2.5, s * 1.95, Y, 10.6, QX);
      B.metal.push(part(rod([s * 0.6, Y, 10.6], [s * 0.72, Y, 10.6], 0.04, 0.04, 6)));
    }
    B.white.push(part(lathe([[0.3, 0], [0.3, 0.15], [0.68, 1.05], [0.7, 1.2, 1], [0.6, 1.3], [0, 1.34]], 20), 0, Y, 11.5, QX));
    B.dark.push(part(lathe([[0.6, 1.3], [0.62, 1.34], [0.62, 1.95, 1], [0, 1.95]], 20), 0, Y, 11.5, QX));
    for (const s of [-1, 1]) blanket(B, 0.45, 1.4, s * 1.35, Y, 13.15, QX);
    // on top of the truss: a dish on a boom, whip aerials and the robot arm
    B.metal.push(part(rod([3, 0.5, 0], [3, 2.3, 0.2], 0.07, 0.05, 6)));
    dishGeo(0.95, B, (geo) => part(geo, 3, 2.3, 0.2, 0.5, 0, -0.35));
    for (const [x, z] of [[-2.2, 0.4], [8.4, -0.4], [-9, 0.3]]) B.metal.push(part(rod([x, 0.5, z], [x + 0.2, 2.6, z * 2], 0.025, 0.012, 4)));
    {
      const pts = [[-4, 0.6, 0.3], [-5.4, 2.5, 1.3], [-7.3, 1.5, 2.4], [-7.5, 0.9, 2.6]];
      for (let i = 0; i < 3; i++) B.white.push(part(rod(pts[i], pts[i + 1], 0.1, 0.1, 8)));
      for (const p of pts) B.metal.push(part(new THREE.SphereGeometry(0.15, 10, 8), ...p));
    }
    build(g, B);
    blink(g, -18.6, 0, 0, '#FF4D5E', 2.2, 1, 0);
    blink(g, 18.6, 0, 0, '#4DFF9A', 2.2, 1, 0.5);
    blink(g, 0, 0.8, 0, '#FFFFFF', 2.6, 0.7, 0.2);
    near.add(g);
  }
  const stationOrbit = { r: 150, a: -Math.PI / 2 - 0.35, speed: (Math.PI * 2) / 900 };

  // ---- ring station far off to the right, spinning slowly
  const ring = new THREE.Group();
  const wheel = new THREE.Group();
  {
    const W = bins(), S = bins();
    // the wheel: habitat tube with structural ribs, capsule pods, window strips, spokes and stays
    W.white.push(part(new THREE.TorusGeometry(22, 2.4, 20, 120)));
    const rib = new THREE.TorusGeometry(2.47, 0.1, 4, 14).rotateX(QX);
    const pod = lathe([[0, -3.3], [0.7, -3.24], [1.16, -2.9], [1.26, -2.5], [1.26, -0.2], [1.32, -0.14], [1.32, 0.14], [1.26, 0.2], [1.26, 2.5], [1.16, 2.9], [0.7, 3.24], [0, 3.3]], 14);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      W.white.push(part(rib.clone().rotateZ(a).translate(Math.cos(a) * 22, Math.sin(a) * 22, 0)));
    }
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.26;
      W.white.push(part(pod, Math.cos(a) * 22, Math.sin(a) * 22, 0, QX));
      for (const z of [-3.32, 3.32]) W.window.push(part(new THREE.CylinderGeometry(0.42, 0.42, 0.06, 12), Math.cos(a) * 22, Math.sin(a) * 22, z, QX));
    }
    for (const r of [19.75, 24.25]) W.window.push(part(new THREE.TorusGeometry(r, 0.32, 5, 96)));
    const spoke = lathe([[0.95, -10.2], [0.55, -9.2], [0.55, -0.7], [0.78, -0.5], [0.78, 0.5], [0.55, 0.7], [0.55, 9.2], [0.95, 10.2]], 12);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      W.metal.push(part(spoke, -Math.sin(a) * 10.5, Math.cos(a) * 10.5, 0, 0, 0, a));
      const b = a + Math.PI / 4;
      W.metal.push(part(rod([Math.cos(b) * 2.6, Math.sin(b) * 2.6, 0], [Math.cos(b) * 19.7, Math.sin(b) * 19.7, 0], 0.14, 0.14, 5)));
    }
    ring.add(build(wheel, W));
    // the still axis: hub with end cones and a lit window band, mast, four framed wings, the dish
    S.white.push(part(lathe([[1.2, -4.6], [1.6, -4.4], [2.2, -3.6], [3, -3.2], [3, -1.0], [3.25, -0.9], [3.25, 0.9], [3, 1.0], [3, 3.2], [2.2, 3.6], [1.6, 4.4], [1.2, 4.6]], 32), 0, 0, 0, QX));
    for (const z of [-2.1, 2.1]) S.window.push(part(lathe([[3.03, -0.22], [3.03, 0.22]], 32), 0, 0, z, QX));
    S.metal.push(part(rod([0, 0, -15], [0, 0, 15], 0.4, 0.4, 10, true)));
    for (const z of [-11, 11]) {
      S.metal.push(part(collarGeo(0.42), 0, 0, z, QX));
      for (const s of [-1, 1]) {
        S.metal.push(part(rod([s * 0.4, 0, z], [s * 1.5, 0, z], 0.16, 0.16, 6)));
        for (const o of [-1.08, 1.08]) blanket(S, 2.0, 14, s * 8.5, 0, z + o, QX, 0.06);
      }
    }
    dishGeo(3, S, (geo) => part(geo, 0, 0, 15.2, QX));
    S.metal.push(part(lathe([[0.4, 0], [0.9, 0.3], [0.9, 0.9, 1], [0.5, 1.0]], 16), 0, 0, -15, -QX));
    build(ring, S);
    blink(ring, 0, 0, 18, '#FF4D5E', 5, 0.6, 0.1);
    ring.position.set(250, -150, -470);
    ring.rotation.set(0.85, -0.5, 0.25);
    near.add(ring);
  }

  // ---- satellites on tilted orbits around the office
  const sats = [];
  {
    const r = TX.rng(404);
    // each kind is modelled once; the eight satellites share those geometries
    const kinds = [bins(), bins(), bins()].map((B, kind) => {
      if (kind === 0) {           // comms satellite: gold bus, two long framed wings on yokes, a dish, whips, thrusters
        B.foil.push(part(RB(1.4, 1.4, 1.8, 0.1, 1)));
        for (const s of [-1, 1]) {
          blanket(B, 1.3, 4.6, s * 3.2, 0, 0, QX, 0.04);
          B.metal.push(part(rod([s * 0.7, 0, 0], [s * 0.92, 0, 0], 0.06, 0.06, 6)));
          B.metal.push(part(rod([s * 0.9, 0, 0], [s * 0.9, 0, 0.6], 0.03, 0.03, 4)), part(rod([s * 0.9, 0, 0], [s * 0.9, 0, -0.6], 0.03, 0.03, 4)));
          B.metal.push(part(rod([s * 0.45, 0.7, -0.5], [s * 0.95, 1.9, -0.9], 0.02, 0.01, 4)));
          for (const y of [-0.4, 0.4]) B.dark.push(part(lathe([[0.05, 0], [0.14, -0.22], [0.16, -0.22], [0.07, 0]], 8), s * 0.4, y, -0.9, QX));
        }
        dishGeo(0.9, B, (geo) => part(geo, 0, 0, 0.94, QX));
        B.metal.push(part(RB(1.0, 0.5, 0.06, 0.02, 1), 0, 0.72, 0.2, QX));
      } else if (kind === 1) {    // observatory: a white tube with a dark baffle, an open lid, two wings and an aerial
        B.white.push(part(lathe([[0, -1.7], [0.5, -1.7, 1], [0.7, -1.5], [0.7, 1.0], [0.745, 1.03], [0.745, 1.7, 1], [0.69, 1.7]], 24), 0, 0, 0, QX));
        B.dark.push(part(lathe([[0.69, 1.7], [0.69, 0.5, 1], [0, 0.5]], 24), 0, 0, 0, QX));
        B.dark.push(part(lathe([[0.72, -0.5], [0.74, -0.46], [0.74, -0.14], [0.72, -0.1]], 24), 0, 0, 0, QX));
        B.white.push(part(new THREE.CylinderGeometry(0.74, 0.74, 0.05, 24), 0, 0.99, 2.4, -0.35));          // aperture door, hinged open
        B.metal.push(part(rod([-0.2, 0.75, 1.72], [0.2, 0.75, 1.72], 0.04, 0.04, 6, true)));
        for (const s of [-1, 1]) {
          blanket(B, 1.2, 2.6, s * 1.75, 0, -0.3, 0, 0.04);
          B.metal.push(part(rod([s * 0.7, 0, -0.3], [s * 1.15, 0, -0.3], 0.05, 0.05, 6)));
        }
        B.metal.push(part(rod([0, -0.7, -1.2], [0, -1.5, -1.5], 0.035, 0.035, 5)));
        dishGeo(0.34, B, (geo) => part(geo, 0, -1.5, -1.5, Math.PI - 0.5));
        for (const z of [-0.95, 0.6]) B.metal.push(part(new THREE.TorusGeometry(0.72, 0.03, 4, 24), 0, 0, z));
      } else {                    // cubesat: rails on the corners, body cells, fold-out panels on hinges, a lens, tape aerials
        B.metal.push(part(RB(0.6, 0.6, 0.9, 0.03, 1)));
        for (const x of [-1, 1]) {
          for (const y of [-1, 1]) {
            B.dark.push(part(new THREE.BoxGeometry(0.06, 0.06, 0.96), x * 0.29, y * 0.29, 0));
            B.metal.push(part(rod([x * 0.27, y * 0.27, 0.46], [x * 0.72, y * 0.72, 0.98], 0.012, 0.012, 4)));
          }
          blanket(B, 0.85, 0.9, x * 0.79, 0, 0, QX, 0.03);
          B.metal.push(part(new THREE.CylinderGeometry(0.03, 0.03, 0.85, 8), x * 0.32, 0, 0, QX));
        }
        for (const y of [-1, 1]) B.solar.push(mapUV(part(new THREE.BoxGeometry(0.46, 0.012, 0.8), 0, y * 0.305, 0), (px, py, pz) => [px / 0.46 + 0.5, pz / 1.84]));
        B.dark.push(part(lathe([[0.17, 0], [0.19, 0.02], [0.19, 0.09], [0.15, 0.11], [0.13, 0.05], [0, 0.04]], 14), 0, 0, 0.45, QX));
      }
      return Object.entries(B).filter(([, list]) => list.length).map(([key, list]) => [merge(list), M[key]]);
    });
    for (let i = 0; i < 8; i++) {
      const g = new THREE.Group();
      for (const [geo, mat] of kinds[i % 3]) g.add(new THREE.Mesh(geo, mat));
      const scale = i % 3 === 2 ? 1.6 : 1;
      g.scale.setScalar(scale);
      blink(g, 0, 0.9, 0, i % 2 ? '#FF5C7A' : '#7CE0FF', 1.4, 0.8 + r() * 0.6, r());
      near.add(g);
      sats.push({
        g, r: 50 + r() * 45, a: r() * Math.PI * 2, speed: ((Math.PI * 2) / (70 + r() * 90)) * (r() < 0.25 ? -1 : 1),
        tilt: new THREE.Quaternion().setFromEuler(_e.set((r() - 0.5) * 1.1, r() * Math.PI, (r() - 0.5) * 0.8)), y: -6 + r() * 12,
        spin: (r() - 0.5) * 0.6,
      });
    }
  }

  // ---- asteroid belt: three rock shapes, instanced, tumbling along a tilted ring
  const belt = new THREE.Group();
  belt.position.y = -16;
  belt.rotation.set(0.2, 0, -0.1);
  near.add(belt);
  const rockMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, metalness: 0.05, flatShading: true });
  rockMat.flatShading = false; // the rocks carry their own smooth normals now
  const rocks = [];
  const rockMeshes = [];
  const MAX_ROCKS = 270;
  {
    const r = TX.rng(9);
    // Each shape: several octaves of noise, a few broad lobes, and craters with a raised rim.
    // It is built twice: dense for the big rocks that pass close, light for the gravel.
    const shapes = [0, 1, 2].map((v) => {
      const craters = Array.from({ length: 7 }, () => [new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(), 0.84 + r() * 0.12, 0.1 + r() * 0.14]);
      const lobes = Array.from({ length: 3 }, () => [new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(), 1.5 + r() * 2, r() * 6, 0.06 + r() * 0.08]);
      const shape = (d, f) => {
        for (const [dir, k, ph, amp] of lobes) f += amp * Math.sin(d.dot(dir) * k + ph);
        for (const [dir, edge, depth] of craters) {
          const t = (d.dot(dir) - edge) / (1 - edge);
          if (t > 0) f -= depth * Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5);
          if (t > -0.5 && t < 0.25) f += depth * 0.35 * Math.exp(-((t / 0.16) ** 2));
        }
        return f;
      };
      return [5, 2].map((detail) => blob(detail, 31 + v * 7, { amp: 0.3, freq: 1.4, oct: detail > 2 ? 4 : 2, puff: detail > 2 ? 0.1 : 0, puffFreq: 3.4, shape }));
    });
    const colors = ['#8C8379', '#6F6A66', '#9A8A78', '#7A7068', '#857B8A'];
    const tint = [];
    for (let i = 0; i < MAX_ROCKS; i++) {
      const v = i % 3;
      const radius = 62 + (r() ** 0.8) * 75;
      const giant = i < 4;
      const size = giant ? 2.6 + r() * 2 : 0.25 + (r() ** 4) * 2.2;
      rocks.push({
        m: v * 2 + (size > 1.5 ? 0 : 1), idx: 0, radius, a: r() * Math.PI * 2, y: (r() + r() + r() - 1.5) * 6,
        speed: 0.022 * (70 / radius) ** 1.5, size, stretch: new THREE.Vector3(1, 0.6 + r() * 0.4, 0.7 + r() * 0.6),
        rot: new THREE.Euler(r() * 6, r() * 6, r() * 6), spin: new THREE.Vector3((r() - 0.5) * 0.8, (r() - 0.5) * 0.8, (r() - 0.5) * 0.8),
        order: i,
      });
      tint.push(new THREE.Color(colors[Math.floor(r() * colors.length)]).multiplyScalar(0.8 + r() * 0.4));
    }
    const counts = [0, 0, 0, 0, 0, 0];
    for (const k of rocks) k.idx = counts[k.m]++;
    shapes.flat().forEach((geo, m) => {
      const mesh = new THREE.InstancedMesh(geo, rockMat, Math.max(1, counts[m]));
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      belt.add(mesh);
      rockMeshes.push(mesh);
    });
    rocks.forEach((k, i) => rockMeshes[k.m].setColorAt(k.idx, tint[i]));
    for (const m of rockMeshes) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }
  let rockLimit = MAX_ROCKS;
  function placeRocks(dt, motion) {
    const counts = [0, 0, 0, 0, 0, 0];
    for (const k of rocks) {
      if (k.order >= rockLimit) continue;
      if (motion) {
        k.a += k.speed * dt;
        k.rot.x += k.spin.x * dt; k.rot.y += k.spin.y * dt; k.rot.z += k.spin.z * dt;
      }
      _v.set(Math.cos(k.a) * k.radius, k.y, Math.sin(k.a) * k.radius);
      _q.setFromEuler(k.rot);
      _m.compose(_v, _q, _s.copy(k.stretch).multiplyScalar(k.size));
      rockMeshes[k.m].setMatrixAt(k.idx, _m);
      counts[k.m] = Math.max(counts[k.m], k.idx + 1);
    }
    rockMeshes.forEach((m, i) => { m.count = counts[i]; m.instanceMatrix.needsUpdate = true; });
  }

  // ---- shooting meteors falling towards the Earth
  const meteors = [];
  {
    for (let i = 0; i < 4; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array([1, 0.85, 0.62, 0, 0, 0]), 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
      line.frustumCulled = false;
      const head = glowSprite(glowTex, '#FFE2B8', 7, 0);
      near.add(line, head);
      meteors.push({ line, head, alive: false, wait: 1 + i * 2.2, p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, max: 1, len: 20 });
    }
  }
  function updateMeteors(dt) {
    for (const m of meteors) {
      if (!m.alive) {
        m.wait -= dt;
        m.head.material.opacity = 0;
        m.line.visible = false;
        if (m.wait > 0) continue;
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
        m.p.set(Math.cos(a) * (200 + Math.random() * 120), 30 + Math.random() * 50, Math.sin(a) * (200 + Math.random() * 120));
        m.v.copy(EARTH_DIR).add(_v.set(Math.random() - 0.5, Math.random() * 0.3, Math.random() - 0.5)).normalize().multiplyScalar(110 + Math.random() * 70);
        m.max = 1.3 + Math.random() * 1.1; m.life = 0; m.len = 18 + Math.random() * 16; m.alive = true;
        m.line.visible = true;
      }
      m.life += dt;
      if (m.life >= m.max) { m.alive = false; m.wait = 2.5 + Math.random() * 6; continue; }
      m.p.addScaledVector(m.v, dt);
      const fade = Math.sin((m.life / m.max) * Math.PI);
      const pos = m.line.geometry.attributes.position;
      pos.setXYZ(0, m.p.x, m.p.y, m.p.z);
      _v.copy(m.v).normalize().multiplyScalar(-m.len).add(m.p);
      pos.setXYZ(1, _v.x, _v.y, _v.z);
      pos.needsUpdate = true;
      m.line.material.opacity = fade;
      m.head.position.copy(m.p);
      m.head.material.opacity = fade;
    }
  }

  // ================================================================ per frame
  const camDir = new THREE.Vector3();
  function update(t, dt, motion, camera) {
    if (motion) {
      earth.rotation.y += dt * 0.004;
      earthMat.uniforms.uCloudOff.value = (earthMat.uniforms.uCloudOff.value + dt * 0.0006) % 1;
      sunRays.material.rotation += dt * 0.01;
      stationOrbit.a += stationOrbit.speed * dt;
      wheel.rotation.z += dt * 0.12;
      for (const s of sats) { s.a += s.speed * dt; s.g.rotation.y += s.spin * dt; }
      updateMeteors(dt);
    }
    starMat.uniforms.uTime.value = t;
    // station: a slow lap round the office, nose along its path, gently rolling
    const so = stationOrbit;
    station.position.set(Math.cos(so.a) * so.r, -14 + Math.sin(so.a * 2) * 6, Math.sin(so.a) * so.r);
    station.rotation.set(0.25 + Math.sin(t * 0.05) * 0.05, -so.a, 0.12);
    for (const s of sats) {
      s.g.position.set(Math.cos(s.a) * s.r, 0, Math.sin(s.a) * s.r).applyQuaternion(s.tilt);
      s.g.position.y += s.y;
    }
    placeRocks(dt, motion);
    for (const b of blinkers) {
      const { rate, phase } = b.userData;
      b.material.opacity = ((t * rate + phase) % 1) < 0.1 ? 1 : 0;
    }
    // glare spills over the rim only while the Sun is clear of the Earth
    camDir.copy(sun.position).sub(camera.position).normalize();
    const sep = Math.acos(THREE.MathUtils.clamp(camDir.dot(_v.copy(earthPos).sub(camera.position).normalize()), -1, 1));
    const clear = THREE.MathUtils.smoothstep(sep, EARTH_ANG - 0.5 * DEG, EARTH_ANG + 3 * DEG);
    glare.position.copy(sun.position);
    glare.material.opacity = 0.35 * clear;
  }

  function render(camera) {
    bgCam.position.copy(camera.position);
    bgCam.quaternion.copy(camera.quaternion);
    if (bgCam.fov !== camera.fov || bgCam.aspect !== camera.aspect) {
      bgCam.fov = camera.fov; bgCam.aspect = camera.aspect; bgCam.updateProjectionMatrix();
    }
    earthMat.uniforms.uCam.value.copy(bgCam.position);
    atmoMat.uniforms.uCam.value.copy(bgCam.position);
    starMat.uniforms.uPx.value = renderer.getPixelRatio();
    renderer.render(bg, bgCam);
  }

  function setQuality(q) {
    rockLimit = q === 'standard' ? 130 : MAX_ROCKS;
  }

  return { render, update, setTime, setQuality, get sunVisible() { return state.sunVis; } };
}
