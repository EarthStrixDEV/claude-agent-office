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

// One shader, four passes: 0 = Earth surface (sRGB albedo + city glow in alpha), 1 = clouds (r),
// ocean mask (g) and the slope of the terrain (b east, a north), 2 = sky (sRGB), 3 = the terrain
// height that pass 1 differentiates (scratch, 16 bits in two channels). Pixel (u, v) maps to the
// same direction as SphereGeometry's uv, so the textures wrap the spheres exactly.
const BAKE = /* glsl */ `
uniform float uPass; uniform sampler2D uRelief;
varying vec2 vUv;
const float PI = 3.141592653589793;
const float LAND = 0.584;
${NOISE}
// Mountain chains run along the mid-level contour of a slow noise, in broken stretches.
// Three octaves and a soft top: see reliefAt.
float crest(vec3 p, vec3 q) {
  float line = 1.0 - smoothstep(0.0, 0.035, abs(fbm(p * 7.0 + q * 0.8 + 3.0, 3) / 0.875 - 0.5));
  return line * smoothstep(0.38, 0.56, fbm(p * 4.0 + 9.0, 2) / 0.75);
}
// Terrain height as the Earth shader lights it: a step up at the coast, rolling hills and the
// mountain chains. It leaves out the finest octaves of the real height on purpose: its slope is
// stored at half size and magnified a lot on screen, so anything near a texel wide shades as blocks.
float reliefAt(vec3 p) {
  vec3 q = vec3(fbm(p * 1.6 + 4.0, 5), fbm(p * 1.6 + 11.3, 5), fbm(p * 1.6 + 23.7, 5));
  float hs = fbm(p * 1.3 + q * 1.4, 4) + 0.027 - LAND;
  return smoothstep(-0.01, 0.03, hs) * (0.15 + 0.14 * fbm(p * 14.0 + 6.0, 2) + clamp(hs, 0.0, 0.2) * 2.5 + smoothstep(0.03, 0.1, hs) * crest(p, q) * 0.1);
}
float reliefTex(vec2 uv) { vec2 t = texture2D(uRelief, uv).rg; return t.r + t.g / 255.0; }
void main() {
  float th = PI * (1.0 - vUv.y), ph = 2.0 * PI * vUv.x;
  vec3 p = vec3(-cos(ph) * sin(th), cos(th), sin(ph) * sin(th));

  if (uPass > 2.5) {
    float h = reliefAt(p) * 254.0;
    gl_FragColor = vec4(floor(h) / 255.0, fract(h), 0.0, 1.0);
    return;
  }
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
    // slope of the terrain per radian, east and north: central differences one texel either way
    vec2 tx = vec2(dFdx(vUv.x), dFdy(vUv.y));
    vec2 slope = vec2((reliefTex(vUv + vec2(tx.x, 0.0)) - reliefTex(vUv - vec2(tx.x, 0.0))) / (4.0 * PI * tx.x * max(sin(th), 0.06)),
                      (reliefTex(vUv + vec2(0.0, tx.y)) - reliefTex(vUv - vec2(0.0, tx.y))) / (2.0 * PI * tx.y));
    gl_FragColor = vec4(clamp(cloud, 0.0, 1.0), 1.0 - land, clamp(slope / 24.0, -1.0, 1.0) * 0.5 + 128.0 / 255.0);
    return;
  }

  // the same crests as reliefAt, so the bare rock sits where the shading puts the mountains
  float peaks = smoothstep(LAND + 0.03, LAND + 0.1, hgt) * crest(p, q);
  float alt = hgt - LAND + peaks * 0.05;
  float shelf = smoothstep(LAND - 0.06, LAND, hgt);
  // open water: currents drift between navy and teal, the tropics are a shade lighter
  float cur = fbm(p * 3.0 + q * 2.0 + 5.0, 3);
  vec3 deep = mix(vec3(0.004, 0.012, 0.062), vec3(0.003, 0.03, 0.075), smoothstep(0.34, 0.56, cur));
  deep *= 0.72 + 0.65 * smoothstep(0.28, 0.6, fbm(p * 6.0 + q * 3.0, 3));
  deep = mix(deep, vec3(0.008, 0.04, 0.1), (1.0 - smoothstep(0.1, 0.6, lat)) * 0.4);
  vec3 ocean = mix(deep, vec3(0.012, 0.07, 0.17), shelf);
  ocean = mix(ocean, vec3(0.03, 0.2, 0.27), shelf * shelf * shelf * 0.78);
  float dry = fbm(p * 4.0 + 11.0, 5);
  float belt = 1.0 - smoothstep(0.0, 0.17, abs(lat - 0.33));
  float desert = smoothstep(0.47, 0.6, dry * 0.75 + belt * 0.42 - (hgt - LAND) * 0.6);
  vec3 green = mix(vec3(0.035, 0.12, 0.04), vec3(0.16, 0.22, 0.08), smoothstep(0.35, 0.65, dry));
  vec3 lc = mix(green, vec3(0.5, 0.37, 0.22), desert);
  lc = mix(lc, vec3(0.26, 0.23, 0.2), smoothstep(0.06, 0.12, alt));
  lc = mix(lc, vec3(0.13, 0.15, 0.1), smoothstep(0.58, 0.78, lat) * (1.0 - desert));
  float grain = fbm(p * 30.0, 4);
  lc *= 0.8 + 0.4 * grain;
  lc = mix(lc, vec3(0.42, 0.4, 0.39), peaks * 0.4 * (0.4 + 1.2 * grain)); // pale, broken rock along the crests
  vec3 col = mix(ocean, lc, land);
  float ice = smoothstep(0.89, 0.94, lat + (fbm(p * 6.0, 4) - 0.5) * 0.12);
  col = mix(col, vec3(0.82, 0.88, 0.94), ice);

  float coast = 1.0 - smoothstep(LAND, LAND + 0.05, hgt);
  float region = smoothstep(0.52, 0.7, fbm(p * 6.0 + 2.0, 4) + coast * 0.12) * (1.0 - smoothstep(0.62, 0.8, lat)) * (1.0 - desert * 0.75);
  float dots = smoothstep(0.6, 0.82, noise(p * 150.0)) + 0.7 * smoothstep(0.68, 0.9, noise(p * 330.0));
  // roads: thin threads of light between the towns
  float roads = (1.0 - smoothstep(0.0, 0.035, abs(fbm(p * 40.0 + 8.0, 2) / 0.75 - 0.5))) * 0.5;
  float city = land * (1.0 - ice) * region * (0.12 + dots + roads);
  gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), clamp(city, 0.0, 1.0));
}`;

function bake(renderer, size) {
  const mk = (w, h) => new THREE.WebGLRenderTarget(w, h, {
    generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false, anisotropy: 8,
  });
  const targets = [mk(size, size / 2), mk(size / 2, size / 4), mk(2048, 1024)];
  // scratch: terrain height at the cloud map's size, read back texel for texel by pass 1
  const relief = new THREE.WebGLRenderTarget(size / 2, size / 4, {
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, wrapS: THREE.RepeatWrapping, depthBuffer: false,
  });
  const mat = new THREE.ShaderMaterial({
    uniforms: { uPass: { value: 0 }, uRelief: { value: null } }, depthTest: false, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: BAKE,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const sc = new THREE.Scene();
  sc.add(quad);
  const cam = new THREE.Camera();
  const prev = renderer.getRenderTarget();
  mat.uniforms.uPass.value = 3; renderer.setRenderTarget(relief); renderer.render(sc, cam);
  mat.uniforms.uRelief.value = relief.texture;
  targets.forEach((rt, i) => { mat.uniforms.uPass.value = i; renderer.setRenderTarget(rt); renderer.render(sc, cam); });
  renderer.setRenderTarget(prev);
  quad.geometry.dispose(); mat.dispose(); relief.dispose();
  return { surface: targets[0].texture, clouds: targets[1].texture, sky: targets[2].texture };
}

const EARTH_VS = /* glsl */ `
varying vec2 vUv; varying vec3 vN; varying vec3 vW; varying vec3 vT; varying vec3 vP;
void main() {
  vUv = uv;
  vP = normalize(position);
  vN = normalize(mat3(modelMatrix) * normal);
  vT = mat3(modelMatrix) * vec3(position.z, 0.0, -position.x); // east: the way u grows on SphereGeometry
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

// The baked maps are only magnified on screen, so everything that should stay sharp up close is
// done here: terrain relief from the baked slope, cloud shadows cast away from the Sun, and city
// lights broken into pin-points finer than a texel.
const EARTH_FS = /* glsl */ `
uniform sampler2D uSurf; uniform sampler2D uCloud;
uniform vec3 uL; uniform vec3 uCam; uniform float uCloudOff; uniform float uCity;
varying vec2 vUv; varying vec3 vN; varying vec3 vW; varying vec3 vT; varying vec3 vP;
float hash2(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
#ifdef DETAIL
${NOISE}
// two scales, the finer one turned off the axes of the first so that no lattice shows
const mat3 TURN = mat3(0.36, 0.48, -0.8, -0.8, 0.6, 0.0, 0.48, 0.64, 0.6);
float terrain(vec3 p) { return noise(p) * 0.5 + noise(TURN * p * 2.3 + 4.1) * 0.5; }
#endif
void main() {
  vec4 s = texture2D(uSurf, vUv);
  vec3 alb = pow(s.rgb, vec3(2.2));
  vec4 geo = texture2D(uCloud, vUv);              // g: ocean, ba: terrain slope
  vec2 cuv = vUv + vec2(uCloudOff, 0.0);
  float cl = texture2D(uCloud, cuv).r;
  float ocean = geo.g;
  vec3 n = normalize(vN), V = normalize(uCam - vW);
  vec3 T = normalize(vT - n * dot(vT, n)), B = cross(n, T);
  float ndl = dot(n, uL);
  float day = smoothstep(-0.08, 0.22, ndl);

  // relief: tilt the normal down the baked slope, so ranges and coasts shade towards the terminator
  vec2 slope = (geo.ba - 128.0 / 255.0) * 2.0;
#ifdef DETAIL
  // Ultra: grain the land per pixel, in the Earth's own space so it turns with the continents
  // (rougher in some regions than others, or it reads as one even coat of sandpaper)
  vec3 To = normalize(vec3(vP.z, 0.0, -vP.x)), Bo = cross(vP, To), dp = vP * 115.0;
  float d0 = terrain(dp), landK = (1.0 - ocean) * (0.25 + 0.75 * smoothstep(0.3, 0.7, noise(vP * 19.0 + 2.0)));
  slope += vec2(terrain(dp + To * 0.3) - d0, terrain(dp + Bo * 0.3) - d0) * 0.75 * landK;
  alb *= 1.0 + (d0 - 0.5) * 0.24 * landK;
#endif
  vec3 nr = normalize(n - (T * slope.x + B * slope.y) * 0.7);
  float lit = max(mix(dot(nr, uL), ndl, 0.35), 0.0);

  // cloud shadows: look for cloud a little way towards the Sun, further when it is low
  vec2 lt = vec2(dot(uL, T), dot(uL, B));
  vec2 toSun = lt * vec2(0.5 / max(length(vP.xz), 0.08), 1.0) * (0.0016 / max(ndl, 0.16));
  float shade = texture2D(uCloud, cuv + toSun).r;

  vec3 col = alb * (lit * 1.9 + 0.01) * (1.0 - 0.6 * shade * day);
  vec3 H = normalize(uL + V);
  float ndh = max(dot(n, H), 0.0);
  col += ocean * (1.0 - cl) * (1.0 - shade) * (pow(ndh, 160.0) * 0.5 + pow(ndh, 22.0) * 0.035) * day * vec3(1.0, 0.88, 0.72);
  // clouds: thicker towards the Sun means this bit is in shade
  float cloudLit = max(ndl, 0.0) * (1.0 - 0.32 * clamp((shade - cl) * 2.0 + 0.15, 0.0, 1.0));
  col = mix(col, vec3(0.92, 0.94, 0.97) * (cloudLit * 0.98 + 0.006), cl * 0.88);

  // city lights: the bake gives the glow of a region, the grid turns it into separate lamps
  // (fewer cells per row towards the poles, so that they stay square on the ground)
  float row = floor(vUv.y * 1200.0);
  vec2 cg = vec2(vUv.x * max(6.0, floor(2400.0 * sin(3.14159265 * (row + 0.5) / 1200.0))), vUv.y * 1200.0);
  vec2 ci = vec2(floor(cg.x), row);
  float rnd = hash2(ci);
  vec2 cf = fract(cg) - 0.5 - (vec2(hash2(ci + 3.1), hash2(ci + 7.3)) - 0.5) * 0.56; // off the lattice, still inside the cell
  float pin = smoothstep(0.22, 0.04, length(cf)) * smoothstep(0.3, 0.75, rnd);
  float cityL = s.a * 0.7 + smoothstep(0.03, 0.4, s.a) * pin * 3.6;
  col += cityL * (1.0 - day) * (1.0 - cl * 0.8) * mix(vec3(1.0, 0.56, 0.24), vec3(1.0, 0.82, 0.55), pin) * 1.3 * uCity;

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
  if (quality === 'ultra') earthMat.defines.DETAIL = 1; // per-pixel terrain grain: seven noise taps
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
  // PBR sets (see textures.js): plated hull, crinkled foil, glassy cells, tubular truss, cratered rock
  const SET = { hull: TX.hullSet(), foil: TX.foilSet(), solar: TX.solarSet(), truss: TX.trussSet(), rock: TX.asteroidSet() };
  const bump = (v) => new THREE.Vector2(v, v);
  const M = {
    white: new THREE.MeshStandardMaterial({ ...SET.hull, roughness: 1, metalness: 0.15, normalScale: bump(0.8) }),
    metal: new THREE.MeshStandardMaterial({ color: '#9AA1AD', roughnessMap: SET.hull.roughnessMap, roughness: 0.62, metalness: 0.85 }),
    dark: new THREE.MeshStandardMaterial({ color: '#2A2F3B', roughness: 0.5, metalness: 0.5 }),
    foil: new THREE.MeshStandardMaterial({ ...SET.foil, roughness: 1, metalness: 1, normalScale: bump(0.75) }),
    solar: new THREE.MeshStandardMaterial({ ...SET.solar, roughness: 1, metalness: 1, normalScale: bump(0.6), side: THREE.DoubleSide, emissive: '#0B1A3C', emissiveIntensity: 0.4 }),
    truss: new THREE.MeshStandardMaterial({ ...SET.truss, roughness: 0.4, metalness: 0.7, normalScale: bump(1), alphaTest: 0.5, side: THREE.DoubleSide }),
    window: new THREE.MeshStandardMaterial({ color: '#2B2410', emissive: '#FFD9A0', emissiveIntensity: 1 }),
    rock: new THREE.MeshStandardMaterial({ ...SET.rock, color: '#ffffff', roughness: 0.95, metalness: 0.05, normalScale: bump(1.2), flatShading: true }),
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
  const cyl = (r, len, mat, axis = 'y', seg = 24) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat);
    if (axis === 'z') m.rotation.x = Math.PI / 2;
    if (axis === 'x') m.rotation.z = Math.PI / 2;
    return m;
  };

  // ---- space station: a long truss, eight solar wings, radiators and a string of modules
  const station = new THREE.Group();
  {
    const g = station;
    const truss = new THREE.Mesh(new THREE.BoxGeometry(36, 1.1, 1.1), M.truss);
    g.add(truss);
    const wing = new THREE.BoxGeometry(2.5, 0.05, 10.5);
    for (const x of [-17.4, -14.1, 14.1, 17.4]) {
      const mast = cyl(0.09, 23, M.metal, 'z', 6);
      mast.position.x = x;
      g.add(mast);
      for (const s of [-1, 1]) {
        const w = new THREE.Mesh(wing, M.solar);
        w.position.set(x, 0, s * 6.2);
        g.add(w);
      }
      const box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.3, 1.6), M.foil);
      box.position.x = x;
      g.add(box);
    }
    for (const x of [-11.2, 11.2]) { const j = cyl(0.75, 1.4, M.metal, 'x'); j.position.x = x; g.add(j); }
    for (const x of [-6.4, 6.4]) {
      for (let i = 0; i < 3; i++) {
        const rad = new THREE.Mesh(new THREE.BoxGeometry(0.06, 5.2, 1.7), M.white);
        rad.position.set(x + (i - 1) * 0.5, -3.3, (i - 1) * 1.9);
        g.add(rad);
      }
    }
    const mods = [[-9.6, 4.6, 0.95, M.white], [-3.7, 4.8, 1, M.white], [2.4, 5, 1, M.white], [7.2, 4, 0.9, M.foil], [10.4, 2.2, 0.62, M.dark]];
    for (const [z, len, r, mat] of mods) {
      const m = cyl(r, len, mat, 'z');
      m.position.set(0, -1.6, z);
      g.add(m);
      for (const e of [-1, 1]) { const ring = cyl(r + 0.05, 0.18, M.metal, 'z'); ring.position.set(0, -1.6, z + e * (len / 2 - 0.15)); g.add(ring); }
    }
    for (const z of [-6.6, -0.6]) {
      const node = new THREE.Mesh(new THREE.SphereGeometry(1.15, 24, 16), M.white);
      node.position.set(0, -1.6, z);
      g.add(node);
    }
    for (const s of [-1, 1]) {
      const m = cyl(0.9, 3.6, s < 0 ? M.white : M.foil, 'x');
      m.position.set(s * 2.9, -1.6, -0.6);
      g.add(m);
    }
    const cupola = cyl(0.55, 0.5, M.metal, 'y', 8);
    cupola.position.set(0, -2.9, -6.6);
    g.add(cupola);
    for (const s of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.03, 0.7), M.solar);
      w.position.set(s * 1.9, -1.6, 10.6);
      g.add(w);
    }
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
    wheel.add(new THREE.Mesh(new THREE.TorusGeometry(22, 2.4, 20, 128), M.white));
    for (const r of [19.75, 24.25]) {
      const strip = new THREE.Mesh(new THREE.TorusGeometry(r, 0.32, 6, 128), M.window);
      wheel.add(strip);
    }
    for (let i = 0; i < 4; i++) {
      const sp = cyl(0.55, 20, M.metal, 'y', 10);
      sp.rotation.z = (i / 4) * Math.PI * 2;
      sp.position.set(-Math.sin(sp.rotation.z) * 10.5, Math.cos(sp.rotation.z) * 10.5, 0);
      wheel.add(sp);
    }
    for (let i = 0; i < 12; i++) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 6.4), M.white);
      const a = (i / 12) * Math.PI * 2 + 0.26;
      pod.position.set(Math.cos(a) * 22, Math.sin(a) * 22, 0);
      pod.rotation.z = a;
      wheel.add(pod);
    }
    ring.add(wheel);
    const hub = cyl(3, 7, M.white, 'z');
    ring.add(hub);
    const mast = cyl(0.4, 30, M.metal, 'z', 8);
    ring.add(mast);
    for (const z of [-11, 11]) {
      for (const s of [-1, 1]) {
        const w = new THREE.Mesh(new THREE.BoxGeometry(14, 0.06, 4.2), M.solar);
        w.position.set(s * 8.5, 0, z);
        ring.add(w);
      }
    }
    const dish = new THREE.Mesh(new THREE.SphereGeometry(3, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.32), M.white);
    dish.position.z = 16.5;
    dish.rotation.x = Math.PI / 2;
    ring.add(dish);
    blink(ring, 0, 0, 18, '#FF4D5E', 5, 0.6, 0.1);
    ring.position.set(250, -150, -470);
    ring.rotation.set(0.85, -0.5, 0.25);
    near.add(ring);
  }

  // ---- satellites on tilted orbits around the office
  const sats = [];
  {
    const r = TX.rng(404);
    const make = (kind) => {
      const g = new THREE.Group();
      if (kind === 0) {           // comms satellite: gold box, two long wings, a dish
        g.add(new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.8), M.foil));
        for (const s of [-1, 1]) {
          const w = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.04, 1.3), M.solar);
          w.position.x = s * 3.2;
          g.add(w);
          const arm = cyl(0.05, 0.8, M.metal, 'x', 6); arm.position.x = s * 0.9; g.add(arm);
        }
        const dish = new THREE.Mesh(new THREE.SphereGeometry(0.9, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.35), M.white);
        dish.position.set(0, 0, 1.6); dish.rotation.x = -Math.PI / 2;
        g.add(dish);
      } else if (kind === 1) {    // observatory: a white tube with one big panel
        const tube = cyl(0.7, 3.4, M.white, 'z');
        g.add(tube);
        const cap = cyl(0.72, 0.3, M.dark, 'z'); cap.position.z = 1.8; g.add(cap);
        const w = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.6, 3.6), M.solar);
        w.position.x = 1.0;
        g.add(w);
      } else {                    // cubesat with fold-out panels
        g.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.9), M.metal));
        for (const s of [-1, 1]) {
          const w = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.03, 0.85), M.solar);
          w.position.x = s * 0.78;
          g.add(w);
        }
      }
      return g;
    };
    for (let i = 0; i < 8; i++) {
      const g = make(i % 3);
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
  const rockMat = M.rock;
  const rocks = [];
  const rockMeshes = [];
  const MAX_ROCKS = 270;
  {
    const r = TX.rng(9);
    for (let v = 0; v < 3; v++) {
      const geo = new THREE.IcosahedronGeometry(1, 2);
      const pos = geo.attributes.position;
      const waves = Array.from({ length: 4 }, () => [new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(), 2 + r() * 4, r() * 6, 0.05 + r() * 0.1]);
      const craters = Array.from({ length: 5 }, () => [new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(), 0.88 + r() * 0.08, 0.08 + r() * 0.1]);
      for (let i = 0; i < pos.count; i++) {
        const d = _v.fromBufferAttribute(pos, i).normalize();
        let f = 1;
        for (const [dir, k, ph, amp] of waves) f += amp * Math.sin(d.dot(dir) * k + ph);
        for (const [dir, edge, depth] of craters) { const c = d.dot(dir); if (c > edge) f -= depth * Math.sin(((c - edge) / (1 - edge)) * Math.PI * 0.5); }
        pos.setXYZ(i, d.x * f, d.y * f, d.z * f);
      }
      geo.computeVertexNormals();
      const mesh = new THREE.InstancedMesh(geo, rockMat, MAX_ROCKS);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      belt.add(mesh);
      rockMeshes.push(mesh);
    }
    const counts = [0, 0, 0];
    const colors = ['#8C8379', '#6F6A66', '#9A8A78', '#7A7068', '#857B8A'];
    for (let i = 0; i < MAX_ROCKS; i++) {
      const v = i % 3, idx = counts[v]++;
      const radius = 62 + (r() ** 0.8) * 75;
      const giant = i < 4;
      const size = giant ? 2.6 + r() * 2 : 0.25 + (r() ** 4) * 2.2;
      rocks.push({
        mesh: rockMeshes[v], v, idx, radius, a: r() * Math.PI * 2, y: (r() + r() + r() - 1.5) * 6,
        speed: 0.022 * (70 / radius) ** 1.5, size, stretch: new THREE.Vector3(1, 0.6 + r() * 0.4, 0.7 + r() * 0.6),
        rot: new THREE.Euler(r() * 6, r() * 6, r() * 6), spin: new THREE.Vector3((r() - 0.5) * 0.8, (r() - 0.5) * 0.8, (r() - 0.5) * 0.8),
        order: i,
      });
      rockMeshes[v].setColorAt(idx, new THREE.Color(colors[Math.floor(r() * colors.length)]).multiplyScalar(0.8 + r() * 0.4));
    }
    for (const m of rockMeshes) m.instanceColor.needsUpdate = true;
  }
  let rockLimit = MAX_ROCKS;
  function placeRocks(dt, motion) {
    const counts = [0, 0, 0];
    for (const k of rocks) {
      if (k.order >= rockLimit) continue;
      if (motion) {
        k.a += k.speed * dt;
        k.rot.x += k.spin.x * dt; k.rot.y += k.spin.y * dt; k.rot.z += k.spin.z * dt;
      }
      _v.set(Math.cos(k.a) * k.radius, k.y, Math.sin(k.a) * k.radius);
      _q.setFromEuler(k.rot);
      _m.compose(_v, _q, _s.copy(k.stretch).multiplyScalar(k.size));
      k.mesh.setMatrixAt(k.idx, _m);
      counts[k.v] = Math.max(counts[k.v], k.idx + 1);
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

  // ---- texturing: tilings that depend on a mesh's UV layout. Kept apart from the builders above
  // so that geometry edits there do not collide with it; a mesh that no longer matches keeps M.white.
  {
    // a torus has one UV square over its whole length: 138 units round the wheel, 15 round the tube
    const wheelHull = M.white.clone();
    Object.assign(wheelHull, TX.retile(SET.hull, 40, 4));
    wheel.traverse((o) => { if (o.isMesh && o.material === M.white && o.geometry.type === 'TorusGeometry') o.material = wheelHull; });
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

  // Draws into whatever target is bound. prepare(scene) lets the frame pipeline (render.js)
  // look at the background scene's materials before they are first compiled.
  function render(camera, prepare = null) {
    bgCam.position.copy(camera.position);
    bgCam.quaternion.copy(camera.quaternion);
    if (bgCam.fov !== camera.fov || bgCam.aspect !== camera.aspect) {
      bgCam.fov = camera.fov; bgCam.aspect = camera.aspect; bgCam.updateProjectionMatrix();
    }
    earthMat.uniforms.uCam.value.copy(bgCam.position);
    atmoMat.uniforms.uCam.value.copy(bgCam.position);
    starMat.uniforms.uPx.value = renderer.getPixelRatio();
    if (prepare) prepare(bg);
    renderer.render(bg, bgCam);
  }

  function setQuality(q) {
    rockLimit = q === 'standard' ? 130 : MAX_ROCKS;
  }

  return { render, update, setTime, setQuality, get sunVisible() { return state.sunVis; } };
}
