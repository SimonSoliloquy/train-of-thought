// Shared materials. The diorama sits on a sea of mist: every solid material fades
// to the mist colour below MIST_TOP, so the edges of the revealed land dissolve.
import * as THREE from 'three';
import { SKY, WATER } from './palette.js';

export const MIST_TOP = 0.15;     // world y where the fade starts
export const MIST_BOTTOM = -0.95; // fully mist here (just above the mist plane)

export function createSharedUniforms() {
  return {
    uMistColor: { value: new THREE.Color(SKY.mist) },
    uMistTop: { value: MIST_TOP },
    uMistBottom: { value: MIST_BOTTOM },
    uTime: { value: 0 },
  };
}

const WORLD_Y_VERTEX = /* glsl */`
#include <project_vertex>
{
  vec4 mistWp = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    mistWp = instanceMatrix * mistWp;
  #endif
  mistWp = modelMatrix * mistWp;
  vMistY = mistWp.y;
}
`;

const MIST_FRAGMENT = /* glsl */`
gl_FragColor.rgb = mix( gl_FragColor.rgb, uMistColor, smoothstep( uMistTop, uMistBottom, vMistY ) );
#include <fog_fragment>
`;

/**
 * Patch a built-in material so it fades into the mist below MIST_TOP.
 * Uses only chunks every lit built-in material has (project_vertex, fog_fragment).
 */
export function addMist(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uMistColor = uniforms.uMistColor;
    shader.uniforms.uMistTop = uniforms.uMistTop;
    shader.uniforms.uMistBottom = uniforms.uMistBottom;
    shader.vertexShader = 'varying float vMistY;\n' + shader.vertexShader.replace('#include <project_vertex>', WORLD_Y_VERTEX);
    shader.fragmentShader = 'uniform vec3 uMistColor;\nuniform float uMistTop;\nuniform float uMistBottom;\nvarying float vMistY;\n'
      + shader.fragmentShader.replace('#include <fog_fragment>', MIST_FRAGMENT);
  };
  material.customProgramCacheKey = () => 'tot-mist';
  return material;
}

// Surface vertices glide from aPrev to their height starting at aBorn (seconds of uTime).
const REVEAL_VERTEX = /* glsl */`
#include <begin_vertex>
{
  float revT = clamp( ( uTime - aBorn ) / REVEAL_DUR, 0.0, 1.0 );
  revT = 1.0 - ( 1.0 - revT ) * ( 1.0 - revT ) * ( 1.0 - revT );
  transformed.y = mix( aPrev, transformed.y, revT );
}
`;

// Land at the rim of the revealed area dissolves into the mist colour (after lighting, so
// lit and shaded faces alike vanish into the background).
const EDGE_MIST_FRAGMENT = /* glsl */`
gl_FragColor.rgb = mix( gl_FragColor.rgb, uMistColor, max( smoothstep( uMistTop, uMistBottom, vMistY ), smoothstep( 0.0, 0.55, vEdge ) ) );
#include <fog_fragment>
`;

/** Landscape surface: flat-shaded facets, mist fade, and the rise-out-of-the-mist reveal. */
export function createTerrainMaterial(uniforms, revealDur) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.FrontSide });
  m.shadowSide = THREE.FrontSide;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uMistColor = uniforms.uMistColor;
    shader.uniforms.uMistTop = uniforms.uMistTop;
    shader.uniforms.uMistBottom = uniforms.uMistBottom;
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = `varying float vMistY;\nvarying float vEdge;\nattribute float aEdge;\nattribute float aPrev;\nattribute float aBorn;\nuniform float uTime;\n#define REVEAL_DUR ${revealDur.toFixed(3)}\n`
      + shader.vertexShader.replace('#include <begin_vertex>', REVEAL_VERTEX + '\nvEdge = aEdge;\n').replace('#include <project_vertex>', WORLD_Y_VERTEX);
    shader.fragmentShader = 'uniform vec3 uMistColor;\nuniform float uMistTop;\nuniform float uMistBottom;\nvarying float vMistY;\nvarying float vEdge;\n'
      + shader.fragmentShader.replace('#include <fog_fragment>', EDGE_MIST_FRAGMENT);
  };
  m.customProgramCacheKey = () => 'tot-terrain';
  return m;
}

/** Continuous water surface over the river beds: gentle waves, rises with the land. */
export function createWaterSurfaceMaterial(uniforms, revealDur) {
  const water = new THREE.MeshStandardMaterial({
    color: new THREE.Color(WATER.surface), roughness: 0.16, metalness: 0.05,
    transparent: true, opacity: 0.82, flatShading: true, side: THREE.FrontSide,
  });
  water.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uMistColor = uniforms.uMistColor;
    shader.uniforms.uMistTop = uniforms.uMistTop;
    shader.uniforms.uMistBottom = uniforms.uMistBottom;
    shader.fragmentShader = 'uniform vec3 uMistColor;\nuniform float uMistTop;\nuniform float uMistBottom;\nvarying float vMistY;\nvarying float vEdge;\n'
      + shader.fragmentShader.replace('#include <fog_fragment>', EDGE_MIST_FRAGMENT + '\ngl_FragColor.a *= 1.0 - smoothstep( 0.2, 0.6, vEdge );\n');
    shader.vertexShader = `varying float vMistY;\nvarying float vEdge;\nattribute float aEdge;\nattribute float aPrev;\nattribute float aBorn;\nuniform float uTime;\n#define REVEAL_DUR ${revealDur.toFixed(3)}\n`
      + shader.vertexShader.replace('#include <project_vertex>', WORLD_Y_VERTEX).replace('#include <begin_vertex>', REVEAL_VERTEX + '\nvEdge = aEdge;\n' + /* glsl */`
{
  vec4 wpw = modelMatrix * vec4( transformed, 1.0 );
  transformed.y += ( sin( wpw.x * 2.3 + uTime * 1.4 ) + sin( wpw.z * 1.9 - uTime * 1.1 ) + sin( ( wpw.x + wpw.z ) * 3.1 + uTime * 2.0 ) * 0.5 ) * 0.014;
}
`);
  };
  water.customProgramCacheKey = () => 'tot-water-surface';
  return water;
}

export function createMaterials(uniforms, revealDur = 0.55) {
  const lambert = (opts) => addMist(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, ...opts }), uniforms);



  return {
    terrain: createTerrainMaterial(uniforms, revealDur),
    props: lambert({}),
    track: lambert({}),
    station: lambert({}),
    signHover: lambert({ emissive: new THREE.Color('#6a5014') }),
    trim: lambert({}),
    water: createWaterSurfaceMaterial(uniforms, revealDur),
    cloud: new THREE.MeshLambertMaterial({
      color: 0xffffff, emissive: new THREE.Color('#aeb9c2'), transparent: true, opacity: 0.62, depthWrite: false,
    }),
    ghostBeam: new THREE.MeshBasicMaterial({
      color: 0xffffff, vertexColors: false, transparent: true, opacity: 0.33, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    }),
    ghostSolid: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, toneMapped: false }),
    bubble: new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    halo: new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }),
    sparkle: new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }),
    smoke: new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false, flatShading: true }),
    selection: new THREE.MeshBasicMaterial({ color: 0xffd966, transparent: true, opacity: 0.95, toneMapped: false, depthWrite: false }),
    mistPlane: addMist(new THREE.MeshBasicMaterial({ color: new THREE.Color(SKY.mist) }), uniforms),
  };
}

/** Gradient sky dome with a soft sun glow. Matches the fog/mist colour at the horizon. */
export function createSkyMaterial(sunDir) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Color(SKY.zenith) },
      uHorizon: { value: new THREE.Color(SKY.horizon) },
      uBelow: { value: new THREE.Color(SKY.mist) },
      uSunDir: { value: sunDir.clone().normalize() },
      uSunColor: { value: new THREE.Color(SKY.sun) },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      uniform vec3 uBelow;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize( vDir );
        float h = d.y;
        vec3 col = mix( uHorizon, uTop, pow( smoothstep( 0.0, 1.0, max( h, 0.0 ) ), 0.55 ) );
        col = mix( col, uBelow, smoothstep( 0.0, 0.12, -h ) );
        float s = max( dot( d, normalize( uSunDir ) ), 0.0 );
        col += uSunColor * ( pow( s, 300.0 ) * 1.2 + pow( s, 12.0 ) * 0.18 ) * smoothstep( -0.05, 0.05, h );
        gl_FragColor = vec4( col, 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
}
