// frontend/js/materials.js
// Shared holographic material system for AETHER / SKYNET.
// All city/vehicle/infra meshes should pull from these factories so the
// whole twin reads as one coherent light-blue hologram.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
export const HOLO = {
  cyan:        '#39ffd8',
  cyanSoft:    '#7ffbe6',
  cyanDim:     '#1a8f7d',
  deep:        '#05080f',
  edge:        '#aefcf0',
  warn:        '#ffb347',
  danger:      '#ff3b3b',
  ok:          '#76efb0',
  powerline:   '#8affee',
  highwayEdge: '#aefcf0',
};

// ---------------------------------------------------------------------------
// GLSL helpers (shared chunks)
// ---------------------------------------------------------------------------
const FRESNEL_CHUNK = /* glsl */`
  float fresnel(vec3 normal, vec3 viewDir, float power) {
    return pow(1.0 - clamp(dot(normalize(normal), normalize(viewDir)), 0.0, 1.0), power);
  }
`;

const SCANLINE_CHUNK = /* glsl */`
  float scanline(vec2 uv, float count, float speed, float time) {
    float line = sin((uv.y * count) - (time * speed)) * 0.5 + 0.5;
    return smoothstep(0.35, 1.0, line);
  }
`;

const DEPTH_FADE_CHUNK = /* glsl */`
  float depthFade(float viewDistance, float nearFade, float farFade) {
    return 1.0 - smoothstep(nearFade, farFade, viewDistance);
  }
`;

// ---------------------------------------------------------------------------
// Core: Holographic material
// ---------------------------------------------------------------------------
/**
 * Build a fresnel + scanline holographic material.
 * Works for buildings, roads, vehicles — anything with a surface.
 *
 * @param {Object} opts
 * @param {string} [opts.color]        base emissive color (default cyan)
 * @param {string} [opts.edgeColor]    rim/fresnel color
 * @param {number} [opts.opacity]      base opacity (default 0.55)
 * @param {number} [opts.fresnelPower] rim sharpness (default 2.2)
 * @param {number} [opts.scanCount]    scanline density (default 90)
 * @param {number} [opts.scanSpeed]    scanline speed (default 1.5)
 * @param {number} [opts.nearFade]     depth fade start distance
 * @param {number} [opts.farFade]      depth fade end distance
 * @param {THREE.Texture} [opts.map]   optional facade/pattern texture
 * @param {boolean} [opts.doubleSide]
 */
export function makeHoloMaterial(opts = {}) {
  const {
    color       = HOLO.cyan,
    edgeColor   = HOLO.edge,
    opacity     = 0.55,
    fresnelPower = 2.2,
    scanCount   = 90.0,
    scanSpeed   = 1.5,
    nearFade    = 120.0,
    farFade     = 560.0,
    map         = null,
    doubleSide  = true,
  } = opts;

  const uniforms = {
    uTime:        { value: 0 },
    uColor:       { value: new THREE.Color(color) },
    uEdgeColor:   { value: new THREE.Color(edgeColor) },
    uOpacity:     { value: opacity },
    uFresnelPow:  { value: fresnelPower },
    uScanCount:   { value: scanCount },
    uScanSpeed:   { value: scanSpeed },
    uNearFade:    { value: nearFade },
    uFarFade:     { value: farFade },
    uMap:         { value: map },
    uHasMap:      { value: map ? 1 : 0 },
  };

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    blending: THREE.AdditiveBlending,
    uniforms,
    vertexShader: /* glsl */`
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec2 vUv;
      varying float vViewDist;

      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vec4 viewPos  = viewMatrix * worldPos;

        vNormal   = normalize(mat3(modelMatrix) * normal);
        vViewDir  = normalize(cameraPosition - worldPos.xyz);
        vUv       = uv;
        vViewDist = -viewPos.z;

        gl_Position = projectionMatrix * viewPos;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;

      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec2 vUv;
      varying float vViewDist;

      uniform float uTime;
      uniform vec3  uColor;
      uniform vec3  uEdgeColor;
      uniform float uOpacity;
      uniform float uFresnelPow;
      uniform float uScanCount;
      uniform float uScanSpeed;
      uniform float uNearFade;
      uniform float uFarFade;
      uniform sampler2D uMap;
      uniform float uHasMap;

      ${FRESNEL_CHUNK}
      ${SCANLINE_CHUNK}
      ${DEPTH_FADE_CHUNK}

      void main() {
        float f       = fresnel(vNormal, vViewDir, uFresnelPow);
        float scan    = scanline(vUv, uScanCount, uScanSpeed, uTime);
        float fade    = depthFade(vViewDist, uNearFade, uFarFade);
        float pulse   = 0.85 + 0.15 * sin(uTime * 2.0);

        vec3 base = uColor;
        if (uHasMap > 0.5) {
          vec3 tex = texture2D(uMap, vUv).rgb;
          base = mix(base, tex, 0.35);
        }

        vec3 col = mix(base, uEdgeColor, f);
        col += uEdgeColor * f * 0.6;
        col *= 0.75 + 0.25 * scan;
        col *= pulse;

        float alpha = (0.35 + 0.65 * f) * uOpacity * fade;
        alpha *= 0.8 + 0.2 * scan;

        if (alpha < 0.01) discard;

        gl_FragColor = vec4(col, alpha);
      }
    `,
  });

  material.userData.isHolo = true;
  return material;
}

// ---------------------------------------------------------------------------
// Wireframe overlay (edge lines)
// ---------------------------------------------------------------------------
/**
 * Build a wireframe edge overlay for a geometry. Returns a LineSegments
 * object meant to be added as a child of the mesh it decorates.
 */
export function makeHoloEdges(geometry, opts = {}) {
  const {
    color    = HOLO.edge,
    opacity  = 0.55,
    scale    = 1.001,
  } = opts;

  const edges = new THREE.EdgesGeometry(geometry, 25);
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const lines = new THREE.LineSegments(edges, mat);
  lines.scale.setScalar(scale);
  lines.userData.isHoloEdge = true;
  return lines;
}

// ---------------------------------------------------------------------------
// Ground / grid material (subtle, non-additive)
// ---------------------------------------------------------------------------
export function makeHoloGroundMaterial(opts = {}) {
  const {
    color     = HOLO.deep,
    gridColor = HOLO.cyanDim,
    opacity   = 0.9,
  } = opts;

  const uniforms = {
    uTime:      { value: 0 },
    uColor:     { value: new THREE.Color(color) },
    uGridColor: { value: new THREE.Color(gridColor) },
    uOpacity:   { value: opacity },
  };

  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms,
    vertexShader: /* glsl */`
      varying vec2 vUv;
      varying float vViewDist;
      void main() {
        vUv = uv;
        vec4 viewPos = viewMatrix * modelMatrix * vec4(position, 1.0);
        vViewDist = -viewPos.z;
        gl_Position = projectionMatrix * viewPos;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec2 vUv;
      varying float vViewDist;
      uniform float uTime;
      uniform vec3  uColor;
      uniform vec3  uGridColor;
      uniform float uOpacity;

      ${DEPTH_FADE_CHUNK}

      void main() {
        vec2 g = abs(fract(vUv * 60.0) - 0.5);
        float line = smoothstep(0.48, 0.5, max(g.x, g.y));
        float fade = depthFade(vViewDist, 80.0, 520.0);
        float pulse = 0.9 + 0.1 * sin(uTime * 1.2);

        vec3 col = mix(uColor, uGridColor, line);
        float alpha = (0.4 + 0.6 * line) * uOpacity * fade * pulse;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
}

// ---------------------------------------------------------------------------
// Vehicle paint (slightly denser, less transparent)
// ---------------------------------------------------------------------------
export function makeVehicleMaterial(opts = {}) {
  return makeHoloMaterial({
    color:       opts.color || HOLO.cyanSoft,
    edgeColor:   HOLO.edge,
    opacity:     0.72,
    fresnelPower: 1.8,
    scanCount:   60.0,
    scanSpeed:   2.2,
    nearFade:    60.0,
    farFade:     420.0,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Emissive accent (lights, markers, signals)
// ---------------------------------------------------------------------------
export function makeAccentMaterial(color = HOLO.cyan, intensity = 2.0) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
}

// ---------------------------------------------------------------------------
// Global time updater — call once per frame with every holo material in scene
// ---------------------------------------------------------------------------
export function updateHoloTime(materials, time) {
  for (const m of materials) {
    if (m?.userData?.isHolo && m.uniforms?.uTime) {
      m.uniforms.uTime.value = time;
    }
    if (m?.uniforms?.uTime) {
      m.uniforms.uTime.value = time;
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience: track all holo materials on a group for time updates
// ---------------------------------------------------------------------------
export function collectHoloMaterials(root) {
  const out = [];
  root.traverse((obj) => {
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (m?.userData?.isHolo || m?.uniforms?.uTime) out.push(m);
    }
  });
  return out;
}