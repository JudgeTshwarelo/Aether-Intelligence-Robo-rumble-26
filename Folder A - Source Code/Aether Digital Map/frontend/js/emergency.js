// frontend/js/emergency.js
// ---------------------------------------------------------------------------
// AETHER — Emergency controller.
//
// Owns:
//   • the #emergency-panel red card in index.html
//   • turning a backend "emergency" frame into a rendered card
//   • the count of currently active emergencies (used by the stats bar)
//   • dispatching to ambulances.js / drones.js to spawn response actors
//   • clearing the card when the backend sends a "resolved" frame
//
// It does NOT own the actors themselves — it tells ambulances/drones what
// to spawn, and lets them own the resulting meshes.
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

// How long the panel stays on screen after resolve, so the judge sees it
// acknowledge the update. Milliseconds.
const RESOLVE_HOLD_MS = 2000;

// ---------------------------------------------------------------------------
// Emergency class
// ---------------------------------------------------------------------------
export class Emergency {
    /**
     * @param {import('./digital-twin.js').DigitalTwin} twin
     * @param {import('./city-loader.js').CityLoader} cityLoader
     * @param {import('./ambulances.js').Ambulances}  ambulances
     * @param {import('./drones.js').Drones}          drones
     */
    constructor(twin, cityLoader, ambulances, drones) {
        this.twin = twin;
        this.cityLoader = cityLoader;
        this.ambulances = ambulances;
        this.drones = drones;

        this.el = $('emergency-panel');

        // id → { patient, assigned, dispatchedAt, resolveAt }
        this.active = new Map();

        // Set by main.js if you want to react to patient selection, etc.
        this.onEmergencyStarted = null;
        this.onEmergencyResolved = null;
    }

    // =======================================================================
    // Public API — main.js / backend frames
    // =======================================================================

    /** Called by main.js when the location changes. Clears stale emergencies. */
    onCityChanged(cityLoader) {
        this.cityLoader = cityLoader;

        // Any emergencies from the previous location are no longer spatial.
        for (const [id, em] of this.active) {
            this._dismiss(em);
            this.active.delete(id);
        }
        this._renderCard();
    }

    /**
     * Called by main.js on the init/snapshot frames with the full list of
     * currently-active patients. Reconciles the local map.
     *
     * @param {Array} patients  [{ id, lat, lon, vitals, priority, ... }]
     */
    setPatients(patients) {
        const incomingIds = new Set();

        for (const p of patients || []) {
            incomingIds.add(p.id);

            if (this.active.has(p.id)) {
                // Update patient fields on the existing emergency.
                this.active.get(p.id).patient = p;
            } else {
                // A new patient appeared in a snapshot — treat as a soft
                // start (no audio, no fly-in; the backend frame carries it).
                this._start(p, null, { quiet: true });
            }
        }

        // Anything we have that the backend no longer lists → resolved.
        for (const [id, em] of [...this.active]) {
            if (!incomingIds.has(id)) {
                this._resolve(id);
            }
        }

        this._renderCard();
    }

    /**
     * Called by main.js on an `emergency` frame. This is the loud version —
     * a new emergency has been detected, and the backend has already
     * assigned assets to respond.
     *
     * @param {object} patient   the patient record (id, lat, lon, vitals, …)
     * @param {object} assigned  { ambulanceId, droneId?, etaSeconds, hospitalName? }
     */
    trigger(patient, assigned) {
        if (!patient?.id) return;

        const existing = this.active.get(patient.id);
        if (existing) {
            existing.assigned = assigned || existing.assigned;
        } else {
            this._start(patient, assigned, { quiet: false });
        }

        this._renderCard();

        // Fire-and-forget: tell the actors to spawn a response.
        this._dispatchToActors(patient, assigned);
    }

    /** Number of currently-active emergencies (stats bar). */
    activeCount() { return this.active.size; }

    // =======================================================================
    // Internals
    // =======================================================================

    _start(patient, assigned, { quiet = false } = {}) {
        const em = {
            id: patient.id,
            patient,
            assigned: assigned || null,
            startedAt: performance.now(),
            resolveAt: null,
            quiet,
        };
        this.active.set(patient.id, em);

        // Optional hook — lets a future "emergency feed" panel subscribe.
        this.onEmergencyStarted?.(em);
    }

    _resolve(id) {
        const em = this.active.get(id);
        if (!em) return;

        em.resolveAt = performance.now();
        em.status = 'resolved';

        // Hold on screen for a beat, then remove.
        setTimeout(() => {
            this._dismiss(em);
            this.active.delete(id);
            this._renderCard();
        }, RESOLVE_HOLD_MS);

        this.onEmergencyResolved?.(em);
    }

    _dismiss(em) {
        if (!em) return;
        // If we told actors to spawn a response, tell them to stand down.
        if (!em.quiet) {
            this.ambulances?.clearEmergency?.(em.id);
            this.drones?.clearEmergency?.(em.id);
        }
    }

    /**
     * Ask the actor modules to spawn response units. Each module owns its
     * own mesh creation and pathing; this file just delivers the request.
     */
    _dispatchToActors(patient, assigned) {
        if (!assigned) return;

        if (assigned.ambulanceId) {
            this.ambulances?.respondTo?.(patient, {
                ambulanceId: assigned.ambulanceId,
                etaSeconds:  assigned.etaSeconds,
                hospitalName: assigned.hospitalName,
            });
        }

        if (assigned.droneId) {
            this.drones?.respondTo?.(patient, {
                droneId: assigned.droneId,
                etaSeconds: assigned.etaSeconds,
            });
        }
    }

    // =======================================================================
    // Panel rendering
    // =======================================================================

    _renderCard() {
        if (!this.el) return;

        if (this.active.size === 0) {
            this.el.hidden = true;
            this.el.innerHTML = '';
            return;
        }

        // Pick the most recent active emergency to display. If you later
        // want a list, replace this with a loop and render a card per item.
        const list = [...this.active.values()].filter((e) => !e.resolveAt);
        const em = (list.length ? list : [...this.active.values()])[0];
        if (!em) { this.el.hidden = true; return; }

        const p = em.patient || {};
        const v = p.vitals || {};

        const hr       = v.heartRate   ?? v.hr   ?? '—';
        const spo2     = v.spo2        ?? v.oxygen ?? '—';
        const priority = (p.priority || em.assigned?.priority || 'unknown').toUpperCase();

        const etaSec   = em.assigned?.etaSeconds;
        const etaStr   = etaSec != null ? formatSeconds(etaSec) : '—';

        const hospital = em.assigned?.hospitalName || '—';
        const ambulanceId = em.assigned?.ambulanceId || '—';

        const resolving = !!em.resolveAt;
        const critical = priority === 'CRITICAL';

        this.el.hidden = false;
        this.el.innerHTML = `
            <div class="ep-head">
                <span class="pulse-dot"></span>
                ${resolving ? 'EMERGENCY RESOLVED' : 'EMERGENCY DETECTED'}
            </div>
            <div class="ep-grid">
                <div class="ep-item">
                    <span class="k">Patient</span>
                    <span class="v">${escapeHtml(String(em.id))}</span>
                </div>
                <div class="ep-item">
                    <span class="k">Priority</span>
                    <span class="v ${critical ? 'critical' : ''}">${escapeHtml(priority)}</span>
                </div>
                <div class="ep-item">
                    <span class="k">Heart Rate</span>
                    <span class="v">${escapeHtml(String(hr))} bpm</span>
                </div>
                <div class="ep-item">
                    <span class="k">SpO₂</span>
                    <span class="v">${escapeHtml(String(spo2))}%</span>
                </div>
                <div class="ep-item">
                    <span class="k">Ambulance</span>
                    <span class="v">${escapeHtml(String(ambulanceId))}</span>
                </div>
                <div class="ep-item">
                    <span class="k">Hospital</span>
                    <span class="v">${escapeHtml(String(hospital))}</span>
                </div>
                <div class="ep-item">
                    <span class="k">ETA</span>
                    <span class="v">${escapeHtml(etaStr)}</span>
                </div>
                <div class="ep-item">
                    <span class="k">Location</span>
                    <span class="v">${formatLatLon(p.lat, p.lon)}</span>
                </div>
            </div>
        `;

        // If we can compute a live ETA from the ambulances' own positions,
        // defer to that — the backend's estimate goes stale between frames.
        if (!resolving && this.ambulances?.getById && em.assigned?.ambulanceId) {
            const amb = this.ambulances.getById(em.assigned.ambulanceId);
            if (amb && this.cityLoader?.meta) {
                const dist = distanceToPatient(amb, p, this.cityLoader);
                const eta = dist != null
                    ? formatSeconds(dist / 15)   // 15 m/s ≈ 54 km/h, urban
                    : etaStr;
                const etaEl = this.el.querySelector('.ep-item:nth-child(7) .v');
                if (etaEl) etaEl.textContent = eta;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSeconds(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '—';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatLatLon(lat, lon) {
    if (typeof lat !== 'number' || typeof lon !== 'number') return '—';
    return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

/**
 * Distance between an actor (with .lat/.lon) and a patient, in metres.
 * Falls back to scene-space distance if one side lacks lat/lon.
 */
function distanceToPatient(actor, patient, cityLoader) {
    if (
        typeof actor.lat === 'number' && typeof actor.lon === 'number' &&
        typeof patient.lat === 'number' && typeof patient.lon === 'number'
    ) {
        return haversine(actor.lat, actor.lon, patient.lat, patient.lon);
    }

    if (actor.position && typeof actor.position.x === 'number' &&
        typeof patient.lat === 'number' && typeof patient.lon === 'number' &&
        cityLoader?.gpsToScene) {
        const p = cityLoader.gpsToScene(patient.lat, patient.lon);
        return Math.hypot(actor.position.x - p.x, actor.position.z - p.z);
    }

    return null;
}

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}9