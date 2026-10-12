// frontend/js/police-station.js
// ---------------------------------------------------------------------------
// AETHER — police station marker.
//
// Placed at a fixed real-world GPS coordinate. Renders the same stack of
// visual elements as Hospital (ground decal + pulsing ring + beacon column
// + pole + name label) but with a police palette:
//
//   • deep blue livery instead of red
//   • a shield badge with a white star instead of a red cross
//   • blue pulsing ring instead of red
//
// The marker is re-seated whenever the city changes, using the loader's
// gpsToScene() and groundY() helpers so it sits exactly on the terrain.
//
// Copy of hospital.js — keep the two in sync if you change the shared
// geometry / animation code.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

const BLUE        = '#1f4bb8';
const BLUE_LIGHT  = '#4f7fd6';
const WHITE       = '#e8eef5';
const POLE_HEIGHT = 26;      // metres
const BADGE_SIZE  = 4.5;     // metres across
const RING_RADIUS = 12;      // metres
const DECAL_SIZE  = 16;      // metres

export class PoliceStation {
    /**
     * @param {import('./digital-twin.js').DigitalTwin} twin
     * @param {import('./city-loader.js').CityLoader}   cityLoader
     * @param {object}  [info]
     * @param {string}  [info.name]  'Mankweng Police Station'
     * @param {number}  [info.lat]
     * @param {number}  [info.lon]
     */
    constructor(twin, cityLoader, info = {}) {
        this.twin = twin;
        this.cityLoader = cityLoader;
        this.info = {
            name: info.name || 'Police Station',
            lat:  info.lat,
            lon:  info.lon,
        };

        this.group = new THREE.Group();
        this.group.name = 'police-station';
        twin.getScene().add(this.group);

        this._build();
        this._position();
        this._startLoop();
    }

    // =======================================================================
    // Public
    // =======================================================================

    /** Re-seat the marker on the terrain after a city change. */
    onCityChanged(cityLoader) {
        this.cityLoader = cityLoader;
        if (typeof this.info.lat !== 'number' || typeof this.info.lon !== 'number') {
            this.group.visible = false;
            return;
        }
        this._position();
    }

    /** Update the station's GPS location (e.g. backend tells us a new one). */
    setLocation(lat, lon, name) {
        this.info.lat = lat;
        this.info.lon = lon;
        if (name) this.info.name = name;
        this._position();
    }

    /** World-space position of the marker centre. */
    getPosition() {
        return this.group.position.clone();
    }

    // =======================================================================
    // Construction
    // =======================================================================

    _build() {
        // ---- Ground decal — blue square with white shield+star --------
        this.decalTexture = makePoliceDecalTexture();
        const decalMat = new THREE.MeshBasicMaterial({
            map: this.decalTexture,
            transparent: true,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -2,
        });
        this.decal = new THREE.Mesh(
            new THREE.PlaneGeometry(DECAL_SIZE, DECAL_SIZE),
            decalMat
        );
        this.decal.rotation.x = -Math.PI / 2;
        this.decal.position.y = 0.15;
        this.decal.renderOrder = 3;
        this.group.add(this.decal);

        // ---- Pulsing ring ----------------------------------------------
        this.ringMat = new THREE.MeshBasicMaterial({
            color: BLUE_LIGHT,
            transparent: true,
            opacity: 0.85,
            depthWrite: false,
            side: THREE.DoubleSide,
            toneMapped: false,
        });
        const ringGeo = new THREE.RingGeometry(RING_RADIUS * 0.9, RING_RADIUS, 48);
        this.ring = new THREE.Mesh(ringGeo, this.ringMat);
        this.ring.rotation.x = -Math.PI / 2;
        this.ring.position.y = 0.2;
        this.ring.renderOrder = 4;
        this.group.add(this.ring);

        // ---- Ground halo — wide, soft, tinted blue --------------------
        const haloMat = new THREE.MeshBasicMaterial({
            color: BLUE_LIGHT,
            transparent: true,
            opacity: 0.22,
            depthWrite: false,
            side: THREE.DoubleSide,
            toneMapped: false,
        });
        const haloGeo = new THREE.RingGeometry(DECAL_SIZE * 0.7, DECAL_SIZE * 2.5, 48);
        this.halo = new THREE.Mesh(haloGeo, haloMat);
        this.halo.rotation.x = -Math.PI / 2;
        this.halo.position.y = 0.25;
        this.halo.renderOrder = 2;
        this.group.add(this.halo);

        // ---- Beacon column — vertical, translucent, unmissable --------
        const columnHeight = 60;
        const columnGeo = new THREE.CylinderGeometry(3.5, 5.5, columnHeight, 24, 1, true);
        const columnMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
            uniforms: {
                uColor: { value: new THREE.Color(BLUE) },
                uTime:  { value: 0 },
            },
            vertexShader: /* glsl */`
                varying float vY;
                void main() {
                    vY = uv.y;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: /* glsl */`
                varying float vY;
                uniform vec3  uColor;
                uniform float uTime;
                void main() {
                    float a = (1.0 - vY) * 0.35;
                    a *= 0.85 + 0.15 * sin(uTime * 2.0);
                    gl_FragColor = vec4(uColor, a);
                }
            `,
        });
        this.column = new THREE.Mesh(columnGeo, columnMat);
        this.column.position.y = columnHeight / 2;
        this.column.renderOrder = 5;
        this.group.add(this.column);

        // ---- Pole ------------------------------------------------------
        const poleGeo = new THREE.CylinderGeometry(0.25, 0.25, POLE_HEIGHT, 8);
        const poleMat = new THREE.MeshStandardMaterial({
            color: '#c9ced6',
            roughness: 0.5,
            metalness: 0.5,
        });
        this.pole = new THREE.Mesh(poleGeo, poleMat);
        this.pole.position.y = POLE_HEIGHT / 2;
        this.group.add(this.pole);

        // ---- Badge panel at top of pole --------------------------------
        this.badgeTexture = makePoliceBadgeTexture();
        const badgeMat = new THREE.MeshBasicMaterial({
            map: this.badgeTexture,
            transparent: true,
            side: THREE.DoubleSide,
            depthWrite: false,
            toneMapped: false,
        });
        const panelGeo = new THREE.PlaneGeometry(BADGE_SIZE, BADGE_SIZE);

        this.badgeA = new THREE.Mesh(panelGeo, badgeMat);
        this.badgeA.position.y = POLE_HEIGHT + BADGE_SIZE / 2;
        this.group.add(this.badgeA);

        this.badgeB = new THREE.Mesh(panelGeo, badgeMat);
        this.badgeB.position.y = POLE_HEIGHT + BADGE_SIZE / 2;
        this.badgeB.rotation.y = Math.PI / 2;
        this.group.add(this.badgeB);

        // ---- Beacon light so the marker pops at night ------------------
        this.light = new THREE.PointLight(0x4f7fd6, 2.4, 90, 2);
        this.light.position.y = POLE_HEIGHT;
        this.group.add(this.light);

        // ---- Floating name label ---------------------------------------
        this.labelSprite = makeNameSprite(this.info.name);
        this.labelSprite.position.y = POLE_HEIGHT + BADGE_SIZE + 2;
        this.group.add(this.labelSprite);
    }

    _position() {
        if (!this.cityLoader?.meta) return;
        if (typeof this.info.lat !== 'number' || typeof this.info.lon !== 'number') {
            this.group.visible = false;
            return;
        }
        const { x, z } = this.cityLoader.gpsToScene(this.info.lat, this.info.lon);
        const y = this.cityLoader.groundY(x, z) ?? 0;
        this.group.position.set(x, y, z);
        this.group.visible = true;
    }

    _startLoop() {
        const tick = () => {
            const t = performance.now() * 0.001;

            // Ring pulses outward, then resets.
            const phase = (t % 2.0) / 2.0;
            const scale = 1 + phase * 0.35;
            this.ring.scale.set(scale, scale, 1);
            this.ringMat.opacity = 0.85 * (1 - phase * 0.8);

            // Beacon light gently throbs.
            this.light.intensity = 1.2 + 0.5 * Math.sin(t * 2.4);

            // Column shader pulse.
            if (this.column?.material?.uniforms?.uTime) {
                this.column.material.uniforms.uTime.value = t;
            }

            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }
}

// ---------------------------------------------------------------------------
// Canvas textures
// ---------------------------------------------------------------------------

function makePoliceDecalTexture() {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // White square base so the decal reads on any terrain colour.
    ctx.fillStyle = WHITE;
    ctx.fillRect(0, 0, size, size);

    // Blue inner square.
    const inset = size * 0.08;
    ctx.fillStyle = BLUE;
    ctx.fillRect(inset, inset, size - inset * 2, size - inset * 2);

    // Five-pointed star in the centre, white.
    drawStar(ctx, size / 2, size / 2, size * 0.32, size * 0.14, 5, WHITE);

    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

function makePoliceBadgeTexture() {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // Deep blue background.
    ctx.fillStyle = BLUE;
    ctx.fillRect(0, 0, size, size);

    // White border.
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = size * 0.06;
    ctx.strokeRect(size * 0.06, size * 0.06, size * 0.88, size * 0.88);

    // White star, centred.
    drawStar(ctx, size / 2, size / 2, size * 0.32, size * 0.14, 5, WHITE);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

function makeNameSprite(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgba(5, 8, 15, 0.78)';
    ctx.fillRect(0, 0, 512, 96);
    ctx.strokeStyle = BLUE;
    ctx.lineWidth = 3;
    ctx.strokeRect(2, 2, 508, 92);

    ctx.fillStyle = '#e8eef5';
    ctx.font = 'bold 36px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(text).toUpperCase(), 256, 48);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;

    const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthTest: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(24, 4.5, 1);
    sprite.renderOrder = 10;
    return sprite;
}

// ---------------------------------------------------------------------------
// Geometry helper — draws an N-pointed star on a 2D canvas
// ---------------------------------------------------------------------------
function drawStar(ctx, cx, cy, outerR, innerR, points, color) {
    ctx.beginPath();
    const step = Math.PI / points;
    let angle = -Math.PI / 2;    // start at top
    for (let i = 0; i < points * 2; i++) {
        const r = i % 2 === 0 ? outerR : innerR;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y);
        else         ctx.lineTo(x, y);
        angle += step;
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
}