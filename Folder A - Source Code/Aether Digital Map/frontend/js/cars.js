// frontend/js/cars.js
// ---------------------------------------------------------------------------
// AETHER — Car actor system.
//
// Same architecture as ambulances.js and drones.js:
//   • pool of car meshes indexed by backend id
//   • GPS → scene conversion + terrain snap
//   • interpolation between backend snapshot frames
//   • cosmetic emergency pull-aside (local, not backhauled)
//   • minimap markers via ui.setMarkers()
//
// Differences from the emergency vehicles:
//   • designed for hundreds of actors, not a handful
//   • shared geometries + palette materials, no per-car material clones
//   • headlights and taillights for ambient life at night
//   • pull-aside is a lateral offset in world space, driven by a flag on
//     the frame — the backend never moves cars sideways
// ---------------------------------------------------------------------------

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const CAR_LENGTH = 4.3;
const CAR_WIDTH  = 1.9;
const CAR_HEIGHT = 1.0;

const SMOOTH_TIME      = 0.30;      // seconds — position lerp window
const ROT_SMOOTH_TIME  = 0.20;      // seconds — heading lerp window
const PULL_ASIDE_TIME  = 0.35;      // seconds — how fast a car slides aside
const PULL_ASIDE_DIST  = 1.6;       // metres — lateral offset while fleeing

// Beacon intensity constants (lights on all cars)
const HEADLIGHT_COLOR  = '#fff2d0';
const TAILLIGHT_COLOR  = '#ff3344';

// ---------------------------------------------------------------------------
// Cars class
// ---------------------------------------------------------------------------
export class Cars {
    /**
     * @param {import('./digital-twin.js').DigitalTwin} twin
     * @param {import('./city-loader.js').CityLoader}   cityLoader
     */
    constructor(twin, cityLoader) {
        this.twin = twin;
        this.cityLoader = cityLoader;

        this.group = new THREE.Group();
        this.group.name = 'cars';
        twin.getScene().add(this.group);

        // id → CarActor
        this.actors = new Map();

        this._geo  = makeSharedGeometries();
        this._mats = makePaletteMaterials();

        this.ui = null;
        this._markerAccum = 0;

        this._startLoop();
    }

    // =======================================================================
    // Public API
    // =======================================================================

    onCityChanged(cityLoader) {
        this.cityLoader = cityLoader;

        for (const actor of this.actors.values()) {
            this.group.remove(actor.root);
            actor.dispose();
        }
        this.actors.clear();
        this._pushMarkers();
    }

    /**
     * Backend sent a new snapshot of car positions.
     * @param {Array} list  [{ id, lat, lon, heading, speed, status,
     *                         color, emergency_nearby }, ...]
     */
    setFrame(list) {
        if (!Array.isArray(list)) return;

        const seen = new Set();
        for (const rec of list) {
            if (!rec?.id) continue;
            seen.add(rec.id);

            let actor = this.actors.get(rec.id);
            if (!actor) actor = this._spawn(rec);
            actor.enqueueFrame(rec);
        }

        // Cars that the backend no longer reports have been despawned.
        for (const id of [...this.actors.keys()]) {
            if (!seen.has(id)) {
                const actor = this.actors.get(id);
                this.group.remove(actor.root);
                actor.dispose();
                this.actors.delete(id);
            }
        }
    }

    count() { return this.actors.size; }

    getById(id) { return this.actors.get(id) || null; }

    attachToUI(ui) { this.ui = ui; }

    // =======================================================================
    // Spawning
    // =======================================================================

    _spawn(rec) {
        const actor = new CarActor(
            rec.id,
            rec.color,
            this._geo,
            this._mats,
            this.cityLoader
        );
        this.group.add(actor.root);
        this.actors.set(actor.id, actor);
        return actor;
    }

    // =======================================================================
    // Render loop — interpolates every car every frame
    // =======================================================================

    _startLoop() {
        let last = performance.now();
        const tick = () => {
            const now = performance.now();
            const dt = Math.min(0.1, (now - last) / 1000);
            last = now;

            for (const actor of this.actors.values()) {
                actor.update(dt, now);
            }

            // Minimap refresh at ~10 Hz.
            this._markerAccum += dt;
            if (this._markerAccum > 0.1) {
                this._markerAccum = 0;
                this._pushMarkers();
            }

            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    _pushMarkers() {
        if (!this.ui) return;
        const markers = [];
        for (const actor of this.actors.values()) {
            const p = actor.root.position;
            markers.push({
                kind: 'car',
                id: actor.id,
                x: p.x,
                z: p.z,
                color: actor.isFleeing() ? '#ff8844' : '#8899aa',
                size: 1.6,
            });
        }
        // Cars push their own subset; other systems handle theirs. Order of
        // pushes across systems doesn't matter because each filters itself.
        this.ui.setMarkers(
            this.ui._markers
                .filter((m) => m.kind !== 'car')
                .concat(markers)
        );
    }
}

// ---------------------------------------------------------------------------
// CarActor — one mesh, one state machine
// ---------------------------------------------------------------------------
class CarActor {
    constructor(id, colorHex, geo, mats, cityLoader) {
        this.id = id;
        this.cityLoader = cityLoader;

        this.root = new THREE.Group();
        this.root.name = `car:${id}`;
        this.root.userData = { kind: 'car', id };

        // Pick a material from the palette. Shared across all cars of that
        // colour, so we don't allocate per-car materials.
        const paletteMat = mats.byColor[colorHex] || mats.default;

        // ---- Body -------------------------------------------------------
        this.body = new THREE.Mesh(geo.body, paletteMat);
        this.body.position.y = CAR_HEIGHT / 2;
        this.root.add(this.body);

        // ---- Cabin (darker, glass-like) ---------------------------------
        this.cabin = new THREE.Mesh(geo.cabin, mats.cabin);
        this.cabin.position.set(0, CAR_HEIGHT * 0.9, -CAR_LENGTH * 0.08);
        this.root.add(this.cabin);

        // ---- Headlights (front) -----------------------------------------
        this.head1 = new THREE.Mesh(geo.light, mats.headlight);
        this.head1.position.set( CAR_WIDTH * 0.32, CAR_HEIGHT * 0.45, CAR_LENGTH / 2 - 0.05);
        this.root.add(this.head1);

        this.head2 = this.head1.clone();
        this.head2.position.x = -CAR_WIDTH * 0.32;
        this.root.add(this.head2);

        // ---- Taillights (rear) ------------------------------------------
        this.tail1 = new THREE.Mesh(geo.light, mats.taillight);
        this.tail1.position.set( CAR_WIDTH * 0.32, CAR_HEIGHT * 0.5, -CAR_LENGTH / 2 + 0.05);
        this.root.add(this.tail1);

        this.tail2 = this.tail1.clone();
        this.tail2.position.x = -CAR_WIDTH * 0.32;
        this.root.add(this.tail2);

        // ---- State ------------------------------------------------------
        this.frame = null;
        this.previous = null;

        this.targetPos = new THREE.Vector3();
        this.targetHeading = 0;
        this.currentHeading = 0;

        // Lateral offset state for pull-aside.
        this.pullAside = 0;         // current offset in metres (signed)
        this.pullAsideTarget = 0;   // what we're lerping toward

        // Which side of the road to pull to. Randomised once per car so the
        // whole fleet doesn't dive the same way.
        this.pullSide = Math.random() < 0.5 ? -1 : 1;

        // Small random Y-offset so the cars don't look pixel-aligned.
        // Two centimetres is invisible but breaks the grid appearance.
        this.yJitter = (Math.random() - 0.5) * 0.02;
    }

    // -----------------------------------------------------------------------
    // Frame intake
    // -----------------------------------------------------------------------

    enqueueFrame(rec) {
        this.previous = this.frame;
        this.frame = rec;

        if (!this.cityLoader?.meta) return;

        const { x, z } = this.cityLoader.gpsToScene(rec.lat, rec.lon);
        const y = this.cityLoader.groundY(x, z) ?? 0;
        this.targetPos.set(x, y, z);

        if (typeof rec.heading === 'number') {
            this.targetHeading = rec.heading;
        } else if (this.previous) {
            const { x: px, z: pz } = this.cityLoader.gpsToScene(
                this.previous.lat, this.previous.lon
            );
            const dx = x - px;
            const dz = z - pz;
            if (Math.abs(dx) + Math.abs(dz) > 0.01) {
                this.targetHeading = Math.atan2(dx, dz);
            }
        }

        // Emergency pull-aside — target is +1 or -1 times the distance,
        // based on which side this car pulled to when it was spawned.
        this.pullAsideTarget = rec.emergency_nearby
            ? this.pullSide * PULL_ASIDE_DIST
            : 0;
    }

    // -----------------------------------------------------------------------
    // Per-frame update
    // -----------------------------------------------------------------------

    update(dt, now) {
        // ---- Smooth heading --------------------------------------------
        const dh = shortestAngle(this.currentHeading, this.targetHeading);
        const rotAlpha = 1 - Math.exp(-dt / ROT_SMOOTH_TIME);
        this.currentHeading += dh * rotAlpha;
        this.root.rotation.y = this.currentHeading;

        // ---- Smooth pull-aside offset ----------------------------------
        const paAlpha = 1 - Math.exp(-dt / PULL_ASIDE_TIME);
        this.pullAside += (this.pullAsideTarget - this.pullAside) * paAlpha;

        // Apply as a lateral offset perpendicular to the car's heading.
        // Perpendicular in Three.js world: (sin(h), 0, cos(h)) rotated 90°.
        const px = Math.cos(this.currentHeading) * this.pullAside;
        const pz = -Math.sin(this.currentHeading) * this.pullAside;

        // ---- Smooth position -------------------------------------------
        const posAlpha = 1 - Math.exp(-dt / SMOOTH_TIME);
        this.root.position.x += (this.targetPos.x + px - this.root.position.x) * posAlpha;
        this.root.position.z += (this.targetPos.z + pz - this.root.position.z) * posAlpha;
        this.root.position.y += (this.targetPos.y + this.yJitter - this.root.position.y) * posAlpha;

        // ---- Taillight pulse while stopped -----------------------------
        const stopped = (this.frame?.speed ?? 0) < 0.5;
        this.tail1.material = stopped ? this.tail1.material : this.tail1.material;
        // We could swap materials, but shared materials mean it would affect
        // every car. Skip for now; keep the API in place for a future pass.
    }

    isFleeing() {
        return (this.frame?.emergency_nearby === true);
    }

    dispose() {
        this.frame = null;
        this.previous = null;
        // Geometries and materials are shared, nothing to dispose here.
    }
}

// ---------------------------------------------------------------------------
// Shared geometry
// ---------------------------------------------------------------------------

function makeSharedGeometries() {
    return {
        body:  new THREE.BoxGeometry(CAR_WIDTH, CAR_HEIGHT, CAR_LENGTH),
        cabin: new THREE.BoxGeometry(CAR_WIDTH * 0.78, CAR_HEIGHT * 0.7, CAR_LENGTH * 0.42),
        light: new THREE.SphereGeometry(0.10, 6, 6),
    };
}

// ---------------------------------------------------------------------------
// Palette materials — one per body colour
// ---------------------------------------------------------------------------

function makePaletteMaterials() {
    // Emissive-lite car paint: matte, dark, no reflections. Reads well
    // against the dark navy roads without competing with the ambulances.
    const byColor = {};

    const palette = [
        '#c8cdd6', '#8a97a8', '#5c6b7d', '#b7c2cc',
        '#7a8a9c', '#a8b5c2', '#4d5866', '#a8443c',
        '#3d6183', '#6b7d4d',
    ];

    for (const hex of palette) {
        byColor[hex] = new THREE.MeshStandardMaterial({
            color: hex,
            roughness: 0.75,
            metalness: 0.15,
        });
    }

    const defaultMat = new THREE.MeshStandardMaterial({
        color: '#8899aa',
        roughness: 0.75,
        metalness: 0.15,
    });

    const cabinMat = new THREE.MeshStandardMaterial({
        color: '#0d1117',
        roughness: 0.35,
        metalness: 0.5,
        transparent: true,
        opacity: 0.9,
    });

    const headlightMat = new THREE.MeshBasicMaterial({
        color: HEADLIGHT_COLOR,
        toneMapped: false,
    });

    const taillightMat = new THREE.MeshBasicMaterial({
        color: TAILLIGHT_COLOR,
        toneMapped: false,
    });

    return {
        byColor,
        default: defaultMat,
        cabin: cabinMat,
        headlight: headlightMat,
        taillight: taillightMat,
    };
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function shortestAngle(from, to) {
    let d = (to - from) % (Math.PI * 2);
    if (d >  Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
}