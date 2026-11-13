// The frame pipeline: the office is drawn into a floating-point (HDR) target, post-processed and
// tone-mapped once at the end, instead of every material tone-mapping itself straight to the canvas.
//
//   1. space (sky, Earth, Sun)  -> background target, its own far camera, no MSAA
//   2. office scene             -> scene target, MSAA, HDR, depth texture; space is its background
//   3. bloom                    -> thresholded 1/2-res pyramid, blurred down and back up
//   4. ambient occlusion        -> ultra only, half res, from the depth texture alone
//   5. output                   -> AO x scene + bloom, ACES, grade, vignette, sRGB, straight to the canvas;
//                                  it also copies depth so that
//   6. the UI layer (labels, alert badges, progress rings, halos) draws last, depth-tested but
//      never tone-mapped, bloomed or occluded.
//
// Two draws into one multisampled target are avoided on purpose: three resolves and then
// invalidates the MSAA buffer after every render() call, so on tile-based GPUs the second draw
// would start from garbage. Space therefore goes to its own target and comes back as a background.
//
// Things authored for the screen (toneMapped: false materials, the sky and star shaders) are
// "display-referred": they must come out of the final ACES pass looking the way they were drawn.
// They are written into the HDR buffer through the inverse of the tone curve, which also makes the
// bright ones (the Sun, lit screens, the hologram) genuinely brighter than the sunlit floor, so a
// plain luminance threshold is enough to pick what blooms.
import * as THREE from 'three';

const UI_LAYER = 1;

// ------------------------------------------------- display-referred -> scene-referred
// Inverse of three's ACESFilmicToneMapping. DISPLAY_MAX caps how bright "white" becomes in the
// HDR buffer (0.95 -> about 3.9): higher blooms harder and aliases more at MSAA edges.
const DISPLAY_MAX = '0.95';
const mat3 = (a) => `mat3( ${new THREE.Matrix3().fromArray(a).invert().elements.map((v) => v.toFixed(7)).join(', ')} )`;
const INV_ACES_IN = mat3([0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777]);
const INV_ACES_OUT = mat3([1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602]);
const DISPLAY_TO_SCENE = /* glsl */ `
uniform float toneMappingExposure;
vec3 officeDisplayToScene( vec3 c ) {
	vec3 y = clamp( ${INV_ACES_OUT} * c, 0.0, ${DISPLAY_MAX} );
	vec3 a = 1.0 - 0.983729 * y, b = 0.0245786 - 0.4329510 * y, k = - 0.000090537 - 0.238081 * y;
	vec3 v = ( - b + sqrt( max( b * b - 4.0 * a * k, 0.0 ) ) ) / ( 2.0 * a );
	// The curve crosses zero at 0.003253, not at 0. Take that off for inputs that really are zero
	// (below one 8-bit step), so alpha 0 adds nothing; anything visible keeps the exact inverse.
	v -= 0.003253 * exp( - y / 0.0005 );
	return max( ${INV_ACES_IN} * v, 0.0 ) * ( 0.6 / toneMappingExposure );
}`;
// Premultiplied, because what reaches the buffer after blending is what has to be inverted. Alpha
// counts as pow( a, 2.2 ): these sprites used to blend in the canvas's sRGB-encoded space, where a
// linear alpha ramp reads as a soft falloff. Blended linearly it would be a flat disc with an edge.
const APPLY = (rgb) => `gl_FragColor.rgb = officeDisplayToScene( ${rgb} * pow( gl_FragColor.a, 2.2 ) ) / max( gl_FragColor.a, 0.001 );`;

// Built-in materials opt in with the HDR_EMISSIVE define; nothing changes for the others.
THREE.ShaderChunk.common += `\n#ifdef HDR_EMISSIVE\n${DISPLAY_TO_SCENE}\n#endif\n`;
THREE.ShaderChunk.tonemapping_fragment = /* glsl */ `
#if defined( TONE_MAPPING )
	gl_FragColor.rgb = toneMapping( gl_FragColor.rgb );
#elif defined( HDR_EMISSIVE )
	${APPLY('gl_FragColor.rgb')}
#endif
`;

function makeDisplayReferred(mat) {
  if (mat.isShaderMaterial) {
    // custom shaders: the ones without a tone-mapping include were drawn for the screen as they are
    const src = mat.fragmentShader;
    if (src.includes('tonemapping_fragment')) return;
    // no colour-space include either: the values are already display-encoded (the stars)
    const rgb = src.includes('colorspace_fragment') ? 'gl_FragColor.rgb' : 'pow( clamp( gl_FragColor.rgb, 0.0, 1.0 ), vec3( 2.2 ) )';
    const end = src.lastIndexOf('}');
    mat.fragmentShader = `${DISPLAY_TO_SCENE}\n${src.slice(0, end)}\n\t${APPLY(rgb)}\n}${src.slice(end + 1)}`;
  } else {
    if (mat.toneMapped !== false) return;
    mat.defines = { ...mat.defines, HDR_EMISSIVE: '' };
  }
  mat.needsUpdate = true;
}

// ------------------------------------------------------------- full-screen passes
const FS_VS = /* glsl */ 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }';
const pass = (fragmentShader, uniforms, extra = {}) => new THREE.ShaderMaterial({
  vertexShader: FS_VS, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false, ...extra,
});

// Bloom after Jimenez (SIGGRAPH 2014): 13-tap downsample, 3x3 tent upsample.
const DOWN_FS = /* glsl */ `
uniform sampler2D tMap; uniform vec2 uTexel; uniform vec3 uThreshold; // threshold, knee, exposure (0 = no prefilter)
varying vec2 vUv;
vec3 tap( vec2 o ) {
	vec3 c = texture2D( tMap, vUv + o * uTexel ).rgb;
	#ifdef PREFILTER
		if ( any( isnan( c ) ) ) c = vec3( 0.0 );
		c = min( c * uThreshold.z, 24.0 );
		// soft knee on the brightest channel, so saturated lights bloom too
		float br = max( c.r, max( c.g, c.b ) );
		float soft = clamp( br - uThreshold.x + uThreshold.y, 0.0, 2.0 * uThreshold.y );
		soft = soft * soft / ( 4.0 * uThreshold.y + 1e-4 );
		c *= max( soft, br - uThreshold.x ) / max( br, 1e-4 );
	#endif
	return c;
}
#ifdef PREFILTER
	// Karis average: weigh each 2x2 block by 1 / (1 + luma) so one very bright pixel cannot flicker
	vec3 box( vec3 a, vec3 b, vec3 c, vec3 d ) {
		vec4 w = 1.0 / ( 1.0 + vec4( dot( a, vec3( 0.3 ) ), dot( b, vec3( 0.3 ) ), dot( c, vec3( 0.3 ) ), dot( d, vec3( 0.3 ) ) ) );
		return ( a * w.x + b * w.y + c * w.z + d * w.w ) / ( w.x + w.y + w.z + w.w );
	}
#else
	vec3 box( vec3 a, vec3 b, vec3 c, vec3 d ) { return ( a + b + c + d ) * 0.25; }
#endif
void main() {
	vec3 a = tap( vec2( - 2.0, 2.0 ) ), b = tap( vec2( 0.0, 2.0 ) ), c = tap( vec2( 2.0, 2.0 ) );
	vec3 d = tap( vec2( - 2.0, 0.0 ) ), e = tap( vec2( 0.0 ) ), f = tap( vec2( 2.0, 0.0 ) );
	vec3 g = tap( vec2( - 2.0, - 2.0 ) ), h = tap( vec2( 0.0, - 2.0 ) ), i = tap( vec2( 2.0, - 2.0 ) );
	vec3 j = tap( vec2( - 1.0, 1.0 ) ), k = tap( vec2( 1.0, 1.0 ) ), l = tap( vec2( - 1.0, - 1.0 ) ), m = tap( vec2( 1.0, - 1.0 ) );
	vec3 col = box( j, k, l, m ) * 0.5 + ( box( a, b, d, e ) + box( b, c, e, f ) + box( d, e, g, h ) + box( e, f, h, i ) ) * 0.125;
	gl_FragColor = vec4( col, 1.0 );
}`;
const UP_FS = /* glsl */ `
uniform sampler2D tMap; uniform vec2 uTexel; uniform float uMix;
varying vec2 vUv;
void main() {
	vec4 o = uTexel.xyxy * vec4( 1.0, 1.0, - 1.0, 0.0 );
	vec3 c = texture2D( tMap, vUv ).rgb * 4.0;
	c += ( texture2D( tMap, vUv - o.xw ).rgb + texture2D( tMap, vUv + o.xw ).rgb + texture2D( tMap, vUv - o.wy ).rgb + texture2D( tMap, vUv + o.wy ).rgb ) * 2.0;
	c += texture2D( tMap, vUv - o.xy ).rgb + texture2D( tMap, vUv + o.xy ).rgb + texture2D( tMap, vUv - o.zy ).rgb + texture2D( tMap, vUv + o.zy ).rgb;
	gl_FragColor = vec4( c / 16.0, uMix ); // blended over the level below: lerp( level, wider blur, uMix )
}`;

const DEPTH_GLSL = /* glsl */ `
uniform sampler2D tDepth; uniform vec4 uProj; // near, far, 1 / P[0][0], 1 / P[1][1]
float viewZ( float d ) { return uProj.x * uProj.y / ( ( uProj.y - uProj.x ) * d - uProj.y ); }
vec3 viewPos( vec2 uv ) { float z = viewZ( texture2D( tDepth, uv ).x ); return vec3( ( uv * 2.0 - 1.0 ) * uProj.zw * - z, z ); }`;

// Ambient obscurance after McGuire's SAO: view-space positions and normals are rebuilt from depth,
// so nothing is drawn twice and sprites (no depth write) cannot leave ghosts.
const AO_FS = /* glsl */ `
#define TAPS 12
uniform vec2 uTexel; uniform vec4 uAo; // radius (m), projection scale (px per m at 1 m), fade start, fade end
varying vec2 vUv;
${DEPTH_GLSL}
void main() {
	float d = texture2D( tDepth, vUv ).x;
	vec3 p = viewPos( vUv );
	float fade = 1.0 - smoothstep( uAo.z, uAo.w, - p.z );
	if ( d >= 0.99999 || fade <= 0.0 ) { gl_FragColor = vec4( 1.0 ); return; } // space, or too far for the depth precision
	vec3 pl = viewPos( vUv - vec2( uTexel.x, 0.0 ) ), pr = viewPos( vUv + vec2( uTexel.x, 0.0 ) );
	vec3 pd = viewPos( vUv - vec2( 0.0, uTexel.y ) ), pu = viewPos( vUv + vec2( 0.0, uTexel.y ) );
	// the nearer neighbour on each axis, so normals stay clean across silhouettes
	vec3 dx = abs( pl.z - p.z ) < abs( pr.z - p.z ) ? p - pl : pr - p;
	vec3 dy = abs( pd.z - p.z ) < abs( pu.z - p.z ) ? p - pd : pu - p;
	vec3 n = normalize( cross( dx, dy ) );
	float rPx = min( uAo.x * uAo.y / - p.z, 40.0 ); // capped: a few taps cannot cover a huge disc in close-ups
	if ( rPx < 1.5 ) { gl_FragColor = vec4( 1.0 ); return; }
	float noise = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
	float r2 = uAo.x * uAo.x, sum = 0.0;
	for ( int i = 0; i < TAPS; i ++ ) {
		float t = ( float( i ) + 0.5 ) / float( TAPS ), ang = ( noise + t * 3.0 ) * 6.2831853;
		vec3 v = viewPos( vUv + vec2( cos( ang ), sin( ang ) ) * ( sqrt( t ) * rPx ) * uTexel ) - p;
		float vv = dot( v, v ), vn = dot( v, n ), f = max( r2 - vv, 0.0 );
		sum += f * f * f * max( ( vn - 0.02 - 0.0012 * - p.z ) / ( vv + 0.01 ), 0.0 );
	}
	float ao = max( 0.0, 1.0 - sum * 5.0 / ( r2 * r2 * r2 * float( TAPS ) ) );
	gl_FragColor = vec4( mix( 1.0, ao, fade ), 0.0, 0.0, 1.0 );
}`;
// separable blur that does not cross depth edges
const AO_BLUR_FS = /* glsl */ `
uniform sampler2D tMap; uniform vec2 uDir;
varying vec2 vUv;
${DEPTH_GLSL}
void main() {
	float z = viewZ( texture2D( tDepth, vUv ).x ), sum = texture2D( tMap, vUv ).r * 0.2, w = 0.2;
	for ( int i = - 3; i <= 3; i ++ ) {
		if ( i == 0 ) continue;
		vec2 uv = vUv + uDir * ( float( i ) * 1.5 ); // between texels: each tap is already a pair
		float k = ( 0.2 - 0.04 * abs( float( i ) ) ) * max( 0.0, 1.0 - abs( viewZ( texture2D( tDepth, uv ).x ) - z ) / ( 0.06 * - z + 0.1 ) );
		sum += texture2D( tMap, uv ).r * k; w += k;
	}
	gl_FragColor = vec4( sum / w, 0.0, 0.0, 1.0 );
}`;

const OUTPUT_FS = /* glsl */ `
#include <tonemapping_pars_fragment>
uniform sampler2D tScene; uniform sampler2D tBloom; uniform sampler2D tDepth; uniform sampler2D tAo;
uniform vec4 uLook;  // bloom strength, AO strength, saturation, contrast (0 = none)
uniform vec3 uVignette; // strength, aspect, unused
varying vec2 vUv;
void main() {
	vec3 c = texture2D( tScene, vUv ).rgb;
	if ( any( isnan( c ) ) ) c = vec3( 0.0 );
	#ifdef USE_AO
		// contact shadow only: lights and anything brighter than white keep their glow
		float ao = mix( 1.0, texture2D( tAo, vUv ).r, uLook.y );
		c *= mix( ao, 1.0, smoothstep( 1.0, 2.5, max( c.r, max( c.g, c.b ) ) ) );
	#endif
	c += texture2D( tBloom, vUv ).rgb * uLook.x;
	c = ACESFilmicToneMapping( c );
	float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
	c = max( mix( vec3( l ), c, uLook.z ), 0.0 );
	vec2 q = ( vUv - 0.5 ) * vec2( uVignette.y, 1.0 );
	c *= 1.0 - uVignette.x * smoothstep( 0.6, 1.9, dot( q, q ) * 2.0 ); // corners, hardly the edges
	c = sRGBTransferOETF( vec4( c, 1.0 ) ).rgb;
	c = mix( c, c * c * ( 3.0 - 2.0 * c ), uLook.w ); // contrast: a slight S in display space, black and white stay put
	// one grey level of fixed (not animated) dither: the dark sky gradient would band in 8 bits
	c += ( fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) ) - 0.5 ) / 255.0;
	gl_FragColor = vec4( c, 1.0 );
	gl_FragDepth = texture2D( tDepth, vUv ).x; // so the UI layer can depth-test against the scene
}`;

const TIERS = {
  // samples: MSAA of the scene target. bloom: pyramid levels (first is 1/2 res). ao: half-res ambient occlusion.
  ultra: { samples: 4, bloom: 6, ao: true },
  standard: { samples: 4, bloom: 4, ao: false },
};

export function supportsHdr(renderer) {
  const gl = renderer.getContext();
  if (!renderer.capabilities.isWebGL2 && !(typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext)) return false;
  // half-float colour buffers need one of these; without them stay on the direct path
  return renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
}

// isUi(object) says which objects belong to the UI layer; everything else that is display-referred
// is converted so it survives the tone curve.
// stats: also count draw calls and triangles per stage (adds one empty probe mesh to the scene).
export function createPipeline(renderer, { isUi = () => false, stats = false } = {}) {
  const hdr = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
  const size = new THREE.Vector2();
  let tier = TIERS.ultra, tierName = 'ultra', built = '';
  let rtBg = null, rtScene = null, mips = [], rtAo = [];

  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  tri.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  const quad = new THREE.Mesh(tri);
  quad.frustumCulled = false;
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const draw = (material, target) => {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(quad, quadCam);
  };

  const uProj = { value: new THREE.Vector4() }, uDepth = { value: null };
  const mPre = pass(DOWN_FS, { tMap: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: new THREE.Vector3(1.4, 0.5, 1) } }, { defines: { PREFILTER: '' } });
  const mDown = pass(DOWN_FS, { tMap: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: new THREE.Vector3() } });
  const mUp = pass(UP_FS, { tMap: { value: null }, uTexel: { value: new THREE.Vector2() }, uMix: { value: 0.6 } }, { transparent: true, blending: THREE.NormalBlending });
  const mAo = pass(AO_FS, { tDepth: uDepth, uProj, uTexel: { value: new THREE.Vector2() }, uAo: { value: new THREE.Vector4(0.5, 1, 90, 140) } });
  const mAoBlur = pass(AO_BLUR_FS, { tMap: { value: null }, tDepth: uDepth, uProj, uDir: { value: new THREE.Vector2() } });
  const mOut = pass(OUTPUT_FS, {
    tScene: { value: null }, tBloom: { value: null }, tDepth: uDepth, tAo: { value: null },
    uLook: { value: new THREE.Vector4(0.1, 1, 1, 1) }, uVignette: { value: new THREE.Vector3(0.15, 1, 0) },
    toneMappingExposure: { value: 1 },
  }, { depthTest: true, depthWrite: true, depthFunc: THREE.AlwaysDepth });

  function dispose() {
    for (const t of [rtBg, rtScene, ...mips, ...rtAo]) t?.dispose();
    rtScene?.depthTexture?.dispose();
    rtBg = rtScene = null; mips = []; rtAo = [];
    built = '';
  }

  // (Re)build the targets when the drawing buffer or the tier changed. Cheap to call every frame.
  function ensureTargets() {
    renderer.getDrawingBufferSize(size);
    const w = Math.max(2, size.x), h = Math.max(2, size.y);
    const key = `${w}x${h}:${tierName}`;
    if (key === built) return;
    dispose();
    built = key;
    rtBg = new THREE.WebGLRenderTarget(w, h, { ...hdr, depthBuffer: true });
    const depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    depthTexture.minFilter = depthTexture.magFilter = THREE.NearestFilter;
    rtScene = new THREE.WebGLRenderTarget(w, h, { ...hdr, depthBuffer: true, depthTexture, samples: Math.min(tier.samples, renderer.capabilities.maxSamples) });
    let mw = w, mh = h;
    for (let i = 0; i < tier.bloom; i++) {
      mw = Math.max(2, mw >> 1); mh = Math.max(2, mh >> 1);
      mips.push(new THREE.WebGLRenderTarget(mw, mh, { ...hdr, depthBuffer: false }));
      if (mw <= 8 || mh <= 8) break;
    }
    if (tier.ao) {
      const ao = { type: THREE.UnsignedByteType, format: THREE.RedFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false };
      rtAo = [new THREE.WebGLRenderTarget(w >> 1, h >> 1, ao), new THREE.WebGLRenderTarget(w >> 1, h >> 1, ao)];
    }
    uDepth.value = depthTexture;
    if (('USE_AO' in mOut.defines) !== tier.ao) {
      mOut.defines = tier.ao ? { USE_AO: '' } : {};
      mOut.needsUpdate = true;
    }
  }

  // Sort the scene's objects once each: UI to its own layer, display-referred materials converted.
  // Runs every frame because desks, agents and packets come and go; a WeakSet lookup per object.
  const seen = new WeakSet();
  const UI_MASK = 1 << UI_LAYER;
  function adopt(root, ui = null) {
    root.traverse((o) => {
      const m = o.material;
      if (!m || seen.has(m) || o.layers.mask === UI_MASK) return;
      seen.add(m);
      const list = Array.isArray(m) ? m : [m];
      if (ui && ui(o)) { o.layers.set(UI_LAYER); for (const x of list) seen.add(x); return; }
      for (const x of list) if (!seen.has(x) || x === m) { seen.add(x); makeDisplayReferred(x); }
    });
  }

  renderer.autoClear = false; // every pass clears (or deliberately keeps) its own target
  // per-stage counters: the probe is the first thing drawn in the office pass proper, so what was
  // counted before it (inside the same render() call) is the shadow map
  const counts = { space: null, shadow: null, office: null, post: null };
  const snap = () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles });
  const diff = (a, b) => ({ calls: b.calls - a.calls, triangles: b.triangles - a.triangles });
  let probe = null, probed = null;
  if (stats) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    probe = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
    probe.frustumCulled = false;
    probe.renderOrder = -1e9;
    probe.onBeforeRender = () => { probed ??= snap(); };
  }

  const look = { bloom: 0.1, threshold: 1.4, knee: 0.6, spread: 0.6, ao: 1, saturation: 1, contrast: 0, vignette: 0.15 };

  // drawSpace(prepare) must draw the background scene into the bound target, after calling
  // prepare(itsScene) so its materials are converted too.
  function render(scene, camera, drawSpace) {
    ensureTargets();
    const { x: w, y: h } = size;
    const exposure = renderer.toneMappingExposure;

    const c0 = snap();
    renderer.setRenderTarget(rtBg);
    renderer.clear();
    drawSpace(adopt);
    const c1 = snap();
    if (probe && probe.parent !== scene) scene.add(probe);
    probed = null;

    adopt(scene, isUi);
    const background = scene.background;
    scene.background = rtBg.texture;
    camera.layers.set(0);
    renderer.setRenderTarget(rtScene);
    renderer.clear();
    renderer.render(scene, camera);
    scene.background = background;
    const c2 = snap();

    // bloom: threshold into the first level, blur down, then fold each level back into the one above
    mPre.uniforms.tMap.value = rtScene.texture;
    mPre.uniforms.uTexel.value.set(1 / w, 1 / h);
    mPre.uniforms.uThreshold.value.set(look.threshold, look.knee, exposure);
    draw(mPre, mips[0]);
    for (let i = 1; i < mips.length; i++) {
      mDown.uniforms.tMap.value = mips[i - 1].texture;
      mDown.uniforms.uTexel.value.set(1 / mips[i - 1].width, 1 / mips[i - 1].height);
      draw(mDown, mips[i]);
    }
    mUp.uniforms.uMix.value = look.spread;
    for (let i = mips.length - 2; i >= 0; i--) {
      mUp.uniforms.tMap.value = mips[i + 1].texture;
      mUp.uniforms.uTexel.value.set(1 / mips[i + 1].width, 1 / mips[i + 1].height);
      draw(mUp, mips[i]);
    }

    const p = camera.projectionMatrix.elements;
    uProj.value.set(camera.near, camera.far, 1 / p[0], 1 / p[5]);
    if (tier.ao) {
      const aw = rtAo[0].width, ah = rtAo[0].height;
      mAo.uniforms.uTexel.value.set(1 / aw, 1 / ah);
      mAo.uniforms.uAo.value.y = 0.5 * ah * p[5];
      draw(mAo, rtAo[0]);
      mAoBlur.uniforms.tMap.value = rtAo[0].texture; mAoBlur.uniforms.uDir.value.set(1 / aw, 0);
      draw(mAoBlur, rtAo[1]);
      mAoBlur.uniforms.tMap.value = rtAo[1].texture; mAoBlur.uniforms.uDir.value.set(0, 1 / ah);
      draw(mAoBlur, rtAo[0]);
      mOut.uniforms.tAo.value = rtAo[0].texture;
    }

    mOut.uniforms.tScene.value = rtScene.texture;
    mOut.uniforms.tBloom.value = mips[0].texture;
    mOut.uniforms.uLook.value.set(look.bloom, look.ao, look.saturation, look.contrast);
    mOut.uniforms.uVignette.value.set(look.vignette, w / h, 0);
    mOut.uniforms.toneMappingExposure.value = exposure;
    renderer.setRenderTarget(null);
    renderer.clear();
    draw(mOut, null);

    // the UI layer, straight to the canvas over the finished image
    camera.layers.set(UI_LAYER);
    renderer.render(scene, camera);
    camera.layers.set(0);
    if (stats) Object.assign(counts, { space: diff(c0, c1), shadow: diff(c1, probed || c1), office: diff(probed || c1, c2), post: diff(c2, snap()) });
  }

  return {
    render, dispose, look, counts,
    setQuality(q) { tierName = TIERS[q] ? q : 'ultra'; tier = TIERS[tierName]; },
    // for the report and __officeStats: what one frame costs
    describe() {
      return {
        tier: tierName, size: `${size.x}x${size.y}`, msaa: rtScene?.samples || 0,
        bloomLevels: mips.length, ao: tier.ao, fullScreenPasses: mips.length * 2 + (tier.ao ? 3 : 0), // bloom down and up, AO and its blur, output
      };
    },
  };
}

// ------------------------------------------------------------------ sun shadow
// Fit the sun's shadow box to the island (a cylinder: radius, yMin..yMax) instead of a fixed
// square, so every texel lands on something. The light-up extent shrinks when the sun is low,
// which is exactly when shadows stretch, so texels on the ground stay about the same size.
// The extent moves in whole steps and the box centre is snapped to the texel grid, so the map
// does not swim while the sun moves.
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _c = new THREE.Vector3();
export function fitSunShadow(light, dir, { radius, yMin, yMax, mapSize, distance = 80 }) {
  const cosEl = Math.hypot(dir.x, dir.z), sinEl = Math.abs(dir.y), half = (yMax - yMin) / 2;
  const hw = radius;
  const hh = Math.min(radius + half, Math.ceil((radius * sinEl + half * cosEl) / 2) * 2);
  const hd = radius * cosEl + half * sinEl;
  if (cosEl < 1e-4) _x.set(1, 0, 0); else _x.set(dir.z, 0, -dir.x).normalize(); // cross(up, dir)
  _y.crossVectors(dir, _x).normalize();
  _c.set(0, (yMin + yMax) / 2, 0);
  const tx = (2 * hw) / mapSize, ty = (2 * hh) / mapSize;
  const cx = _c.dot(_x), cy = _c.dot(_y);
  _c.addScaledVector(_x, Math.round(cx / tx) * tx - cx).addScaledVector(_y, Math.round(cy / ty) * ty - cy);
  light.target.position.copy(_c);
  light.position.copy(_c).addScaledVector(dir, distance);
  const cam = light.shadow.camera;
  cam.left = -hw; cam.right = hw; cam.top = hh; cam.bottom = -hh;
  cam.near = Math.max(1, distance - hd - 2); cam.far = distance + hd + 2;
  cam.updateProjectionMatrix();
  // texel: metres per shadow texel. floorSlope: how much deeper the floor gets from one texel to the
  // next, seen from the sun. depth: metres between the shadow camera's near and far planes.
  return { texel: Math.max(tx, ty), floorSlope: (ty / Math.max(sinEl, 0.05)) * cosEl, depth: cam.far - cam.near };
}

// ----------------------------------------------------------------- environment
// What the office reflects: black space above, the Earth ahead and below, the lit floor underneath
// and one hot spot where the key light is. Painted into a small equirect and pre-filtered, only
// when the hour has moved enough (time-lapse advances it every frame).
export function createOrbitEnvironment(renderer, { earthDir, earthAngle }) {
  const W = 256, H = 128;
  const data = new Uint16Array(W * H * 4);
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const dirs = new Float32Array(W * H * 3);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const lon = ((i + 0.5) / W - 0.5) * Math.PI * 2, lat = ((j + 0.5) / H - 0.5) * Math.PI;
    dirs.set([Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)], (j * W + i) * 3);
  }
  const cosEarth = Math.cos(earthAngle), half = THREE.DataUtils.toHalfFloat;
  let target = null, lastKey = null, lastAt = -1e9, pending = null;

  function paint({ sunDir, sun, sky, floor, earth }) {
    // sun, sky, floor, earth: linear RGB radiance arrays
    for (let n = 0, k = 0; n < W * H; n++, k += 3) {
      const x = dirs[k], y = dirs[k + 1], z = dirs[k + 2];
      // space is black; "sky" is the soft fill the office is lit with, so gloss has something to
      // mirror overhead. It thins out towards the horizon.
      const up = 0.35 + 0.65 * Math.max(y, 0);
      let r = 0.010 + sky[0] * up, g = 0.012 + sky[1] * up, b = 0.022 + sky[2] * up;
      // the island's own floor fills most of the lower hemisphere for anything standing on it
      const down = THREE.MathUtils.smoothstep(-y, 0.02, 0.5);
      r += floor[0] * down; g += floor[1] * down; b += floor[2] * down;
      // the Earth: a disc with a bright limb, seen past the island's edge
      const ce = x * earthDir.x + y * earthDir.y + z * earthDir.z;
      if (ce > cosEarth - 0.06) {
        const disc = THREE.MathUtils.smoothstep(ce, cosEarth - 0.06, cosEarth + 0.01);
        const limb = Math.exp(-((ce - cosEarth) ** 2) / 0.004);
        const w = disc * (1 - down * 0.75) * (0.55 + 1.2 * limb);
        r += earth[0] * w; g += earth[1] * w; b += earth[2] * w;
      }
      // the key light, wide enough to survive the pre-filter
      const cs = x * sunDir.x + y * sunDir.y + z * sunDir.z;
      if (cs > 0.9) { const s = Math.exp(-(1 - cs) / 0.006); r += sun[0] * s; g += sun[1] * s; b += sun[2] * s; }
      const o = n * 4;
      data[o] = half(r); data[o + 1] = half(g); data[o + 2] = half(b); data[o + 3] = 15360; // 1.0
    }
    tex.needsUpdate = true;
    target = pmrem.fromEquirectangular(tex, target);
    return target.texture;
  }

  return {
    // request a new look; returns true when the texture was regenerated
    set(key, look) { pending = { key, look }; },
    update(now, scene) {
      if (!pending || (lastKey !== null && (now - lastAt < 800 || Math.abs(pending.key - lastKey) < 0.02))) return false;
      lastKey = pending.key; lastAt = now;
      scene.environment = paint(pending.look);
      pending = null;
      return true;
    },
  };
}

// --------------------------------------------------------------- lamp light pools
// A soft additive disc on the ground under every lamp: forty real lights would cost a BRDF each
// per pixel, these cost one instanced draw call.
export function createLightPools(spots, color) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d'), g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  // roughly inverse-square with a soft core, ending at exactly zero
  for (const [t, a] of [[0, 1], [0.12, 0.82], [0.3, 0.46], [0.5, 0.2], [0.75, 0.05], [1, 0]]) g.addColorStop(t, `rgba(255,255,255,${a})`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  const map = new THREE.CanvasTexture(c);
  const mat = new THREE.MeshBasicMaterial({
    map, color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const geo = new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2);
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, spots.length));
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  spots.forEach((p, i) => mesh.setMatrixAt(i, m.compose(p.position, q, s.set(p.radius, 1, p.radius))));
  mesh.count = spots.length;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.renderOrder = 1;
  mesh.visible = false;
  return {
    mesh,
    set(level) { mat.opacity = level; mesh.visible = level > 0.004; },
  };
}
