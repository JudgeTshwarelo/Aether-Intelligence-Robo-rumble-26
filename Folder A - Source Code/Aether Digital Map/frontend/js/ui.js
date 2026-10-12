// frontend/js/ui.js
// ---------------------------------------------------------------------------
// AETHER — UI controller.
//
// Owns:
//   • location picker (populated by main.js, read on change)
//   • toggle buttons (view / holo / pause / speed)
//   • stats bar (sim time, asset counts, FPS)
//   • minimap canvas (draws city roads + actors + camera target)
//   • selection panel (inspect entities via raycast)
//   • FPV camera mode (WASD + drag look, ESC to exit)
//   • floating city labels projected onto screen
//
// Does NOT own:
//   • emergency panel content (emergency.js fills #emergency-panel)
//   • the WebSocket (main.js)
//   • the render loop (digital-twin.js)
// ---------------------------------------------------------------------------

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Module-level DOM singletons. We grab them once because there's only ever
// one UI in the page and it saves re-querying in every method.
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const els = {
    // Toggles
    viewBtn:   $('toggle-view'),
    holoBtn:   $('toggle-holo'),
    pauseBtn:  $('toggle-pause'),
    speedBtn:  $('toggle-speed'),

    // HUD
    eyebrow:   $('hud-eyebrow'),
    headline:  $('hud-headline'),
    summary:   $('status-summary'),

    // Stats bar
    statTime:  $('stat-time'),
    statAmb:   $('stat-ambulances'),
    statDrn:   $('stat-drones'),
    statAct:   $('stat-active'),
    statFps:   $('stat-fps'),

    // Minimap
    minimap:   $('minimap'),
    minimapZoom: $('minimap-zoom'),
    minimapCoords: $('minimap-coords'),

    // Selection
    selection: $('selection-panel'),

    // Hints
    orbitHint: $('orbit-hint'),
    fpvHint:   $('fpv-hint'),

    // City label layer
    labels:    $('city-labels'),
};

// ---------------------------------------------------------------------------
// UI class
// ---------------------------------------------------------------------------
export class UI {
    /**
     * @param {import('./digital-twin.js').DigitalTwin} twin
     * @param {object} [callbacks]
     * @param {(enabled:boolean)=>void} [callbacks.onToggleHolo]
     * @param {(paused:boolean)=>void}  [callbacks.onTogglePause]
     * @param {(speed:number)=>void}    [callbacks.onCycleSpeed]
     * @param {(mode:string)=>void}     [callbacks.onToggleView]
     */
    constructor(twin, callbacks = {}) {
        this.twin = twin;
        this.callbacks = callbacks;

        // ---- Selection state --------------------------------------------
        this.selected = null;        // { kind:'actor'|'building', id, data }
        this.onFollowChanged = null; // kept for backwards compat
        this.onFollowToggle  = null; // preferred: main.js subscribes here

        // ---- Actor sources (set by main.js) -----------------------------
        // These let inspectAt() raycast against live actors, not just the
        // static city. Each must expose `.group` (a THREE.Group) and a
        // `.getById(id)` method.
        this.ambulances = null;
        this.drones     = null;
        this.cars       = null;

        // ---- Follow state (mirrors twin state for UI rendering) ---------
        this._followingId = null;

        // ---- FPV state --------------------------------------------------
        this.viewMode = 'world';     // 'world' | 'fpv'
        this.fpv = {
            yaw: 0,
            pitch: 0,
            keys: new Set(),
            pointerId: null,
            lastX: 0,
            lastY: 0,
            savedCamera: null,
        };

        // ---- Minimap ----------------------------------------------------
        this.minimapCtx = els.minimap ? els.minimap.getContext('2d') : null;
        this._minimapAccum = 0;
        this._minimapInterval = 1 / 20;      // 20 Hz redraw

        // ---- FPS smoothing ---------------------------------------------
        this._fps = 0;

        // ---- Bounds for minimap (set on city change) --------------------
        this.bounds = null;

        // ---- Registered actors for minimap dots -------------------------
        // Each entry: { kind, id, x, z, color, size }
        this._markers = [];

        // ---- Projection helpers -----------------------------------------
        this._v = new THREE.Vector3();

        // Bind instance methods used by listeners
        this._onResize      = this._onResize.bind(this);
        this._onPointerDown = this._onPointerDown.bind(this);
        this._onPointerMove = this._onPointerMove.bind(this);
        this._onPointerUp   = this._onPointerUp.bind(this);
        this._onKeyDown     = this._onKeyDown.bind(this);
        this._onKeyUp       = this._onKeyUp.bind(this);
        this._onEscape      = this._onEscape.bind(this);
    }

    // =======================================================================
    // Attach / detach
    // =======================================================================

    attach() {
        // Toggles
        els.holoBtn?.addEventListener('click', () => this._toggleHolo());
        els.pauseBtn?.addEventListener('click', () => this._togglePause());
        els.speedBtn?.addEventListener('click', () => this._cycleSpeed());
        els.viewBtn?.addEventListener('click', () => this._toggleView());

        // Selection panel close (delegated)
        els.selection?.addEventListener('click', (e) => {
            if (e.target.classList.contains('close-button')) this.clearSelection();
        });

        // FPV input
        const canvas = this.twin.getRenderer().domElement;
        canvas.addEventListener('pointerdown', this._onPointerDown);
        canvas.addEventListener('pointermove', this._onPointerMove);
        canvas.addEventListener('pointerup',   this._onPointerUp);
        canvas.addEventListener('pointercancel', this._onPointerUp);
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup',   this._onKeyUp);
        window.addEventListener('blur',    () => this.fpv.keys.clear());
        window.addEventListener('resize',  this._onResize);

        // Global Escape handler: exits FPV or unfollows the chase cam.
        window.addEventListener('keydown', this._onEscape);

        // First paint of toggles
        this._syncToggles();

        // Hook into twin's render loop for FPV + label projection
        this._hookRenderLoop();
    }

    detach() {
        const canvas = this.twin.getRenderer().domElement;
        canvas.removeEventListener('pointerdown', this._onPointerDown);
        canvas.removeEventListener('pointermove', this._onPointerMove);
        canvas.removeEventListener('pointerup',   this._onPointerUp);
        canvas.removeEventListener('pointercancel', this._onPointerUp);
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup',   this._onKeyUp);
        window.removeEventListener('resize',  this._onResize);
        window.removeEventListener('keydown', this._onEscape);
    }

    // =======================================================================
    // Actor wiring — main.js calls this after constructing all actor systems
    // =======================================================================

    /**
     * Give the UI references to the actor systems so click-to-inspect can
     * raycast against moving vehicles, not just the static city.
     *
     * @param {object} sources
     * @param {object} [sources.ambulances]
     * @param {object} [sources.drones]
     * @param {object} [sources.cars]
     */
    attachActors({ ambulances, drones, cars } = {}) {
        if (ambulances) this.ambulances = ambulances;
        if (drones)     this.drones     = drones;
        if (cars)       this.cars       = cars;
    }

    // =======================================================================
    // Static helpers — safe to call from anywhere (main.js uses them)
    // =======================================================================

    static setFps(fps) {
        if (!els.statFps) return;
        els.statFps.textContent = String(Math.max(0, Math.round(fps)));
    }

    static setSimTime(seconds) {
        if (!els.statTime) return;
        const m = Math.floor(seconds / 60).toString().padStart(2, '0');
        const s = Math.floor(seconds % 60).toString().padStart(2, '0');
        const d = Math.floor((seconds * 10) % 10);
        els.statTime.textContent = `${m}:${s}.${d}`;
    }

    static setAssetCounts(ambulances, drones, activeEmergencies) {
        if (els.statAmb) els.statAmb.textContent = String(ambulances);
        if (els.statDrn) els.statDrn.textContent = String(drones);
        if (els.statAct) els.statAct.textContent = String(activeEmergencies);
    }

    static setMinimapCoords(x, z, zoom) {
        if (els.minimapCoords) {
            els.minimapCoords.textContent = `X ${Math.round(x)} · Z ${Math.round(z)}`;
        }
        if (els.minimapZoom) {
            els.minimapZoom.textContent = `${Math.max(1, Math.round(zoom))}×`;
        }
    }

    // =======================================================================
    // City change — main.js calls this after a successful load
    // =======================================================================

    onCityChanged(cityLoader) {
        this.cityLoader = cityLoader;
        this.bounds = cityLoader.getBounds();
        this.clearSelection();
        this._renderCityLabels(cityLoader);
    }

    // =======================================================================
    // Toggles
    // =======================================================================

    _toggleHolo() {
        const next = !(els.holoBtn?.classList.contains('active'));
        els.holoBtn?.classList.toggle('active', next);
        this.callbacks.onToggleHolo?.(next);
        this.twin.setRenderMode(next ? 'holo' : 'real');
    }

    _togglePause() {
        const next = !(els.pauseBtn?.classList.contains('active'));
        els.pauseBtn?.classList.toggle('active', next);
        if (els.pauseBtn) els.pauseBtn.textContent = next ? '▶ RESUME' : '⏸ PAUSE';
        this.callbacks.onTogglePause?.(next);
        this.twin.setPaused(next);
    }

    _cycleSpeed() {
        const cycle = [1, 2, 4, 0.5];
        const current = this.twin.getSpeed();
        const idx = cycle.indexOf(current);
        const next = cycle[(idx + 1) % cycle.length];
        if (els.speedBtn) {
            els.speedBtn.textContent = `SPEED ${next}×`;
            els.speedBtn.classList.toggle('active', next !== 1);
        }
        this.callbacks.onCycleSpeed?.(next);
        this.twin.setSpeed(next);
    }

    _toggleView() {
        if (this.viewMode === 'fpv') this._leaveFpv();
        else                          this._enterFpv();
        this._syncToggles();
        this.callbacks.onToggleView?.(this.viewMode);
    }

    _syncToggles() {
        if (els.viewBtn) {
            els.viewBtn.textContent = this.viewMode === 'fpv' ? 'EXIT FPV' : 'WORLD VIEW';
            els.viewBtn.classList.toggle('active', this.viewMode === 'fpv');
        }
        if (els.orbitHint) els.orbitHint.hidden = this.viewMode === 'fpv';
        if (els.fpvHint)   els.fpvHint.hidden   = this.viewMode !== 'fpv';
    }

    // =======================================================================
    // FPV camera
    // =======================================================================

    _enterFpv() {
        const camera = this.twin.getCamera();
        const controls = this.twin.getControls();

        // Remember where we were.
        this.fpv.savedCamera = {
            position: camera.position.clone(),
            quaternion: camera.quaternion.clone(),
            fov: camera.fov,
            target: controls.target.clone(),
        };

        // Point the camera forward from wherever it is now.
        const dir = controls.target.clone().sub(camera.position);
        const horiz = Math.hypot(dir.x, dir.z);
        this.fpv.yaw = Math.atan2(-dir.x, -dir.z);
        this.fpv.pitch = Math.atan2(dir.y, horiz || 1);

        camera.position.y = Math.max(1.7, camera.position.y);
        camera.fov = 70;
        camera.updateProjectionMatrix();
        camera.rotation.order = 'YXZ';
        camera.rotation.set(this.fpv.pitch, this.fpv.yaw, 0);

        controls.enabled = false;
        this.viewMode = 'fpv';
    }

    _leaveFpv() {
        const camera = this.twin.getCamera();
        const controls = this.twin.getControls();
        const saved = this.fpv.savedCamera;

        if (saved) {
            camera.position.copy(saved.position);
            camera.quaternion.copy(saved.quaternion);
            camera.fov = saved.fov;
            camera.updateProjectionMatrix();
            controls.target.copy(saved.target);
        }
        controls.enabled = true;
        this.fpv.keys.clear();
        this.fpv.pointerId = null;
        controls.update();
        this.viewMode = 'world';
    }

    _onPointerDown(e) {
        if (e.button !== 0) return;
        this._pointerDownAt = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };

        if (this.viewMode === 'fpv') {
            this.fpv.pointerId = e.pointerId;
            this.fpv.lastX = e.clientX;
            this.fpv.lastY = e.clientY;
            e.target.setPointerCapture?.(e.pointerId);
            e.preventDefault();
        }
    }

    _onPointerMove(e) {
        const p = this._pointerDownAt;
        if (p && p.id === e.pointerId) {
            if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) p.moved = true;
        }

        if (this.viewMode !== 'fpv') return;
        if (this.fpv.pointerId !== e.pointerId) return;

        const dx = e.clientX - this.fpv.lastX;
        const dy = e.clientY - this.fpv.lastY;
        this.fpv.lastX = e.clientX;
        this.fpv.lastY = e.clientY;

        this.fpv.yaw   -= dx * 0.003;
        this.fpv.pitch = THREE.MathUtils.clamp(
            this.fpv.pitch - dy * 0.003,
            -Math.PI * 0.472,
             Math.PI * 0.472
        );
        this.twin.getCamera().rotation.set(this.fpv.pitch, this.fpv.yaw, 0);
    }

    _onPointerUp(e) {
        const p = this._pointerDownAt;
        if (p && p.id === e.pointerId && !p.moved && this.viewMode !== 'fpv') {
            this.inspectAt(e.clientX, e.clientY);
        }
        this._pointerDownAt = null;

        if (this.fpv.pointerId === e.pointerId) this.fpv.pointerId = null;
    }

    _onKeyDown(e) {
        if (this.viewMode !== 'fpv') return;
        const key = e.key.toLowerCase();

        if (key === 'escape') {
            this._leaveFpv();
            this._syncToggles();
            return;
        }
        if (MOVEMENT_KEYS.has(key)) {
            this.fpv.keys.add(key);
            e.preventDefault();
        }
    }

    _onKeyUp(e) {
        this.fpv.keys.delete(e.key.toLowerCase());
    }

    /**
     * Global Escape handler — separate from the FPV keydown so it works in
     * world mode too. Exits FPV first if we're in it, otherwise unfollows
     * the chase cam.
     */
    _onEscape(e) {
        if (e.key !== 'Escape') return;

        // FPV already handles its own escape; don't double-fire.
        if (this.viewMode === 'fpv') return;

        if (this.twin.isFollowing?.()) {
            this.twin.unfollowActor?.();
            this._followingId = null;
            // Re-render the panel so the button reflects the new state.
            if (this.selected?.kind === 'actor') {
                this._renderSelectionPanel();
            }
        }
    }

    _updateFpv(dt) {
        const k = this.fpv.keys;
        const fwd    = Number(k.has('w') || k.has('arrowup'))    - Number(k.has('s') || k.has('arrowdown'));
        const strafe = Number(k.has('d') || k.has('arrowright')) - Number(k.has('a') || k.has('arrowleft'));
        if (!fwd && !strafe) return;

        const sin = Math.sin(this.fpv.yaw);
        const cos = Math.cos(this.fpv.yaw);

        const move = new THREE.Vector3(
            -sin * fwd - cos * strafe,
            0,
            -cos * fwd + sin * strafe
        );
        move.normalize().multiplyScalar(32 * dt);

        const camera = this.twin.getCamera();
        camera.position.add(move);
        camera.position.y = 1.7;
    }

    // =======================================================================
    // Render loop hook
    // =======================================================================

    _hookRenderLoop() {
        // We piggyback on the twin's animation by polling in a rAF loop of
        // our own. Cheap and keeps digital-twin.js free of UI concerns.
        let last = performance.now();
        const loop = () => {
            const now = performance.now();
            const dt = Math.min(0.1, (now - last) / 1000);
            last = now;

            if (this.viewMode === 'fpv') this._updateFpv(dt);

            this._minimapAccum += dt;
            if (this._minimapAccum >= this._minimapInterval) {
                this._minimapAccum = 0;
                this._drawMinimap();
                this._projectCityLabels();
            }

            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }

    // =======================================================================
    // Selection
    // =======================================================================

    inspectAt(clientX, clientY) {
        const renderer = this.twin.getRenderer();
        const camera = this.twin.getCamera();
        const rect = renderer.domElement.getBoundingClientRect();

        const ndc = new THREE.Vector2(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, camera);

        // Test actors first — they're usually small and on top of the city,
        // and the user's intent when clicking near a car is "the car".
        const actorHits = this._raycastActors(raycaster);
        if (actorHits.length) {
            const actor = actorHits[0];
            this.showActor(actor);
            return;
        }

        // Then test the static city — buildings only.
        const roots = [];
        if (this.cityLoader?.currentCity) roots.push(this.cityLoader.currentCity);

        const hits = raycaster.intersectObjects(roots, true);
        if (!hits.length) { this.clearSelection(); return; }

        // Walk up to find a mesh with a userData.kind
        let obj = hits[0].object;
        while (obj && !obj.userData?.kind) obj = obj.parent;

        if (!obj) { this.clearSelection(); return; }

        if (obj.userData.kind === 'building') {
            this.showBuilding(obj.userData);
        } else {
            this.clearSelection();
        }
    }

    /**
     * Raycast against every actor group and return the closest actor whose
     * mesh was hit. Returned objects are the live actor instances
     * (AmbulanceActor / DroneActor / CarActor), not the meshes.
     */
    _raycastActors(raycaster) {
        const groups = [];
        if (this.ambulances?.group) groups.push(['ambulance', this.ambulances]);
        if (this.drones?.group)     groups.push(['drone',     this.drones]);
        if (this.cars?.group)       groups.push(['car',       this.cars]);

        if (!groups.length) return [];

        const hits = [];
        for (const [kind, system] of groups) {
            const intersections = raycaster.intersectObjects(
                system.group.children, true
            );
            if (!intersections.length) continue;

            // Walk up from the first hit mesh to find its actor group, then
            // look up the actor instance by id.
            let node = intersections[0].object;
            while (node && !node.userData?.kind) node = node.parent;
            if (!node?.userData?.id) continue;

            const actor = system.getById?.(node.userData.id);
            if (actor) {
                hits.push({ actor, distance: intersections[0].distance, kind });
            }
        }

        hits.sort((a, b) => a.distance - b.distance);
        return hits.map((h) => h.actor);
    }

    showBuilding(data) {
        this.selected = { kind: 'building', id: data.id, data };
        this._renderSelectionPanel();
    }

    showActor(actor) {
        this.selected = { kind: 'actor', id: actor.id, data: actor };
        this._renderSelectionPanel();
    }

    clearSelection() {
        this.selected = null;
        if (els.selection) {
            els.selection.hidden = true;
            els.selection.innerHTML = '';
        }
    }

    _renderSelectionPanel() {
        if (!els.selection) return;

        if (!this.selected) {
            els.selection.hidden = true;
            els.selection.innerHTML = '';
            return;
        }

        const { kind, id, data } = this.selected;
        const panel = document.createElement('div');
        panel.className = 'panel-card';

        const header = document.createElement('div');
        header.className = 'panel-header';
        header.innerHTML = `
            <div>
                <div class="panel-subtitle">ENTITY · ${kind.toUpperCase()}</div>
                <div class="entity-id">${escapeHtml(String(id))}</div>
            </div>
            <button class="close-button" type="button">✕</button>`;
        panel.appendChild(header);

        if (kind === 'building') {
            for (const [k, v] of Object.entries(data)) {
                if (k === 'kind' || k === 'id') continue;
                panel.appendChild(this._row(k, String(v)));
            }
        } else if (kind === 'actor') {
            const fields = this._actorFields(data);
            for (const [k, v] of fields) {
                if (v != null) panel.appendChild(this._row(k, v));
            }

            const isFollowing = this._followingId === id;

            const followBtn = document.createElement('button');
            followBtn.type = 'button';
            followBtn.className = `follow-button${isFollowing ? ' following' : ''}`;
            followBtn.textContent = isFollowing
                ? '● FOLLOWING · CLICK TO RELEASE'
                : '◎ FOLLOW CAMERA';

            followBtn.onclick = () => {
                const nowFollowing = !isFollowing;

                // Update our own state first so the re-render is consistent.
                this._followingId = nowFollowing ? id : null;

                // Prefer the new callback, fall back to the old one.
                if (this.onFollowToggle) {
                    this.onFollowToggle(this._followingId, data);
                } else if (this.onFollowChanged) {
                    this.onFollowChanged(this._followingId);
                }

                this._renderSelectionPanel();
            };

            panel.appendChild(followBtn);
        }

        els.selection.innerHTML = '';
        els.selection.appendChild(panel);
        els.selection.hidden = false;

        // Attach close handler
        panel.querySelector('.close-button')?.addEventListener('click',
            () => this.clearSelection());
    }

    /**
     * Extract displayable fields from an actor instance. Amb/Drones/Cars
     * expose different attributes, so this normalises them.
     */
    _actorFields(actor) {
        // AmbulanceActor / DroneActor / CarActor hold their state in .frame
        // (the latest backend record) and expose .root.
        const f = actor.frame || {};

        const rows = [
            ['TYPE',   (f.kind || 'actor').toUpperCase()],
            ['STATUS', f.status ?? '—'],
            ['SPEED',  typeof f.speed === 'number' ? `${f.speed.toFixed(1)} m/s` : '—'],
            ['LAT',    typeof f.lat === 'number' ? f.lat.toFixed(5) : '—'],
            ['LON',    typeof f.lon === 'number' ? f.lon.toFixed(5) : '—'],
            ['HEADING', typeof f.heading === 'number'
                ? `${(f.heading * 180 / Math.PI).toFixed(0)}°`
                : '—'],
        ];

        if (typeof f.altitude === 'number') {
            rows.push(['ALTITUDE', `${f.altitude.toFixed(1)} m`]);
        }

        return rows;
    }

    _row(label, value) {
        const row = document.createElement('div');
        row.className = 'data-row';
        const l = document.createElement('span');
        l.className = 'data-label';
        l.textContent = label;
        const v = document.createElement('span');
        v.className = 'data-value';
        v.textContent = value;
        row.append(l, v);
        return row;
    }

    // =======================================================================
    // City labels (HTML overlay projected onto screen)
    // =======================================================================

    _renderCityLabels(cityLoader) {
        if (!els.labels) return;
        els.labels.innerHTML = '';

        const meta = cityLoader.meta;
        if (!meta) return;

        // Create one label per loaded city — currently just one.
        const el = document.createElement('div');
        el.className = 'city-label';
        el.textContent = (meta.name || meta.id || '').toUpperCase();
        el.dataset.city = meta.id;
        els.labels.appendChild(el);

        // The label sits at scene origin (0, y, 0) because urban:EXPORT
        // centres the model on the selected area.
        this._labelRefs = [{
            el,
            worldPos: new THREE.Vector3(0, 40, 0),
        }];
    }

    _projectCityLabels() {
        if (!this._labelRefs?.length) return;

        const camera = this.twin.getCamera();
        const renderer = this.twin.getRenderer();
        const canvas = renderer.domElement;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;

        for (const ref of this._labelRefs) {
            this._v.copy(ref.worldPos).project(camera);

            const inFront = this._v.z > -1 && this._v.z < 1;
            const x = ( this._v.x * 0.5 + 0.5) * w;
            const y = (-this._v.y * 0.5 + 0.5) * h;

            if (!inFront) {
                ref.el.classList.add('hidden');
                continue;
            }
            ref.el.classList.remove('hidden');
            ref.el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
        }
    }

    // =======================================================================
    // Minimap
    // =======================================================================

    /** Called by ambulances/drones each frame (or on city change). */
    setMarkers(markers) {
        this._markers = markers || [];
    }

    _drawMinimap() {
        if (!this.minimapCtx || !this.bounds) return;

        const ctx  = this.minimapCtx;
        const size = els.minimap.width;

        ctx.clearRect(0, 0, size, size);
        ctx.fillStyle = 'rgba(4, 7, 13, 0.9)';
        ctx.fillRect(0, 0, size, size);
        ctx.strokeStyle = 'rgba(57, 255, 216, 0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, size - 1, size - 1);

        // World → minimap
        const b = this.bounds;
        const cx = (b.min.x + b.max.x) / 2;
        const cz = (b.min.z + b.max.z) / 2;
        const span = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) || 1;
        const pad = 6;
        const scale = (size - pad * 2) / span;

        const toMini = (x, z) => ({
            mx: (x - cx) * scale + size / 2,
            my: (z - cz) * scale + size / 2,
        });

        // Roads — thin cyan lines
        if (this.cityLoader) {
            const roads = this.cityLoader.getRoadMeshes();
            ctx.strokeStyle = 'rgba(57, 255, 216, 0.35)';
            ctx.lineWidth = 0.6;
            for (const mesh of roads) {
                if (!mesh.geometry?.boundingBox) mesh.geometry?.computeBoundingBox?.();
                const bb = mesh.geometry?.boundingBox;
                if (!bb) continue;

                // Draw as the XY footprint of the mesh's bounding box.
                // Cheap, fast, and readable at minimap scale.
                const corners = [
                    new THREE.Vector3(bb.min.x, 0, bb.min.z),
                    new THREE.Vector3(bb.max.x, 0, bb.max.z),
                ].map((p) => p.applyMatrix4(mesh.matrixWorld));

                const p1 = toMini(corners[0].x, corners[0].z);
                const p2 = toMini(corners[1].x, corners[1].z);
                ctx.strokeRect(
                    Math.min(p1.mx, p2.mx), Math.min(p1.my, p2.my),
                    Math.abs(p2.mx - p1.mx), Math.abs(p2.my - p1.my)
                );
            }

            // Buildings — small filled squares
            const buildings = this.cityLoader.getBuildingMeshes();
            ctx.fillStyle = 'rgba(58, 124, 168, 0.55)';
            for (const mesh of buildings) {
                if (!mesh.geometry?.boundingBox) mesh.geometry?.computeBoundingBox?.();
                const bb = mesh.geometry?.boundingBox;
                if (!bb) continue;

                const center = new THREE.Vector3(
                    (bb.min.x + bb.max.x) / 2,
                    0,
                    (bb.min.z + bb.max.z) / 2
                ).applyMatrix4(mesh.matrixWorld);

                const { mx, my } = toMini(center.x, center.z);
                ctx.fillRect(mx - 1, my - 1, 2, 2);
            }
        }

        // Registered markers (ambulances, drones, patient, …)
        for (const m of this._markers) {
            if (typeof m.x !== 'number' || typeof m.z !== 'number') continue;
            const { mx, my } = toMini(m.x, m.z);
            ctx.fillStyle = m.color || '#39ffd8';
            ctx.beginPath();
            ctx.arc(mx, my, m.size || 2.4, 0, Math.PI * 2);
            ctx.fill();
        }

        // Camera target indicator
        const camTarget = this.twin.getControls().target;
        const { mx, my } = toMini(camTarget.x, camTarget.z);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(mx, my, 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(mx - 7, my); ctx.lineTo(mx + 7, my);
        ctx.moveTo(mx, my - 7); ctx.lineTo(mx, my + 7);
        ctx.stroke();
    }

    // =======================================================================
    // Resize
    // =======================================================================

    _onResize() {
        // Minimap canvas is CSS-sized; nothing to do there. The twin handles
        // its own resize. Hook is here so future layouts have a place.
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MOVEMENT_KEYS = new Set([
    'w', 'a', 's', 'd',
    'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
]);

function escapeHtml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}