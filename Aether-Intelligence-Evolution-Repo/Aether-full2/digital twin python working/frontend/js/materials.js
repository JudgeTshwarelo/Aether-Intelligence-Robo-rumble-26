// frontend/js/materials.js
// Shared holographic material system for AETHER / SKYNET.
// All city/vehicle/infra meshes should pull from these factories so the
// whole twin reads as one coherent hologram.
//
// ⚡ PERF / LOOK PASS:
//   - Palette desaturated: deeper steel-blue instead of bright sky-cyan.
//   - Default holo opacity 0.55 → 0.38.
//   - Fragment alpha softened; scanline modulation reduced.
//   - Ground grid dialed back so it doesn't blow out under bloom.
//   - Vehicle paint less transparent.
//   - Accent materials default intensity 2.0 → 1.2.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Palette — desaturated, deeper. Additive blending + bloom will brighten
// these back up, so start darker than you'd think.
// ---------------------------------------------------------------------------
export const HOLO = {
  cyan:        '#3a7ca8',   // was #7dd3fc — deeper steel blue
  cyanSoft:    '#7a9bb8',   // was #dfeaf6 — muted slate
  cyanDim:     '#16242f',   // was #2f4858 — darker grid tone
  deep:        '#060a0f',   // was #0b1016 — slightly darker background
  edge:        '#5a7d99',   // was #9cc4d9 — mid grey-blue for edges
  warn:        '#c98a35',   // was #f8b84e — burnt amber
  danger:      '#a83838',   // was #ff5e5b — deep crimson
  ok:          '#4a8a5c',   // was #68d391 — forest green
  powerline:   '#6a8ba5',   // was #9cc4d9
  highwayEdge: '#7a9bb8',   // was #dfeaf6
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
 * @param {number} [opts.opacity]      base opacity (default 0.38)
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
    color        = HOLO.cyan,
    edgeColor    = HOLO.edge,
    opacity      = 0.38,      // was 0.55
    fresnelPower = 2.2,
    scanCount    = 90.0,
    scanSpeed    = 1.5,
    nearFade     = 120.0,
    farFade      = 560.0,
    map          = null,
    doubleSide   = true,
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
        float f     = fresnel(vNormal, vViewDir, uFresnelPow);
        float scan  = scanline(vUv, uScanCount, uScanSpeed, uTime);
        float fade  = depthFade(vViewDist, uNearFade, uFarFade);
        float pulse = 0.88 + 0.12 * sin(uTime * 2.0);

        vec3 base = uColor;
        if (uHasMap > 0.5) {
          vec3 tex = texture2D(uMap, vUv).rgb;
          base = mix(base, tex, 0.30);
        }

        // Softer mix toward the fresnel edge color.
        vec3 col = mix(base, uEdgeColor, f * 0.7);
        col += uEdgeColor * f * 0.35;
        col *= 0.75 + 0.20 * scan;
        col *= pulse;

        // ⚡ PERF / LOOK: lower base alpha and gentler scanline modulation
        float alpha = (0.22 + 0.58 * f) * uOpacity * fade;
        alpha *= 0.78 + 0.14 * scan;

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
    opacity  = 0.40,          // was 0.55
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
    opacity   = 0.55,         // was 0.9
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
        float pulse = 0.92 + 0.08 * sin(uTime * 1.2);

        vec3 col = mix(uColor, uGridColor, line);
        // ⚡ softer grid lines
        float alpha = (0.22 + 0.42 * line) * uOpacity * fade * pulse;
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
    color:        opts.color || HOLO.cyanSoft,
    edgeColor:    HOLO.edge,
    opacity:      0.55,       // was 0.72
    fresnelPower: 1.8,
    scanCount:    60.0,
    scanSpeed:    2.2,
    nearFade:     60.0,
    farFade:      420.0,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Emissive accent (lights, markers, signals)
// ---------------------------------------------------------------------------
export function makeAccentMaterial(color = HOLO.cyan, intensity = 1.2) {
  // NOTE: `intensity` is kept for API compat but MeshBasicMaterial doesn't
  // have an intensity knob. We map it to opacity: low intensity → softer
  // emissive. Values above 2.0 stay clamped.
  const clamped = Math.max(0.1, Math.min(2.0, intensity));
  const opacity = 0.55 + 0.30 * (clamped / 2.0);   // 0.55 → 0.85
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
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