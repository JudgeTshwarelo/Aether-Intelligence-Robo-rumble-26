// frontend/js/ambulances.js
// ---------------------------------------------------------------------------
// AETHER — Ambulance actor system.
//
// Owns:
//   • the pool of ambulance meshes (created lazily, one per backend id)
//   • GPS → scene conversion + terrain snap
//   • smooth interpolation between backend snapshot frames
//   • response behaviour: drive toward the patient, park, idle
//   • minimap markers via ui.setMarkers()
//
// It does NOT own:
//   • the emergency panel        (emergency.js)
//   • the WebSocket              (main.js)
//   • the UI toggle buttons      (ui.js)
//
// The mesh is deliberately oversized and glowing so it reads as an emergency
// vehicle from 500+ metres up — a real ambulance would be nearly invisible
// against the terrain at that camera distance.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const AMBULANCE_LENGTH  = 8.5;    // metres — oversized for demo visibility
const AMBULANCE_WIDTH   = 3.2;
const AMBULANCE_HEIGHT  = 2.8;
const AMBULANCE_COLOR   = '#e8eef5';   // body
const CABIN_COLOR       = '#0f1c2b';
const LIVERY_COLOR      = '#d92b2b';
const BEACON_COLOR      = '#ff3344';
const BEACON_GLOW_COLOR = '#ff5566';

const CRUISE_SPEED_MS   = 15;      // metres / second (~54 km/h)
const SMOOTH_TIME       = 0.35;    // seconds — lerp window for frame gaps
const ROT_SMOOTH_TIME   = 0.20;

const MARKER_COLOR      = '#39ffd8';
const MARKER_SIZE       = 3.2;

// ---------------------------------------------------------------------------
// Ambulances class
// ---------------------------------------------------------------------------
export class Ambulances {
    /**
     * @param {import('./digital-twin.js').DigitalTwin} twin
     * @param {import('./city-loader.js').CityLoader}   cityLoader
     */
    constructor(twin, cityLoader) {
        this.twin = twin;
        this.cityLoader = cityLoader;

        this.group = new THREE.Group();
        this.group.name = 'ambulances';
        twin.getScene().add(this.group);

        // id → AmbulanceActor
        this.actors = new Map();

        // Emergency id → set of ambulance actor ids responding to it
        this._byEmergency = new Map();

        // Shared geometries — built once.
        this._geo = makeSharedGeometries();
        this._mats = makeSharedMaterials();

        // UI hook — set by main.js
        this.ui = null;

        // Marker payload, refreshed whenever actors move.
        this._markerDirty = true;

        // Per-frame clock for interpolating between backend snapshots.
        this._lastFrameTime = performance.now();
        this._startLoop();
    }

    // =======================================================================
    // Public API — called by main.js / emergency.js
    // =======================================================================

    /** City changed — drop all actors and re-seat the system. */
    onCityChanged(cityLoader) {
        this.cityLoader = cityLoader;

        for (const actor of this.actors.values()) {
            this.group.remove(actor.root);
            actor.dispose();
        }
        this.actors.clear();
        this._byEmergency.clear();
        this._markerDirty = true;
    }

    /**
     * Backend sent a new snapshot of ambulance positions.
     * @param {Array} list  [{ id, lat, lon, heading?, speed?, status? }, ...]
     */
    setFrame(list) {
        if (!Array.isArray(list)) return;

        const seen = new Set();
        for (const rec of list) {
            if (!rec?.id) continue;
            seen.add(rec.id);

            let actor = this.actors.get(rec.id);
            if (!actor) actor = this._spawn(rec.id);
            actor.enqueueFrame(rec);
        }

        // Remove actors the backend no longer reports (they were dismissed).
        for (const id of [...this.actors.keys()]) {
            if (!seen.has(id)) {
                const actor = this.actors.get(id);
                this.group.remove(actor.root);
                actor.dispose();
                this.actors.delete(id);
            }
        }

        this._markerDirty = true;
        this._pushMarkers();
    }

    /** Total count for the stats bar. */
    count() { return this.actors.size; }

    /** Lookup by id — used by emergency.js to compute live ETA. */
    getById(id) { return this.actors.get(id) || null; }

    /**
     * emergency.js tells us to dispatch an ambulance.
     * We may already have an actor for that id (spawned from a snapshot) or
     * we may need to create one on the spot.
     */
    respondTo(patient, { ambulanceId, etaSeconds, hospitalName } = {}) {
        const id = ambulanceId || `AMB-${patient.id}`;
        let actor = this.actors.get(id);
        if (!actor) actor = this._spawn(id);

        actor.task = {
            kind: 'respond',
            patient,
            hospitalName: hospitalName || null,
            etaSeconds: etaSeconds ?? null,
            startedAt: performance.now(),
            emergencyId: patient.id,
        };

        // Track reverse lookup so clearEmergency can find it.
        if (!this._byEmergency.has(patient.id)) {
            this._byEmergency.set(patient.id, new Set());
        }
        this._byEmergency.get(patient.id).add(id);

        this._markerDirty = true;
    }

    /** emergency.js calls this when an emergency resolves. */
    clearEmergency(emergencyId) {
        const set = this._byEmergency.get(emergencyId);
        if (!set) return;

        for (const id of set) {
            const actor = this.actors.get(id);
            if (actor && actor.task?.emergencyId === emergencyId) {
                actor.task = { kind: 'idle' };
            }
        }
        this._byEmergency.delete(emergencyId);
    }

    /**
     * Let the UI raycast pick ambulances. main.js registers the UI with us
     * after construction, and this runs on each pointerup that hit this group.
     */
    attachToUI(ui) {
        this.ui = ui;
    }

    // =======================================================================
    // Spawning
    // =======================================================================

    _spawn(id) {
        const actor = new AmbulanceActor(
            id,
            this._geo,
            this._mats,
            this.cityLoader,
            this.twin.getScene()
        );
        this.group.add(actor.root);
        this.actors.set(id, actor);
        return actor;
    }

    // =======================================================================
    // Render loop — smooths each actor toward its latest frame
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

            // Refresh minimap markers at ~10 Hz, not every frame.
            this._markerAccum = (this._markerAccum || 0) + dt;
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
                kind: 'ambulance',
                id: actor.id,
                x: p.x,
                z: p.z,
                color: actor.isResponding() ? '#ff5566' : MARKER_COLOR,
                size: MARKER_SIZE,
            });
        }
        // ui.setMarkers expects the *union* of all actors. If drones also
        // push markers, they should merge rather than overwrite. For now
        // ambulances push their own, and drones will merge theirs via a
        // shared aggregator in ui.js when we get there.
        this.ui.setMarkers(this.ui._markers.filter(
            (m) => m.kind !== 'ambulance'
        ).concat(markers));
    }
}

// ---------------------------------------------------------------------------
// AmbulanceActor — one mesh, one state machine
// ---------------------------------------------------------------------------
class AmbulanceActor {
    constructor(id, geo, mats, cityLoader, scene) {
        this.id = id;
        this.cityLoader = cityLoader;

        this.root = new THREE.Group();
        this.root.name = `ambulance:${id}`;
        this.root.userData = { kind: 'ambulance', id };

        // ---- Body -------------------------------------------------------
        this.body = new THREE.Mesh(geo.body, mats.body);
        this.body.position.y = AMBULANCE_HEIGHT / 2;
        this.body.userData = { kind: 'ambulance', id };
        this.root.add(this.body);

        // ---- Cabin ------------------------------------------------------
        this.cabin = new THREE.Mesh(geo.cabin, mats.cabin);
        this.cabin.position.set(
            0,
            AMBULANCE_HEIGHT * 0.9,
            AMBULANCE_LENGTH * 0.15
        );
        this.cabin.userData = { kind: 'ambulance', id };
        this.root.add(this.cabin);

        // ---- Red livery stripe -----------------------------------------
        this.livery = new THREE.Mesh(geo.livery, mats.livery);
        this.livery.position.set(
            0,
            AMBULANCE_HEIGHT * 0.45,
            0
        );
        this.root.add(this.livery);

        // ---- Flashing beacon -------------------------------------------
        this.beacon = new THREE.Mesh(geo.beacon, mats.beacon);
        this.beacon.position.set(0, AMBULANCE_HEIGHT + 0.35, AMBULANCE_LENGTH * 0.18);
        this.root.add(this.beacon);

        this.beaconGlow = new THREE.PointLight(
            0xff5566, 0.9, 12, 2
        );
        this.beaconGlow.position.copy(this.beacon.position);
        this.root.add(this.beaconGlow);

        // ---- Wheels ----------------------------------------------------
        this.wheels = [];
        for (const [wx, wz] of [
            [-AMBULANCE_WIDTH / 2 + 0.15,  AMBULANCE_LENGTH / 2 - 0.6],
            [ AMBULANCE_WIDTH / 2 - 0.15,  AMBULANCE_LENGTH / 2 - 0.6],
            [-AMBULANCE_WIDTH / 2 + 0.15, -AMBULANCE_LENGTH / 2 + 0.6],
            [ AMBULANCE_WIDTH / 2 - 0.15, -AMBULANCE_LENGTH / 2 + 0.6],
        ]) {
            const wheel = new THREE.Mesh(geo.wheel, mats.wheel);
            wheel.position.set(wx, 0.35, wz);
            wheel.rotation.z = Math.PI / 2;
            this.root.add(wheel);
            this.wheels.push(wheel);
        }

        // ---- Frame interpolation state ---------------------------------
        this.frame = null;          // latest backend record
        this.previous = null;       // previous backend record
        this.frameReceivedAt = 0;
        this.frameInterval = SMOOTH_TIME;

        // Desired pose — what we lerp toward
        this.targetPos = new THREE.Vector3();
        this.targetHeading = 0;
        this.currentHeading = 0;

        // Set by respondTo / clearEmergency
        this.task = { kind: 'idle' };

        // Client-side prediction when the backend goes quiet
        this.predictedLat = null;
        this.predictedLon = null;
    }

    // -----------------------------------------------------------------------
    // Frame intake
    // -----------------------------------------------------------------------

    enqueueFrame(rec) {
        this.previous = this.frame;
        this.frame = rec;
        this.frameReceivedAt = performance.now();

        if (this.previous) {
            this.frameInterval = Math.max(
                0.05,
                (this.frameReceivedAt - (this._prevFrameAt || this.frameReceivedAt)) / 1000
            );
        }
        this._prevFrameAt = this.frameReceivedAt;

        // Store predicted GPS for client-side motion.
        this.predictedLat = rec.lat;
        this.predictedLon = rec.lon;

        // Compute target pose in scene coordinates.
        this._recomputeTarget();
    }

    _recomputeTarget() {
        if (!this.frame || !this.cityLoader?.meta) return;

        const { x, z } = this.cityLoader.gpsToScene(
            this.frame.lat,
            this.frame.lon
        );
        const y = this.cityLoader.groundY(x, z) ?? 0;

        this.targetPos.set(x, y, z);

        if (typeof this.frame.heading === 'number') {
            this.targetHeading = this.frame.heading;
        } else if (this.previous) {
            const { x: px, z: pz } = this.cityLoader.gpsToScene(
                this.previous.lat,
                this.previous.lon
            );
            const dx = x - px;
            const dz = z - pz;
            if (Math.abs(dx) + Math.abs(dz) > 0.01) {
                this.targetHeading = Math.atan2(dx, dz);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Frame update
    // -----------------------------------------------------------------------

    update(dt, now) {
        // ---- Beacon flash ----------------------------------------------
        const flash = (Math.sin(now * 0.012) + 1) * 0.5;   // 0..1
        this.beacon.material.emissiveIntensity = 0.6 + flash * 3.4;
        this.beaconGlow.intensity = 0.4 + flash * 2.4;

        // ---- Task overrides (respond / idle) --------------------------
        if (this.task.kind === 'respond' && this.task.patient) {
            this._driveTowardsPatient(dt);
        } else {
            this._followBackendFrame(dt);
        }

        // ---- Smooth heading --------------------------------------------
        const dh = shortestAngle(this.currentHeading, this.targetHeading);
        const rotAlpha = 1 - Math.exp(-dt / ROT_SMOOTH_TIME);
        this.currentHeading += dh * rotAlpha;
        this.root.rotation.y = this.currentHeading;

        // ---- Wheel spin -------------------------------------------------
        const speed = this._estimatedSpeed();
        const spin = (speed / 0.35) * dt;
        for (const wheel of this.wheels) wheel.rotation.x += spin;
    }

    // Where the backend says we are, with prediction between frames.
    _followBackendFrame(dt) {
        if (this.predictedLat == null) return;

        // Client-side dead-reckoning: keep sliding in the last known heading
        // at last known speed, so motion looks smooth even between snapshots.
        const speed = this._estimatedSpeed();
        if (speed > 0.1) {
            const rad = this.currentHeading;
            const dLat =  Math.cos(rad) * speed * dt / 110540;
            const dLon =  Math.sin(rad) * speed * dt / (111320 *
                Math.cos(this.predictedLat * Math.PI / 180));
            this.predictedLat += dLat;
            this.predictedLon += dLon;
        }

        const { x, z } = this.cityLoader.gpsToScene(
            this.predictedLat, this.predictedLon
        );
        const y = this.cityLoader.groundY(x, z) ?? 0;

        const alpha = 1 - Math.exp(-dt / SMOOTH_TIME);
        this.root.position.x += (x - this.root.position.x) * alpha;
        this.root.position.z += (z - this.root.position.z) * alpha;
        this.root.position.y = y;
    }

    // When we're tasked with a response, ignore the backend and drive.
    _driveTowardsPatient(dt) {
        const { lat, lon } = this.task.patient;
        if (typeof lat !== 'number' || typeof lon !== 'number') return;

        const target = this.cityLoader.gpsToScene(lat, lon);

        const dx = target.x - this.root.position.x;
        const dz = target.z - this.root.position.z;
        const dist = Math.hypot(dx, dz);

        if (dist < 3) {
            // Arrived — switch to idle; backend frames will resume control.
            this.task = { kind: 'idle' };
            return;
        }

        this.targetHeading = Math.atan2(dx, dz);

        const step = Math.min(dist, CRUISE_SPEED_MS * dt);
        this.root.position.x += (dx / dist) * step;
        this.root.position.z += (dz / dist) * step;

        const y = this.cityLoader.groundY(this.root.position.x, this.root.position.z) ?? 0;
        this.root.position.y = y;
    }

    _estimatedSpeed() {
        if (typeof this.frame?.speed === 'number') return this.frame.speed;
        if (this.task.kind === 'respond') return CRUISE_SPEED_MS * 0.8;
        if (this.frame?.status === 'moving') return CRUISE_SPEED_MS * 0.7;
        return 0;
    }

    isResponding() { return this.task.kind === 'respond'; }

    dispose() {
        this.body.geometry = null;   // shared
        this.body.material = null;   // shared
        // The rest is just references. Let GC handle it.
        this.task = null;
        this.frame = null;
        this.previous = null;
    }
}

// ---------------------------------------------------------------------------
// Shared geometry / materials
// ---------------------------------------------------------------------------

function makeSharedGeometries() {
    return {
        body:    new THREE.BoxGeometry(AMBULANCE_WIDTH, AMBULANCE_HEIGHT, AMBULANCE_LENGTH),
        cabin:   new THREE.BoxGeometry(AMBULANCE_WIDTH * 0.82, AMBULANCE_HEIGHT * 0.55, AMBULANCE_LENGTH * 0.42),
        livery:  new THREE.BoxGeometry(AMBULANCE_WIDTH + 0.02, 0.4, AMBULANCE_LENGTH * 0.85),
        beacon:  new THREE.SphereGeometry(0.28, 12, 12),
        wheel:   new THREE.CylinderGeometry(0.35, 0.35, 0.22, 12),
    };
}

function makeSharedMaterials() {
    // Body glows slightly so the ambulance reads against dark terrain even
    // when it's small on screen. White with a soft emissive pops without
    // looking like a lightbulb.
    const bodyMat = new THREE.MeshStandardMaterial({
        color: AMBULANCE_COLOR,
        roughness: 0.5,
        metalness: 0.2,
        emissive: new THREE.Color('#ffffff'),
        emissiveIntensity: 0.35,
    });

    const cabinMat = new THREE.MeshStandardMaterial({
        color: CABIN_COLOR,
        roughness: 0.35,
        metalness: 0.3,
        transparent: true,
        opacity: 0.9,
    });

    const liveryMat = new THREE.MeshStandardMaterial({
        color: LIVERY_COLOR,
        roughness: 0.6,
        metalness: 0.05,
        emissive: new THREE.Color('#d92b2b'),
        emissiveIntensity: 0.25,
    });

    const beaconMat = new THREE.MeshStandardMaterial({
        color: BEACON_COLOR,
        emissive: BEACON_GLOW_COLOR,
        emissiveIntensity: 3.0,
        roughness: 0.3,
    });

    const wheelMat = new THREE.MeshStandardMaterial({
        color: '#0b0b0d',
        roughness: 0.9,
        metalness: 0.0,
    });

    return {
        body:   bodyMat,
        cabin:  cabinMat,
        livery: liveryMat,
        beacon: beaconMat,
        wheel:  wheelMat,
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