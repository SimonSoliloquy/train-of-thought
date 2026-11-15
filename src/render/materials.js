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

export function createMaterials(uniforms) {
  const lambert = (opts) => addMist(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, ...opts }), uniforms);

  const water = new THREE.MeshStandardMaterial({
    color: new THREE.Color(WATER.surface),
    roughness: 0.18,
    metalness: 0.05,
    transparent: true,
    opacity: 0.8,
    flatShading: true,
    side: THREE.FrontSide,
  });
  water.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace('#include <begin_vertex>', /* glsl */`
#include <begin_vertex>
{
  vec4 wpw = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    wpw = instanceMatrix * wpw;
  #endif
  wpw = modelMatrix * wpw;
  transformed.y += ( sin( wpw.x * 2.3 + uTime * 1.4 ) + sin( wpw.z * 1.9 - uTime * 1.1 ) + sin( ( wpw.x + wpw.z ) * 3.1 + uTime * 2.0 ) * 0.5 ) * 0.018;
}
`);
  };
  water.customProgramCacheKey = () => 'tot-water';

  return {
    terrain: lambert({}),
    props: lambert({}),
    track: lambert({}),
    station: lambert({}),
    trim: lambert({}),
    water,
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
    mistPlane: new THREE.MeshBasicMaterial({ color: new THREE.Color(SKY.mist) }),
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
