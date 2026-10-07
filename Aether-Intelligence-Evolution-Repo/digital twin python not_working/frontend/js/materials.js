// frontend/js/materials.js
// Shared holographic material system for AETHER / SKYNET.
// All city/vehicle/infra meshes should pull from these factories so the
// whole twin reads as one coherent light-blue hologram.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
export const PALETTE = {
  env: {
    sky: '#0b0f14',
    ground: '#1c1f1a',
    haze: '#0d1218',
  },
  road: {
    asphalt: '#1a1d22',
    marking: '#d8d4c4',
    centerline: '#f0c14b',
  },
  building: {
    concrete: '#3a3f47',
    glass: '#1e2a33',
    metal: '#2a2f36',
  },
  vehicle: {
    body: {
      car: '#d9dde3',
      emergency: '#d92b2b',
      glass: '#0a0d10',
      tire: '#0a0a0a',
      hub: '#8a8f96',
    },
  },
  hud: {
    accent: '#2ec4b6',
    alert: '#e63946',
    warn: '#f4a261',
    ok: '#57cc99',
    text: '#e6edf3',
    textDim: '#8b98a5',
    panel: 'rgba(10, 14, 20, 0.85)',
    border: 'rgba(46, 196, 182, 0.35)',
  },
};

export const HOLO = {
  cyan: PALETTE.hud.accent,
  cyanSoft: '#69d3c6',
  cyanDim: '#1b6d66',
  deep: PALETTE.env.sky,
  edge: PALETTE.hud.accent,
  warn: PALETTE.hud.warn,
  danger: PALETTE.hud.alert,
  ok: PALETTE.hud.ok,
  powerline: '#7bd8c9',
  highwayEdge: '#d8d4c4',
};

// ---------------------------------------------------------------------------
// GLSL helpers (shared chunks)
// ---------------------------------------------------------------------------
const FRESNEL_CHUNK = /* glsl */`
  float fresnel(vec3 normal, vec3 viewDir, float power) {
    return pow(1.0 - clamp(dot(normalize(normal), normalize(viewDir)), 0.0, 1.0), power);
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
    color = HOLO.cyan,
    edgeColor = HOLO.edge,
    opacity = 0.6,
    fresnelPower = 2.2,
    nearFade = 120.0,
    farFade = 560.0,
    map = null,
    doubleSide = true,
  } = opts;

  const uniforms = {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(color) },
    uEdgeColor: { value: new THREE.Color(edgeColor) },
    uOpacity: { value: opacity },
    uFresnelPow: { value: fresnelPower },
    uNearFade: { value: nearFade },
    uFarFade: { value: farFade },
    uMap: { value: map },
    uHasMap: { value: map ? 1 : 0 },
  };

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    blending: THREE.NormalBlending,
    uniforms,
    vertexShader: /* glsl */`
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec2 vUv;
      varying float vViewDist;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vec4 viewPos = viewMatrix * worldPos;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - worldPos.xyz);
        vUv = uv;
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
      uniform vec3 uColor;
      uniform vec3 uEdgeColor;
      uniform float uOpacity;
      uniform float uFresnelPow;
      uniform float uNearFade;
      uniform float uFarFade;
      uniform sampler2D uMap;
      uniform float uHasMap;
      ${FRESNEL_CHUNK}
      ${DEPTH_FADE_CHUNK}
      void main() {
        float f = fresnel(vNormal, vViewDir, uFresnelPow);
        float fade = depthFade(vViewDist, uNearFade, uFarFade);
        vec3 base = uColor;
        if (uHasMap > 0.5) {
          base = mix(base, texture2D(uMap, vUv).rgb, 0.35);
        }
        vec3 col = mix(base, uEdgeColor, f * 0.5);
        float alpha = (0.18 + 0.42 * f) * uOpacity * fade;
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
  const { color = HOLO.edge, opacity = 0.5, scale = 1.002 } = opts;
  const edges = new THREE.EdgesGeometry(geometry, 25);
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.NormalBlending,
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
    color = PALETTE.env.ground,
    gridColor = HOLO.cyanDim,
    opacity = 0.9,
  } = opts;

  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.95,
    metalness: 0.05,
    transparent: false,
    opacity,
  });
}

// ---------------------------------------------------------------------------
// Standard PBR materials
// ---------------------------------------------------------------------------
export function makeRoadMaterial() {
  return new THREE.MeshStandardMaterial({
    color: PALETTE.road.asphalt,
    roughness: 0.95,
    metalness: 0.0,
  });
}

export function makeBuildingMaterial(color = PALETTE.building.concrete, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.85,
    metalness: opts.metalness ?? 0.0,
    transparent: !!opts.transparent,
    opacity: opts.opacity ?? 1,
  });
}

export function makeTerrainMaterial() {
  return new THREE.MeshStandardMaterial({
    color: PALETTE.env.ground,
    roughness: 0.9,
    metalness: 0.05,
  });
}

export function makeVehicleMaterial(color = PALETTE.vehicle.body.car) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.55,
    metalness: 0.25,
  });
}

export function makeGlassMaterial() {
  return new THREE.MeshStandardMaterial({
    color: PALETTE.vehicle.body.glass,
    roughness: 0.1,
    metalness: 0.4,
    transparent: true,
    opacity: 0.65,
  });
}

export function makeTireMaterial() {
  return new THREE.MeshStandardMaterial({
    color: PALETTE.vehicle.body.tire,
    roughness: 0.95,
    metalness: 0.05,
  });
}

export function makeHubMaterial() {
  return new THREE.MeshStandardMaterial({
    color: PALETTE.vehicle.body.hub,
    roughness: 0.35,
    metalness: 0.9,
  });
}

// ---------------------------------------------------------------------------
// Emissive accent (lights, markers, signals)
// ---------------------------------------------------------------------------
export function makeEmissiveMaterial(color = HOLO.cyan, intensity = 0.7) {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.35,
    metalness: 0.2,
  });
}

export function makeAccentMaterial(color = HOLO.cyan, intensity = 1.0) {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.35,
    metalness: 0.15,
  });
}

// ---------------------------------------------------------------------------
// Global time updater — call once per frame with every holo material in scene
// ---------------------------------------------------------------------------
export function updateHoloTime(materials, time) {
  if (!materials) return;
  for (const m of materials) {
    if (m?.uniforms?.uTime) m.uniforms.uTime.value = time;
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
      if (m && (m.userData?.isHolo || m.uniforms?.uTime)) out.push(m);
    }
  });
  return out;
}