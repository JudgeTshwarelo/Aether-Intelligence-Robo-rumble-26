// frontend/js/drones.js
// ---------------------------------------------------------------------------
// AETHER — Drone actor system.
//
// Same architecture as ambulances.js, with three differences:
//   1. Drones fly at altitude, so we add terrain height + altitude,
//      and they never "drive" — they glide.
//   2. They arrive before the ambulance — a rapid-response scout.
//   3. They hover above the patient rather than parking next to them.
//
// Owns:
//   • the pool of drone meshes
//   • GPS → scene conversion + terrain snap + altitude
//   • smooth interpolation between backend frames
//   • response behaviour: fly to the patient, hover, idle
//   • minimap markers via ui.setMarkers()
//
// Does NOT own:
//   • the emergency panel       (emergency.js)
//   • the WebSocket             (main.js)
//   • the UI toggle buttons     (ui.js)
// ---------------------------------------------------------------------------

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const DRONE_RADIUS     = 0.55;      // body radius
const DRONE_HEIGHT     = 0.22;
const ARM_LENGTH       = 1.1;
const ROTOR_RADIUS     = 0.55;

const BODY_COLOR       = '#101720';
const ARM_COLOR        = '#1a2530';
const ROTOR_COLOR      = '#7a9bb8';
const STRIPE_COLOR     = '#39ffd8';

const CRUISE_ALTITUDE  = 45;        // metres above ground while en route
const HOVER_ALTITUDE   = 18;        // metres above the patient when arrived
const CRUISE_SPEED_MS  = 22;        // faster than an ambulance
const DESCENT_SPEED_MS = 4;

const SMOOTH_TIME      = 0.30;
const ROT_SMOOTH_TIME  = 0.15;
const ARRIVE_RADIUS    = 4;         // metres — horizontal distance to "arrived"
const HOVER_SWITCH_MS  = 900;       // how long the arrival transition takes

const MARKER_COLOR     = '#ffb347';
const MARKER_SIZE      = 2.8;

// ---------------------------------------------------------------------------
// Drones class
// ---------------------------------------------------------------------------
export class Drones {
    /**
     * @param {import('./digital-twin.js').DigitalTwin} twin
     * @param {import('./city-loader.js').CityLoader}   cityLoader
     */
    constructor(twin, cityLoader) {
        this.twin = twin;
        this.cityLoader = cityLoader;

        this.group = new THREE.Group();
        this.group.name = 'drones';
        twin.getScene().add(this.group);

        // id → DroneActor
        this.actors = new Map();

        // Emergency id → set of drone actor ids responding to it
        this._byEmergency = new Map();

        this._geo  = makeSharedGeometries();
        this._mats = makeSharedMaterials();

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
        this._byEmergency.clear();
        this._pushMarkers();
    }

    /**
     * Backend sent a new snapshot of drone positions.
     * @param {Array} list  [{ id, lat, lon, altitude?, heading?, speed?, status? }, ...]
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

        for (const id of [...this.actors.keys()]) {
            if (!seen.has(id)) {
                const actor = this.actors.get(id);
                this.group.remove(actor.root);
                actor.dispose();
                this.actors.delete(id);
            }
        }

        this._pushMarkers();
    }

    count() { return this.actors.size; }

    getById(id) { return this.actors.get(id) || null; }

    /**
     * emergency.js tells us to dispatch a drone.
     * Drones leave immediately and arrive first, hovering above the patient.
     */
    respondTo(patient, { droneId, etaSeconds } = {}) {
        const id = droneId || `DRN-${patient.id}`;
        let actor = this.actors.get(id);
        if (!actor) actor = this._spawn(id);

        actor.task = {
            kind: 'respond',
            patient,
            etaSeconds: etaSeconds ?? null,
            startedAt: performance.now(),
            phase: 'enroute',          // 'enroute' | 'descending' | 'hovering'
            emergencyId: patient.id,
        };

        if (!this._byEmergency.has(patient.id)) {
            this._byEmergency.set(patient.id, new Set());
        }
        this._byEmergency.get(patient.id).add(id);
    }

    clearEmergency(emergencyId) {
        const set = this._byEmergency.get(emergencyId);
        if (!set) return;

        for (const id of set) {
            const actor = this.actors.get(id);
            if (actor && actor.task?.emergencyId === emergencyId) {
                // Return to patrol — backend frames resume control.
                actor.task = { kind: 'idle' };
            }
        }
        this._byEmergency.delete(emergencyId);
    }

    attachToUI(ui) { this.ui = ui; }

    // =======================================================================
    // Spawning
    // =======================================================================

    _spawn(id) {
        const actor = new DroneActor(
            id,
            this._geo,
            this._mats,
            this.cityLoader
        );
        this.group.add(actor.root);
        this.actors.set(id, actor);
        return actor;
    }

    // =======================================================================
    // Render loop
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
                kind: 'drone',
                id: actor.id,
                x: p.x,
                z: p.z,
                color: actor.isResponding() ? '#ff5566' : MARKER_COLOR,
                size: MARKER_SIZE,
            });
        }
        this.ui.setMarkers(
            this.ui._markers
                .filter((m) => m.kind !== 'drone')
                .concat(markers)
        );
    }
}

// ---------------------------------------------------------------------------
// DroneActor — one quadcopter, one state machine
// ---------------------------------------------------------------------------
class DroneActor {
    constructor(id, geo, mats, cityLoader) {
        this.id = id;
        this.cityLoader = cityLoader;

        this.root = new THREE.Group();
        this.root.name = `drone:${id}`;
        this.root.userData = { kind: 'drone', id };

        // ---- Central body ----------------------------------------------
        this.body = new THREE.Mesh(geo.body, mats.body);
        this.body.userData = { kind: 'drone', id };
        this.root.add(this.body);

        // ---- Top stripe (identity, subtle) -----------------------------
        this.stripe = new THREE.Mesh(geo.stripe, mats.stripe);
        this.stripe.position.y = DRONE_HEIGHT * 0.55;
        this.root.add(this.stripe);

        // ---- Arms + rotors --------------------------------------------
        this.rotors = [];
        for (const [ax, az, sign] of [
            [ 1,  1, 1], [-1,  1, -1],
            [ 1, -1, -1], [-1, -1, 1],
        ]) {
            const arm = new THREE.Mesh(geo.arm, mats.arm);
            arm.position.set(ax * ARM_LENGTH * 0.5, 0, az * ARM_LENGTH * 0.5);
            arm.rotation.y = Math.atan2(az, ax);
            this.root.add(arm);

            const rotor = new THREE.Mesh(geo.rotor, mats.rotor);
            rotor.position.set(
                ax * ARM_LENGTH,
                DRONE_HEIGHT * 0.4,
                az * ARM_LENGTH
            );
            this.root.add(rotor);
            this.rotors.push({ mesh: rotor, spin: sign * 55 });
        }

        // ---- Beacon ----------------------------------------------------
        this.beacon = new THREE.PointLight(0x39ffd8, 0.6, 8, 2);
        this.beacon.position.set(0, -0.05, 0);
        this.root.add(this.beacon);

        // ---- State -----------------------------------------------------
        this.frame = null;
        this.previous = null;
        this.frameReceivedAt = 0;

        this.targetPos = new THREE.Vector3();
        this.targetHeading = 0;
        this.currentHeading = 0;
        this.currentAltitude = CRUISE_ALTITUDE;

        this.task = { kind: 'idle' };

        this.predictedLat = null;
        this.predictedLon = null;
        this.predictedAlt = CRUISE_ALTITUDE;

        // Visual bob
        this._bobPhase = Math.random() * Math.PI * 2;
    }

    // -----------------------------------------------------------------------
    // Frame intake
    // -----------------------------------------------------------------------

    enqueueFrame(rec) {
        this.previous = this.frame;
        this.frame = rec;
        this.frameReceivedAt = performance.now();

        this.predictedLat = rec.lat;
        this.predictedLon = rec.lon;
        if (typeof rec.altitude === 'number') this.predictedAlt = rec.altitude;

        this._recomputeTarget();
    }

    _recomputeTarget() {
        if (!this.frame || !this.cityLoader?.meta) return;

        const { x, z } = this.cityLoader.gpsToScene(
            this.frame.lat, this.frame.lon
        );
        const ground = this.cityLoader.groundY(x, z) ?? 0;
        const alt = typeof this.frame.altitude === 'number'
            ? this.frame.altitude
            : CRUISE_ALTITUDE;

        this.targetPos.set(x, ground + alt, z);

        if (typeof this.frame.heading === 'number') {
            this.targetHeading = this.frame.heading;
        }
    }

    // -----------------------------------------------------------------------
    // Frame update
    // -----------------------------------------------------------------------

    update(dt, now) {
        // ---- Rotor spin ------------------------------------------------
        for (const r of this.rotors) r.mesh.rotation.y += r.spin * dt;

        // ---- Beacon pulse ----------------------------------------------
        const pulse = (Math.sin(now * 0.008) + 1) * 0.5;
        this.beacon.intensity = 0.35 + pulse * 0.9;

        // ---- Behaviour -------------------------------------------------
        if (this.task.kind === 'respond' && this.task.patient) {
            this._respondToPatient(dt);
        } else {
            this._followBackendFrame(dt);
        }

        // ---- Hover bob -------------------------------------------------
        const bob = Math.sin(now * 0.003 + this._bobPhase) * 0.15;
        this.body.position.y = bob;
        this.stripe.position.y = DRONE_HEIGHT * 0.55 + bob;

        // ---- Smooth heading --------------------------------------------
        const dh = shortestAngle(this.currentHeading, this.targetHeading);
        const alpha = 1 - Math.exp(-dt / ROT_SMOOTH_TIME);
        this.currentHeading += dh * alpha;
        this.root.rotation.y = this.currentHeading;

        // ---- Gentle body tilt while moving -----------------------------
        const speed = this._estimatedSpeed();
        const tilt = Math.min(speed / CRUISE_SPEED_MS, 1) * 0.18;
        this.root.rotation.x = -tilt * 0.5;
    }

    // Backend-controlled (idle / patrol) — dead-reckon between frames.
    _followBackendFrame(dt) {
        if (this.predictedLat == null) return;

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
        const ground = this.cityLoader.groundY(x, z) ?? 0;
        const y = ground + this.predictedAlt;

        const alpha = 1 - Math.exp(-dt / SMOOTH_TIME);
        this.root.position.x += (x - this.root.position.x) * alpha;
        this.root.position.z += (z - this.root.position.z) * alpha;
        this.root.position.y += (y - this.root.position.y) * alpha;
    }

    // Respond-controlled: fly to the patient, descend, hover.
    _respondToPatient(dt) {
        const { lat, lon } = this.task.patient;
        if (typeof lat !== 'number' || typeof lon !== 'number') return;

        const target = this.cityLoader.gpsToScene(lat, lon);
        const groundAtPatient = this.cityLoader.groundY(target.x, target.z) ?? 0;

        const dx = target.x - this.root.position.x;
        const dz = target.z - this.root.position.z;
        const horizontal = Math.hypot(dx, dz);

        // Heading always points at the patient.
        if (horizontal > 0.5) {
            this.targetHeading = Math.atan2(dx, dz);
        }

        // ---- Phase machine ------------------------------------------
        if (this.task.phase === 'enroute') {
            if (horizontal <= ARRIVE_RADIUS) {
                this.task.phase = 'descending';
                this.task.phaseStart = performance.now();
            } else {
                const step = Math.min(horizontal, CRUISE_SPEED_MS * dt);
                this.root.position.x += (dx / horizontal) * step;
                this.root.position.z += (dz / horizontal) * step;

                const y = groundAtPatient + CRUISE_ALTITUDE;
                const alpha = 1 - Math.exp(-dt / SMOOTH_TIME);
                this.root.position.y += (y - this.root.position.y) * alpha;
                return;
            }
        }

        if (this.task.phase === 'descending') {
            const y = groundAtPatient + HOVER_ALTITUDE;
            const alpha = 1 - Math.exp(-dt / SMOOTH_TIME);
            this.root.position.y += (y - this.root.position.y) * alpha;

            const elapsed = performance.now() - this.task.phaseStart;
            if (elapsed > HOVER_SWITCH_MS) {
                this.task.phase = 'hovering';
            }
            return;
        }

        // hovering
        const y = groundAtPatient + HOVER_ALTITUDE;
        const alpha = 1 - Math.exp(-dt / SMOOTH_TIME);
        this.root.position.y += (y - this.root.position.y) * alpha;

        // Slow circle above the patient
        const t = performance.now() * 0.0008;
        const orbitR = 1.5;
        const tx = target.x + Math.cos(t) * orbitR;
        const tz = target.z + Math.sin(t) * orbitR;
        const alpha2 = 1 - Math.exp(-dt / 0.8);
        this.root.position.x += (tx - this.root.position.x) * alpha2;
        this.root.position.z += (tz - this.root.position.z) * alpha2;
        this.targetHeading = t + Math.PI / 2;
    }

    _estimatedSpeed() {
        if (typeof this.frame?.speed === 'number') return this.frame.speed;
        if (this.task.kind === 'respond' && this.task.phase === 'enroute') {
            return CRUISE_SPEED_MS * 0.9;
        }
        return 0;
    }

    isResponding() { return this.task.kind === 'respond'; }

    dispose() {
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
        body:   new THREE.BoxGeometry(
                    DRONE_RADIUS * 2, DRONE_HEIGHT, DRONE_RADIUS * 2
                ),
        stripe: new THREE.BoxGeometry(
                    DRONE_RADIUS * 1.4, 0.03, DRONE_RADIUS * 1.4
                ),
        arm:    new THREE.BoxGeometry(ARM_LENGTH, 0.08, 0.12),
        rotor:  new THREE.CylinderGeometry(
                    ROTOR_RADIUS, ROTOR_RADIUS, 0.03, 16
                ),
    };
}

function makeSharedMaterials() {
    return {
        body:   new THREE.MeshStandardMaterial({
                    color: BODY_COLOR,
                    roughness: 0.6,
                    metalness: 0.4,
                }),
        stripe: new THREE.MeshStandardMaterial({
                    color: STRIPE_COLOR,
                    emissive: STRIPE_COLOR,
                    emissiveIntensity: 1.2,
                    roughness: 0.4,
                }),
        arm:    new THREE.MeshStandardMaterial({
                    color: ARM_COLOR,
                    roughness: 0.7,
                    metalness: 0.3,
                }),
        rotor:  new THREE.MeshStandardMaterial({
                    color: ROTOR_COLOR,
                    roughness: 0.4,
                    metalness: 0.6,
                    transparent: true,
                    opacity: 0.75,
                }),
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