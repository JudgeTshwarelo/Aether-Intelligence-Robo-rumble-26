// frontend/js/materials.js
// ---------------------------------------------------------------------------
// AETHER — shared holographic material system.
//
// Every city / vehicle / infrastructure mesh pulls from these factories so
// the whole twin reads as one coherent hologram when the HOLO LAYER toggle
// is on. In real mode the GLB's own materials are used instead; these
// factories exist so that Aether-owned objects (ambulances, drones, route
// lines, markers) still speak the same visual language.
//
// Palette is deliberately desaturated — additive blending plus bloom will
// brighten these back up, so start darker than you think you want.
//
// NOTE: this module assumes a SINGLE-GLB city (Mankweng). Layer names in
// comments refer to the urban:EXPORT naming convention.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
export const HOLO = {
    cyan:        '#3a7ca8',   // steel blue — base hologram colour
    cyanSoft:    '#7a9bb8',   // muted slate — secondary text/lines
    cyanDim:     '#16242f',   // dark grid tone
    deep:        '#060a0f',   // background / void
    edge:        '#5a7d99',   // fresnel rim
    warn:        '#c98a35',   // burnt amber
    danger:      '#a83838',   // deep crimson
    ok:          '#4a8a5c',   // forest green
    powerline:   '#6a8ba5',
    highwayEdge: '#7a9bb8',

    // --- NEW: road + terrain palette -------------------------------------
    roadAsphalt: '#0b1e3a',   // deep navy-blue asphalt
    roadLine:    '#3fd0ff',   // holo cyan — edge and centre markings
    roadLineDim: '#1a5a7a',   // dimmer cyan for the dashed centre line
    terrain:     '#3a2c1e',   // warm brown earth
    building:    '#8a8f96',   // concrete grey — reads as buildings, not snow
    buildingPub: '#b8ae95',   // warmer off-white for civic buildings
};

// ---------------------------------------------------------------------------
// GLSL helper chunks
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
// Core: holographic material
// ---------------------------------------------------------------------------
/**
 * Fresnel + scanline holographic material.
 *
 * @param {Object} [opts]
 * @param {string}  [opts.color]         base emissive colour
 * @param {string}  [opts.edgeColor]     rim / fresnel colour
 * @param {number}  [opts.opacity]       base opacity
 * @param {number}  [opts.fresnelPower]  rim sharpness
 * @param {number}  [opts.scanCount]     scanline density
 * @param {number}  [opts.scanSpeed]     scanline speed
 * @param {number}  [opts.nearFade]      depth fade start distance
 * @param {number}  [opts.farFade]       depth fade end distance
 * @param {THREE.Texture} [opts.map]     optional facade texture
 * @param {boolean} [opts.doubleSide]
 */
export function makeHoloMaterial(opts = {}) {
    const {
        color        = HOLO.cyan,
        edgeColor    = HOLO.edge,
        opacity      = 0.38,
        fresnelPower = 2.2,
        scanCount    = 90.0,
        scanSpeed    = 1.5,
        nearFade     = 120.0,
        farFade      = 560.0,
        map          = null,
        doubleSide   = true,
    } = opts;

    const uniforms = {
        uTime:       { value: 0 },
        uColor:      { value: new THREE.Color(color) },
        uEdgeColor:  { value: new THREE.Color(edgeColor) },
        uOpacity:    { value: opacity },
        uFresnelPow: { value: fresnelPower },
        uScanCount:  { value: scanCount },
        uScanSpeed:  { value: scanSpeed },
        uNearFade:   { value: nearFade },
        uFarFade:    { value: farFade },
        uMap:        { value: map },
        uHasMap:     { value: map ? 1 : 0 },
    };

    const material = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
        blending: THREE.AdditiveBlending,
        uniforms,
        vertexShader: /* glsl */`
            varying vec3  vNormal;
            varying vec3  vViewDir;
            varying vec2  vUv;
            varying float vViewDist;

            void main() {
                vec4 worldPos = modelMatrix * vec4(position, 1.0);
                vec4 viewPos  = viewMatrix  * worldPos;

                vNormal   = normalize(mat3(modelMatrix) * normal);
                vViewDir  = normalize(cameraPosition - worldPos.xyz);
                vUv       = uv;
                vViewDist = -viewPos.z;

                gl_Position = projectionMatrix * viewPos;
            }
        `,
        fragmentShader: /* glsl */`
            precision highp float;

            varying vec3  vNormal;
            varying vec3  vViewDir;
            varying vec2  vUv;
            varying float vViewDist;

            uniform float      uTime;
            uniform vec3       uColor;
            uniform vec3       uEdgeColor;
            uniform float      uOpacity;
            uniform float      uFresnelPow;
            uniform float      uScanCount;
            uniform float      uScanSpeed;
            uniform float      uNearFade;
            uniform float      uFarFade;
            uniform sampler2D  uMap;
            uniform float      uHasMap;

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

                vec3 col = mix(base, uEdgeColor, f * 0.7);
                col += uEdgeColor * f * 0.35;
                col *= 0.75 + 0.20 * scan;
                col *= pulse;

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
// Wireframe edge overlay
// ---------------------------------------------------------------------------
export function makeHoloEdges(geometry, opts = {}) {
    const {
        color   = HOLO.edge,
        opacity = 0.40,
        scale   = 1.001,
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
// Ground / grid material
// ---------------------------------------------------------------------------
export function makeHoloGroundMaterial(opts = {}) {
    const {
        color     = HOLO.deep,
        gridColor = HOLO.cyanDim,
        opacity   = 0.55,
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
            varying vec2  vUv;
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

            varying vec2  vUv;
            varying float vViewDist;

            uniform float uTime;
            uniform vec3  uColor;
            uniform vec3  uGridColor;
            uniform float uOpacity;

            ${DEPTH_FADE_CHUNK}

            void main() {
                vec2  g    = abs(fract(vUv * 60.0) - 0.5);
                float line = smoothstep(0.48, 0.5, max(g.x, g.y));
                float fade = depthFade(vViewDist, 80.0, 520.0);
                float pulse = 0.92 + 0.08 * sin(uTime * 1.2);

                vec3 col = mix(uColor, uGridColor, line);

                float alpha = (0.22 + 0.42 * line) * uOpacity * fade * pulse;
                if (alpha < 0.01) discard;

                gl_FragColor = vec4(col, alpha);
            }
        `,
    });
}

// ---------------------------------------------------------------------------
// Vehicle paint
// ---------------------------------------------------------------------------
export function makeVehicleMaterial(opts = {}) {
    return makeHoloMaterial({
        color:        opts.color || HOLO.cyanSoft,
        edgeColor:    HOLO.edge,
        opacity:      0.55,
        fresnelPower: 1.8,
        scanCount:    60.0,
        scanSpeed:    2.2,
        nearFade:     60.0,
        farFade:      420.0,
        ...opts,
    });
}

// ---------------------------------------------------------------------------
// Emissive accent
// ---------------------------------------------------------------------------
export function makeAccentMaterial(color = HOLO.cyan, intensity = 1.2) {
    const clamped = Math.max(0.1, Math.min(2.0, intensity));
    const opacity = 0.55 + 0.30 * (clamped / 2.0);

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
// Global time updater
// ---------------------------------------------------------------------------
export function updateHoloTime(materials, time) {
    for (const m of materials) {
        if (m?.userData?.isHolo && m.uniforms?.uTime) {
            m.uniforms.uTime.value = time;
        } else if (m?.uniforms?.uTime) {
            m.uniforms.uTime.value = time;
        }
    }
}

// ---------------------------------------------------------------------------
// Convenience: walk a scene/group and collect every holo material
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

// ---------------------------------------------------------------------------
// Road surface — deep-blue asphalt with holo-cyan markings.
//
// We override the GLB's ROADS material with this so the road network reads
// as actual roads (not a white blanket) and matches the Aether palette.
// ---------------------------------------------------------------------------

/**
 * Build the road-markings texture: a horizontal strip representing one
 * "tile" of road width. Draws:
 *   • holo-cyan solid edge lines at the outer 8 %
 *   • holo-cyan dashed centre line down the middle
 *   • deep-blue asphalt base
 *
 * Meant to be tiled along the road direction with `repeat.set(N, 1)`,
 * where N is roughly (roadLength / 6).
 */
export function makeRoadMarkingsTexture() {
    const canvas = document.createElement('canvas');
    canvas.width  = 128;      // was 64 — more resolution across the road
    canvas.height = 512;
    const ctx = canvas.getContext('2d');

    // Deep blue asphalt base.
    ctx.fillStyle = HOLO.roadAsphalt;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Grain.
    for (let i = 0; i < 4000; i++) {
        const x = Math.random() * canvas.width;
        const y = Math.random() * canvas.height;
        const a = 0.03 + Math.random() * 0.07;
        ctx.fillStyle = `rgba(120, 180, 230, ${a})`;
        ctx.fillRect(x, y, 1, 1);
    }

    // Edge lines — 6 px wide, brighter, with a soft glow.
    ctx.fillStyle = HOLO.roadLine;
    ctx.shadowColor = HOLO.roadLine;
    ctx.shadowBlur  = 10;
    ctx.fillRect(6, 0, 6, canvas.height);
    ctx.fillRect(canvas.width - 12, 0, 6, canvas.height);

    // Centre dashed line — 6 px wide, 40 on / 20 off.
    ctx.fillStyle = HOLO.roadLine;
    const cx = canvas.width / 2 - 3;
    for (let y = 0; y < canvas.height; y += 60) {
        ctx.fillRect(cx, y, 6, 40);
    }

    ctx.shadowBlur = 0;

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

/**
 * Road surface material — deep-blue asphalt with holo-cyan markings.
 *
 * Uses emissive + emissiveMap to make the lines self-lit so they read from
 * altitude even in the "real" mode. This is what gives the hologram feel
 * without going full additive shader.
 */
export function makeRoadSurfaceMaterial(opts = {}) {
    const {
        color      = HOLO.roadAsphalt,
        roughness  = 0.75,
        metalness  = 0.0,
        tileMeters = 6.0,
        emissive   = HOLO.roadLine,
        emissiveIntensity = 1.6,   // was 0.85
    } = opts;

    const tex = makeRoadMarkingsTexture();

    return new THREE.MeshStandardMaterial({
        map: tex,
        color,
        roughness,
        metalness,
        emissive: new THREE.Color(emissive),
        emissiveMap: tex,
        emissiveIntensity,

        polygonOffset: true,
        polygonOffsetFactor: -4,   // was -1 — stronger pull toward camera
        polygonOffsetUnits: -8,    // was -1

        // Slight transparency at the edges so terrain blends through.
        // Keeps the roads from looking like painted decals on a flat plane.
        transparent: false,
    });
}

// ---------------------------------------------------------------------------
// Trees — flat matte green, no texture.
//
// 26,878+ tree meshes share this single material after merging. The colour
// is deliberately muted: bright foliage competes with the roads and cars,
// and reads as "toy" rather than "city".
// ---------------------------------------------------------------------------
export function makeTreeMaterial() {
    return new THREE.MeshStandardMaterial({
        color: '#1a2c20',        // very dark, desaturated forest green
        roughness: 0.95,
        metalness: 0.0,
    });
}

// ---------------------------------------------------------------------------
// Terrain — warm brown earth under the whole city.
//
// The GLB's TERRAIN* layer gets this. Brown reads as ground from altitude
// and gives the roads and buildings something to sit on. It also doubles
// as the fallback surface for any un-indexed ground mesh the exporter
// happened to emit.
// ---------------------------------------------------------------------------
export function makeTerrainMaterial() {
    return new THREE.MeshStandardMaterial({
        color: HOLO.terrain,     // warm brown
        roughness: 1.0,
        metalness: 0.0,
        // Very slight emissive so the terrain doesn't go pitch-black
        // under the ACES tonemap when viewed at grazing angles.
        emissive: new THREE.Color('#1a0f06'),
        emissiveIntensity: 0.12,
    });
}

// ---------------------------------------------------------------------------
// Buildings — merged concrete grey, one material for all.
//
// After merging, individual buildings lose their per-building colour. We
// pick a mid-concrete grey that reads as buildings from the air. No
// metalness, high roughness — this is deliberately matte so the grey
// doesn't shimmer into white under bloom.
// ---------------------------------------------------------------------------
export function makeBuildingMaterial() {
    return new THREE.MeshStandardMaterial({
        color: HOLO.building,    // mid-concrete grey
        roughness: 0.95,
        metalness: 0.0,
        emissive: new THREE.Color('#1a1c20'),
        emissiveIntensity: 0.10,
    });
}

// ---------------------------------------------------------------------------
// Paths — light concrete sidewalk tint, distinct from roads.
// ---------------------------------------------------------------------------
export function makePathMaterial() {
    return new THREE.MeshStandardMaterial({
        color: '#5a6573',        // mid-grey, lighter than asphalt
        roughness: 0.9,
        metalness: 0.0,
    });
}

// ---------------------------------------------------------------------------
// Public buildings — clinics, schools, civic. Slightly warmer than the
// general building concrete so the eye reads them as "institutional".
// ---------------------------------------------------------------------------
export function makePublicBuildingMaterial() {
    return new THREE.MeshStandardMaterial({
        color: HOLO.buildingPub, // warm off-white concrete
        roughness: 0.9,
        metalness: 0.0,
        emissive: new THREE.Color('#1a1408'),
        emissiveIntensity: 0.12,
    });
}