// frontend/js/digital-twin.js
// ---------------------------------------------------------------------------
// The scene orchestrator. Owns the renderer, scene, camera, controls, lights,
// the ground grid, and the render loop. Knows nothing about cities or actors;
// other modules attach to whatever this exposes.
//
// Rendering modes:
//   • 'real'  → GLB materials render as authored (what urban:EXPORT gives us)
//   • 'holo'  → holographic overlay via materials.js (Aether layer aesthetic)
//
// Chase cam:
//   • followActor(object)  — smooth chase cam behind any Object3D
//   • unfollowActor()      — return to OrbitControls
//
// The HOLO LAYER button in index.html calls setRenderMode('holo' | 'real').
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { OrbitControls }      from 'three/addons/controls/OrbitControls.js';
import { EffectComposer }     from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }         from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass }    from 'three/addons/postprocessing/UnrealBloomPass.js';
import {
    makeHoloGroundMaterial,
    updateHoloTime,
    HOLO,
} from './materials.js';

export class DigitalTwin {
    /**
     * @param {HTMLElement} container  the #viewport element
     * @param {object} [opts]
     * @param {(fps:number) => void} [opts.onFps]
     * @param {(x:number, z:number, zoom:number) => void} [opts.onCameraMove]
     */
    constructor(container, opts = {}) {
        if (!container) throw new Error('DigitalTwin: container element required');

        this.container = container;
        this.onFps = opts.onFps || (() => {});
        this.onCameraMove = opts.onCameraMove || (() => {});

        // ---- Renderer ---------------------------------------------------
        this.renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: false,
            powerPreference: 'high-performance',
        });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(container.clientWidth, container.clientHeight);
        this.renderer.setClearColor(0x05080f, 1);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0;
        container.appendChild(this.renderer.domElement);

        // ---- Scene ------------------------------------------------------
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x05080f);
        this.scene.fog = new THREE.Fog(0x05080f, 1200, 4200);

        // ---- Camera -----------------------------------------------------
        const aspect = container.clientWidth / container.clientHeight;
        this.camera = new THREE.PerspectiveCamera(55, aspect, 1, 8000);
        this.camera.position.set(600, 420, 600);   // sensible default; will be
                                                   // re-fit when a city loads
        this.camera.lookAt(0, 0, 0);

        // ---- Controls ---------------------------------------------------
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.screenSpacePanning = false;
        this.controls.minDistance = 20;
        this.controls.maxDistance = 3500;
        this.controls.maxPolarAngle = Math.PI * 0.495; // never below horizon
        this.controls.target.set(0, 0, 0);

        // Re-emit camera position for the minimap / HUD
        this.controls.addEventListener('change', () => {
            const t = this.controls.target;
            const z = Math.round(this.camera.position.y / 50);
            this.onCameraMove(t.x, t.z, z);
        });

        // ---- Lights -----------------------------------------------------
        // Real mode needs real lighting. Holo mode barely uses it, but
        // ambient still helps the ground grid read.
        this.ambient = new THREE.AmbientLight(0x8899aa, 0.9);
        this.scene.add(this.ambient);

        this.hemi = new THREE.HemisphereLight(0xbcd8ff, 0x1a2230, 0.85);
        this.scene.add(this.hemi);

        this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
        this.sun.position.set(-1200, 1800, 900);
        this.sun.castShadow = false;  // real city is too big for shadows today
        this.scene.add(this.sun);

        this.fill = new THREE.DirectionalLight(0x88aaff, 0.4);
        this.fill.position.set(900, 600, -900);
        this.scene.add(this.fill);

        // ---- Ground grid (only meaningful before/without a city) -------
        this.grid = this._buildGroundGrid();
        this.scene.add(this.grid);

        // ---- Postprocessing --------------------------------------------
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.scene, this.camera));

        this.bloom = new UnrealBloomPass(
            new THREE.Vector2(container.clientWidth, container.clientHeight),
            0.9,    // strength
            0.7,    // radius
            0.85    // threshold
        );
        this.composer.addPass(this.bloom);

        // ---- State ------------------------------------------------------
        this.renderMode = 'real';        // 'real' | 'holo'
        this.paused = false;
        this.speed = 1.0;                // simulation speed multiplier
        this.simTime = 0;                // seconds of simulated time
        this.holoMaterials = [];         // collected each time we swap mode

        // ---- Chase cam state --------------------------------------------
        // When non-null, the render loop overrides OrbitControls and drives
        // the camera to sit behind `_followTarget` every frame.
        this._followTarget = null;

        this._frameCount = 0;
        this._lastFpsTime = performance.now();
        this._clock = new THREE.Clock();

        this._onResize = this._handleResize.bind(this);
        window.addEventListener('resize', this._onResize);

        // Kick the loop.
        this._running = true;
        this._tick = this._tick.bind(this);
        requestAnimationFrame(this._tick);
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /** @returns {THREE.Scene} */
    getScene()    { return this.scene; }

    /** @returns {THREE.PerspectiveCamera} */
    getCamera()   { return this.camera; }

    /** @returns {OrbitControls} */
    getControls() { return this.controls; }

    /** @returns {THREE.WebGLRenderer} */
    getRenderer() { return this.renderer; }

    /** Simulation time, in seconds, affected by pause + speed. */
    getSimTime()  { return this.simTime; }

    /** Add any Object3D to the scene (actors, debug helpers, etc.). */
    add(obj)      { this.scene.add(obj); }

    /** Remove any Object3D. */
    remove(obj)   { this.scene.remove(obj); }

    /**
     * Switch between real GLB materials and the holographic overlay.
     * @param {'real'|'holo'} mode
     */
    setRenderMode(mode) {
        if (mode !== 'real' && mode !== 'holo') return;
        this.renderMode = mode;

        if (mode === 'holo') {
            this.bloom.strength = 1.35;
            this.ambient.intensity = 0.55;
            this.hemi.intensity = 0.35;
            this._collectHoloMaterials();
        } else {
            this.bloom.strength = 0.55;
            this.ambient.intensity = 0.9;
            this.hemi.intensity = 0.85;
            this.holoMaterials = [];
        }
    }

    getRenderMode() { return this.renderMode; }

    /** Pause or resume simulation time (rendering continues). */
    setPaused(paused) {
        this.paused = !!paused;
    }

    isPaused() { return this.paused; }

    /** Set sim speed multiplier (1×, 2×, 4×, ...). */
    setSpeed(mult) {
        this.speed = Math.max(0.1, Number(mult) || 1.0);
    }

    getSpeed() { return this.speed; }

    /**
     * Frame the camera on a box (from city-loader's getBounds()).
     *
     * The bounding box now includes visible trees, which pushes `max.y`
     * well above the terrain. We deliberately ignore vertical extent when
     * choosing distance — horizontal footprint is what determines how far
     * back the camera needs to sit. And we anchor the look-at point to the
     * terrain surface, not the geometric mid-height, so the camera doesn't
     * drift upward when tall foliage is present.
     *
     * @param {{ min:THREE.Vector3, max:THREE.Vector3 }} bounds
     */
    fitToBounds(bounds) {
        if (!bounds) return;

        // ---- Horizontal footprint drives the distance ------------------
        const sizeX = bounds.max.x - bounds.min.x;
        const sizeZ = bounds.max.z - bounds.min.z;
        const footprint = Math.max(sizeX, sizeZ);

        // ---- Look-at point: horizontal center, terrain height ----------
        // bounds.min.y is the lowest terrain vertex, which for a flat
        // Mankweng export is effectively the ground plane. If the export
        // is ever tilted, a small offset keeps the camera from clipping.
        const centerX = (bounds.min.x + bounds.max.x) * 0.5;
        const centerZ = (bounds.min.z + bounds.max.z) * 0.5;
        const centerY = bounds.min.y + 5;   // 5 m above terrain

        this.controls.target.set(centerX, centerY, centerZ);

        // ---- Distance: 1.3× footprint, but never closer than 300 m -----
        // 1.3 gives a comfortable frame — the whole city fits with a
        // little breathing room, and there's still detail on screen.
        const dist = Math.max(footprint * 1.3, 300);

        this.camera.position.set(
            centerX + dist * 0.75,
            centerY + dist * 0.55,
            centerZ + dist * 0.75
        );

        this.camera.near = Math.max(1, dist / 500);
        this.camera.far  = Math.max(8000, dist * 6);
        this.camera.updateProjectionMatrix();
        this.controls.update();

        // ---- Fog: reveal the whole area without washing out the city ----
        this.scene.fog.near = dist * 1.1;
        this.scene.fog.far  = dist * 4.0;
    }

    // -----------------------------------------------------------------------
    // Chase cam
    // -----------------------------------------------------------------------

    /**
     * Follow an actor with a smoothed chase camera.
     *
     * On the first call, the camera snaps to the chase position so the
     * transition doesn't sweep across the whole map. From then on, the
     * render loop drives the camera toward the actor's tail each frame.
     *
     * @param {THREE.Object3D} object  the actor's root group
     */
    followActor(object) {
        if (!object) return;

        this._followTarget = object;

        // OrbitControls would fight the chase update. Disable until unfollow.
        this.controls.enabled = false;

        // Snap the camera to the desired position immediately.
        const rot      = object.rotation.y;
        const backDist = 12;
        const upDist   = 4;

        this.camera.position.set(
            object.position.x - Math.sin(rot) * backDist,
            object.position.y + upDist,
            object.position.z - Math.cos(rot) * backDist
        );

        this.controls.target.set(
            object.position.x,
            object.position.y + 1.5,
            object.position.z
        );
        this.camera.lookAt(this.controls.target);
    }

    /** Stop following the current actor. Restores OrbitControls. */
    unfollowActor() {
        this._followTarget = null;
        this.controls.enabled = true;
    }

    /** @returns {boolean} */
    isFollowing() {
        return this._followTarget !== null;
    }

    /** @returns {THREE.Object3D|null} */
    getFollowedActor() {
        return this._followTarget;
    }

    /** Force one render (used after a big state change, if paused). */
    renderOnce() {
        this.composer.render();
    }

    /** Clean shutdown. */
    dispose() {
        this._running = false;
        window.removeEventListener('resize', this._onResize);
        this.controls.dispose();
        this.renderer.dispose();
        if (this.renderer.domElement.parentNode) {
            this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
        }
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    _buildGroundGrid() {
        const group = new THREE.Group();
        group.name = 'ground:grid';

        // Solid dark floor — visible only when no city is loaded.
        const planeGeo = new THREE.PlaneGeometry(12000, 12000, 1, 1);
        planeGeo.rotateX(-Math.PI / 2);
        const planeMat = new THREE.MeshBasicMaterial({
            color: 0x02040a,
            transparent: true,
            opacity: 0.6,
            depthWrite: false,
        });
        const plane = new THREE.Mesh(planeGeo, planeMat);
        plane.position.y = -0.5;
        plane.renderOrder = -10;
        group.add(plane);

        // Holo grid overlay — subtle, additive.
        const gridGeo = new THREE.PlaneGeometry(12000, 12000, 1, 1);
        gridGeo.rotateX(-Math.PI / 2);
        const gridMat = makeHoloGroundMaterial({
            color: HOLO.deep,
            gridColor: HOLO.cyanDim,
            opacity: 0.35,
        });
        const grid = new THREE.Mesh(gridGeo, gridMat);
        grid.position.y = 0;
        grid.renderOrder = -9;
        group.add(grid);

        group.userData.isGroundGrid = true;
        group.userData.holoMaterial = gridMat;
        return group;
    }

    _collectHoloMaterials() {
        this.holoMaterials = [];
        this.scene.traverse((obj) => {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const m of mats) {
                if (m?.userData?.isHolo || m?.uniforms?.uTime) {
                    this.holoMaterials.push(m);
                }
            }
        });
    }

    _handleResize() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        if (!w || !h) return;

        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();

        this.renderer.setSize(w, h);
        this.composer.setSize(w, h);
        this.bloom.setSize(w, h);
    }

    /**
     * Drive the chase camera toward the followed actor's tail.
     * Called every frame from _tick() when `_followTarget` is set.
     */
    _updateChaseCam(dt) {
        const obj = this._followTarget;
        if (!obj) return;

        const rot = obj.rotation.y;

        // Where the camera wants to be: 12 m behind, 4 m above.
        const backDist = 12;
        const upDist   = 4;
        const desiredX = obj.position.x - Math.sin(rot) * backDist;
        const desiredY = obj.position.y + upDist;
        const desiredZ = obj.position.z - Math.cos(rot) * backDist;

        // Smoothed lerp — cinematic lag, not a rigid lock.
        const alpha = 1 - Math.exp(-dt / 0.35);
        this.camera.position.x += (desiredX - this.camera.position.x) * alpha;
        this.camera.position.y += (desiredY - this.camera.position.y) * alpha;
        this.camera.position.z += (desiredZ - this.camera.position.z) * alpha;

        // Look slightly ahead of the actor so the road is visible.
        const lookX = obj.position.x + Math.sin(rot) * 8;
        const lookY = obj.position.y + 1.5;
        const lookZ = obj.position.z + Math.cos(rot) * 8;

        const lookAlpha = 1 - Math.exp(-dt / 0.20);
        this.controls.target.x += (lookX - this.controls.target.x) * lookAlpha;
        this.controls.target.y += (lookY - this.controls.target.y) * lookAlpha;
        this.controls.target.z += (lookZ - this.controls.target.z) * lookAlpha;

        this.camera.lookAt(this.controls.target);
    }

    _tick() {
        if (!this._running) return;
        requestAnimationFrame(this._tick);

        const dt = this._clock.getDelta();

        if (!this.paused) {
            this.simTime += dt * this.speed;
        }

        // Advance shader time.
        if (this.renderMode === 'holo' && this.holoMaterials.length) {
            updateHoloTime(this.holoMaterials, this.simTime);
        }
        // Ground grid is always holo-styled, so it always updates.
        const gm = this.grid?.userData?.holoMaterial;
        if (gm?.uniforms?.uTime) gm.uniforms.uTime.value = this.simTime;

        // Chase cam takes precedence over OrbitControls while active.
        if (this._followTarget) {
            this._updateChaseCam(dt);
        } else {
            this.controls.update();
        }

        this.composer.render();

        // FPS
        this._frameCount++;
        const now = performance.now();
        if (now - this._lastFpsTime >= 1000) {
            const fps = Math.round((this._frameCount * 1000) / (now - this._lastFpsTime));
            this.onFps(fps);
            this._frameCount = 0;
            this._lastFpsTime = now;
        }
    }
}