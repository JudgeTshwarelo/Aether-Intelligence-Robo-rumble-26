// frontend/js/city-loader.js
// ---------------------------------------------------------------------------
// Loads a single real-world GLB exported via urban:EXPORT
// (FBX -> Blender -> GLB) for the Aether digital twin.
//
// One location = one GLB. No multi-part tiling, no GPS offsets, no merging
// of separate cities. The GLB is dropped at (0, 0, 0) and everything below
// operates on that single scene graph.
//
// Responsibilities:
//   • fetch the location meta.json
//   • load the GLB with progress reporting
//   • index meshes into logical layers (roads, buildings, trees, terrain…)
//     — first matching pattern wins, so a mesh is only ever in one layer
//   • sweep any un-indexed meshes into a synthetic catch-all layer so
//     nothing is left behind to render as a "phantom duplicate"
//   • re-material single-mesh layers and merge multi-mesh layers into
//     single meshes so the whole city renders in a handful of draw calls
//   • style roads with the asphalt + markings material
//   • build a terrain raycast group and expose groundY()
//   • compute a bounding box for camera framing
//
// It does NOT know about ambulances, drones, or emergencies. Those are
// actors that sit on top of whatever city is loaded.
//
// IMPORTANT (this file's history):
//   1. Earlier versions removed the GLTF scene root from `currentCity`
//      after merging. That was wrong: single-mesh layers stay parented
//      under the root, so removing it silently hid roads and buildings
//      while leaving multi-mesh layers (like trees) visible. The root
//      now stays in the graph, and _ensureInScene() is a safety net.
//
//   2. An earlier version lifted roads to clear the top of the terrain
//      bounding box. That's wrong for any export whose terrain has hills
//      anywhere in its footprint — it lifts roads to the highest point
//      in the map. Removed.
//
//   3. Some urban:EXPORT GLBs author their road mesh a small distance
//      above the terrain surface (a leftover from how the exporter
//      extrudes road polygons). If you see roads floating on screen,
//      tune ROAD_Y_OFFSET_M below (negative = push roads down). The
//      audit printed to the console tells you exactly how far apart
//      roads and terrain are, so you can pick the right value.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import {
    makeRoadSurfaceMaterial,
    makeTreeMaterial,
    makeBuildingMaterial,
    makePublicBuildingMaterial,
    makePathMaterial,
    makeTerrainMaterial,
} from './materials.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

// Vertical / horizontal limits for the world bounding box. Anything beyond
// this is a bad-export artefact, not real geometry.
const BOUNDS_LIMIT_METERS = 50_000;

// Above this many meshes in a layer, we merge them into one mesh.
// At or below this count, we keep the existing mesh(es) but still
// re-assign the material so it matches materials.js.
const MERGE_THRESHOLD = 1;

// How far to shift every road mesh vertically after loading. Positive
// values lift roads, negative values push them down. Set to 0 for no
// change. Only use this if the GLB puts roads visually above terrain.
//
// This is a constant offset, NOT a terrain-peak match. It cannot shoot
// roads into the sky the way the old lift logic did.
const ROAD_Y_OFFSET_M = -0.15;

// Metres per degree of latitude — constant everywhere on Earth.
const METRES_PER_DEG_LAT = 110540;

// Metres per degree of longitude, at a given latitude.
function metresPerDegLon(latDeg) {
    return 111320 * Math.cos(latDeg * Math.PI / 180);
}

export class CityLoader {
    constructor(scene, opts = {}) {
        this.scene = scene;
        this.loader = new GLTFLoader();
        this.onProgress = opts.onProgress || (() => {});
        this.onStatus   = opts.onStatus   || (() => {});

        this.currentCity = null;
        this.meta = null;
        this.layers = {};
        this.bounds = null;

        this.terrainRaycaster = new THREE.Raycaster();
        this._down   = new THREE.Vector3(0, -1, 0);
        this._origin = new THREE.Vector3();

        this._layerLookup = new Map();
        this._roadMaterial = null;
        this._terrainGroup = null;
    }

    // =======================================================================
    // Public: load a single location
    // =======================================================================

    async load(locationMetaPath) {
        this.onStatus('reading location metadata');

        this.meta = await fetch(locationMetaPath).then((r) => {
            if (!r.ok) throw new Error(`location meta not found: ${locationMetaPath}`);
            return r.json();
        });

        const modelUrl = this.meta.model;
        if (!modelUrl) {
            throw new Error(
                'Location meta has no "model" field. ' +
                'Single-GLB locations need { "model": "path/to/mankweng.glb" }.'
            );
        }

        this.onStatus('loading model');
        const gltf = await this._loadGLB(modelUrl, (loaded, total) => {
            this.onProgress(loaded, total);
        });

        this._disposeCurrent();

        this.currentCity = new THREE.Group();
        this.currentCity.name = `location:${this.meta.id || 'unnamed'}`;

        const root = gltf.scene;
        root.position.set(0, 0, 0);
        root.rotation.set(0, 0, 0);
        root.scale.set(1, 1, 1);
        this.currentCity.add(root);

        this._indexLayers();
        this._mergeLayers();
        this._ensureInScene();          // ← safety net for orphaned layers
        this._buildTerrainGroup();
        this._styleRoads();
        this._computeBounds();
        this._prepareTerrainRaycast();

        // ---------------------------------------------------------------
        // CRITICAL: do NOT remove `root` from `currentCity`.
        //
        // Single-mesh layers are still parented under `root`. Merged layers
        // have been reparented directly to `currentCity`. Removing the root
        // would hide every single-mesh layer while leaving the merged ones
        // visible — the exact symptom of "only trees render".
        //
        // The root is just a Group. It costs nothing to keep. Keep it.
        // ---------------------------------------------------------------

        // Optional vertical lift, e.g. if the exporter places buildings
        // half a metre below the terrain surface.
        const yOffset = Number(this.meta.yOffset) || 0;
        if (yOffset) this.currentCity.position.y = yOffset;

        this.scene.add(this.currentCity);

        this.onStatus('ready');
        this._logLayerSummary();
        this._auditLayers();

        return this.meta;
    }

    // =======================================================================
    // Public: coordinate conversion (against the location centre)
    // =======================================================================

    gpsToScene(lat, lon) {
        if (!this.meta) throw new Error('gpsToScene called before load()');
        const c = this.meta.center;
        const dx =  (lon - c.lon) * metresPerDegLon(c.lat);
        const dz = -(lat - c.lat) * METRES_PER_DEG_LAT;
        return { x: dx, z: dz };
    }

    sceneToGps(x, z) {
        if (!this.meta) throw new Error('sceneToGps called before load()');
        const c = this.meta.center;
        const lat = c.lat + (-z) / METRES_PER_DEG_LAT;
        const lon = c.lon + x / metresPerDegLon(c.lat);
        return { lat, lon };
    }

    groundY(x, z) {
        if (!this._terrainGroup) return null;
        this._origin.set(x, 10000, z);
        this.terrainRaycaster.set(this._origin, this._down);
        const hits = this.terrainRaycaster.intersectObjects(
            this._terrainGroup.children, true
        );
        return hits.length ? hits[0].point.y : null;
    }

    // =======================================================================
    // Public: layer accessors
    // =======================================================================

    getLayer(name)     { return this.layers[name] || []; }
    getRoadMeshes()    { return this.getLayer('roads'); }
    getTerrainMeshes() { return this.getLayer('terrain'); }
    getWaterMeshes()   { return this.getLayer('water'); }
    getSiteMeshes()    { return this.getLayer('site'); }
    getPathMeshes()    { return this.getLayer('paths'); }
    getTreeMeshes()    { return this.getLayer('trees'); }

    getBuildingMeshes() {
        return [
            ...this.getLayer('buildings_residential'),
            ...this.getLayer('buildings_other'),
            ...this.getLayer('buildings_commercial'),
            ...this.getLayer('buildings_utility'),
            ...this.getLayer('buildings_public'),
        ];
    }

    getBounds() { return this.bounds; }

    // =======================================================================
    // Internals — loading
    // =======================================================================

    _loadGLB(url, onProgress) {
        return new Promise((resolve, reject) => {
            this.loader.load(
                url,
                (gltf) => resolve(gltf),
                (evt) => {
                    if (typeof onProgress === 'function') {
                        onProgress(evt.loaded, evt.lengthComputable ? evt.total : 0);
                    }
                },
                (err) => reject(err)
            );
        });
    }

    // =======================================================================
    // Internals — layer indexing
    // =======================================================================

    _indexLayers() {
        this.layers = {};
        this._layerLookup.clear();

        const patterns = this.meta.layers || {};
        if (Object.keys(patterns).length === 0) {
            console.warn('[city-loader] meta.layers is empty — nothing will be indexed');
        }

        let unindexedCount = 0;

        this.currentCity.traverse((obj) => {
            if (!obj.isMesh) return;

            const name = (obj.name || '').toUpperCase();
            if (!name) return;

            obj.castShadow = false;
            obj.receiveShadow = false;

            if (obj.geometry && !obj.geometry.boundingBox) {
                obj.geometry.computeBoundingBox?.();
            }

            let matched = false;
            for (const [key, pattern] of Object.entries(patterns)) {
                if (matchesPattern(name, pattern)) {
                    (this.layers[key] ||= []).push(obj);
                    this._layerLookup.set(obj.uuid, key);
                    matched = true;
                    break;
                }
            }

            if (!matched) {
                (this.layers.unindexed ||= []).push(obj);
                this._layerLookup.set(obj.uuid, 'unindexed');
                unindexedCount++;
            }
        });

        if (unindexedCount > 0) {
            console.warn(
                `[city-loader] ${unindexedCount} mesh(es) matched no layer pattern ` +
                `→ swept into "unindexed". Check meta.layers if you expected them ` +
                `to be categorised.`
            );
        }
    }

    // =======================================================================
    // Internals — merging
    //
    //  • 0 meshes → skip
    //  • 1 mesh   → keep geometry, replace material via _materialForLayer()
    //  • 2+       → clone geometries, merge into one mesh with the layer's
    //               material
    //
    // The single-mesh case is important: the GLB often ships each building
    // category as ONE mesh (e.g. BUILDINGS_RESIDENTIAL), and without this
    // branch those layers would keep the GLB's pale original materials
    // instead of the Aether palette.
    //
    // The single-mesh branch does NOT reparent the mesh. It stays where it
    // is — which is why the GLTF root must never be removed from the tree.
    // =======================================================================

    _mergeLayers() {
        const rebuild = {};

        this.currentCity.updateMatrixWorld(true);

        for (const [layerKey, meshes] of Object.entries(this.layers)) {
            if (!Array.isArray(meshes) || meshes.length === 0) {
                rebuild[layerKey] = meshes;
                continue;
            }

            // ---- Single-mesh layer: swap material only --------------------
            if (meshes.length <= MERGE_THRESHOLD) {
                for (const mesh of meshes) {
                    const newMat = this._materialForLayer(layerKey, mesh.material);
                    if (newMat && newMat !== mesh.material) {
                        const olds = Array.isArray(mesh.material)
                            ? mesh.material
                            : [mesh.material];
                        for (const m of olds) m?.dispose?.();
                        mesh.material = newMat;
                    }
                }
                rebuild[layerKey] = meshes;
                continue;
            }

            // ---- Multi-mesh layer: full geometry merge --------------------
            const geometries = [];
            let firstMaterial = null;

            for (const mesh of meshes) {
                if (!mesh.geometry) continue;

                const g = mesh.geometry.clone();
                g.applyMatrix4(mesh.matrixWorld);
                if (!g.attributes.normal) g.computeVertexNormals();
                geometries.push(g);

                if (!firstMaterial && mesh.material) {
                    firstMaterial = Array.isArray(mesh.material)
                        ? mesh.material[0]
                        : mesh.material;
                }
            }

            if (geometries.length === 0) {
                rebuild[layerKey] = meshes;
                continue;
            }

            let mergedGeo;
            try {
                mergedGeo = BufferGeometryUtils.mergeGeometries(geometries, false);
            } catch (err) {
                console.warn(`[city-loader] merge failed for ${layerKey}:`, err);
                rebuild[layerKey] = meshes;
                continue;
            }

            if (!mergedGeo) {
                console.warn(`[city-loader] merge returned null for ${layerKey}`);
                rebuild[layerKey] = meshes;
                continue;
            }

            for (const g of geometries) g.dispose?.();

            const material = this._materialForLayer(layerKey, firstMaterial);

            const mergedMesh = new THREE.Mesh(mergedGeo, material);
            mergedMesh.name = `MERGED_${layerKey.toUpperCase()}`;
            mergedMesh.castShadow = false;
            mergedMesh.receiveShadow = false;
            mergedMesh.userData.isMergedLayer = true;
            mergedMesh.userData.layerKey = layerKey;

            for (const old of meshes) {
                old.parent?.remove(old);
                old.geometry?.dispose?.();
                const olds = Array.isArray(old.material)
                    ? old.material
                    : [old.material];
                for (const m of olds) m?.dispose?.();
            }
            this.currentCity.add(mergedMesh);

            console.info(
                `[city-loader] merged ${geometries.length} ${layerKey} meshes → 1`
            );

            rebuild[layerKey] = [mergedMesh];
        }

        this.layers = rebuild;

        this._layerLookup.clear();
        for (const [key, meshes] of Object.entries(this.layers)) {
            for (const m of meshes) this._layerLookup.set(m.uuid, key);
        }
    }

    // =======================================================================
    // Internals — orphan safety net
    // =======================================================================

    _ensureInScene() {
        if (!this.currentCity) return;

        this.currentCity.updateMatrixWorld(true);

        let rescued = 0;

        for (const [layerKey, meshes] of Object.entries(this.layers)) {
            for (const mesh of meshes) {
                // Walk parents to see if we reach currentCity.
                let node = mesh;
                let connected = false;
                while (node) {
                    if (node === this.currentCity) { connected = true; break; }
                    node = node.parent;
                }
                if (connected) continue;

                // Orphan. Reparent while preserving world transform.
                const worldMatrix = mesh.matrixWorld.clone();
                mesh.parent?.remove(mesh);
                this.currentCity.add(mesh);
                mesh.matrix.copy(worldMatrix);
                mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
                rescued++;
                console.warn(
                    `[city-loader] rescued orphaned mesh "${mesh.name}" ` +
                    `from layer "${layerKey}"`
                );
            }
        }

        if (rescued > 0) {
            console.warn(
                `[city-loader] ${rescued} mesh(es) were detached from the city ` +
                `graph and have been reparented. This indicates a bug in the ` +
                `merge or load pipeline — investigate before shipping.`
            );
        }
    }

    _materialForLayer(layerKey, original) {
        switch (layerKey) {
            case 'buildings_residential':
            case 'buildings_other':
            case 'buildings_commercial':
            case 'buildings_utility':
                return makeBuildingMaterial();

            case 'buildings_public':
                return makePublicBuildingMaterial();

            case 'paths':   return makePathMaterial();
            case 'trees':   return makeTreeMaterial();
            case 'terrain': return makeTerrainMaterial();

            default:        return original || new THREE.MeshStandardMaterial();
        }
    }

    // =======================================================================
    // Internals — terrain raycast group
    // =======================================================================

    _buildTerrainGroup() {
        this._terrainGroup = new THREE.Group();
        this._terrainGroup.name = 'terrain:raycast';
        for (const m of this.getTerrainMeshes()) this._terrainGroup.add(m);
    }

    // =======================================================================
    // Internals — road styling
    //
    // Roads get:
    //   • UVs regenerated from plan position (overwriting the GLB's own UVs,
    //     which stretch the markings texture across the entire network)
    //   • the dark-blue asphalt + cyan holo markings material
    //   • renderOrder = 1 so they draw after terrain
    //   • an optional constant vertical offset, ROAD_Y_OFFSET_M, applied to
    //     each road mesh's position. This is a deliberate, controlled nudge
    //     — never a terrain-peak match.
    // =======================================================================

    _generateRoadUVs(mesh, tileMeters = 6.0) {
        const geo = mesh.geometry;
        if (!geo?.attributes?.position) return;

        const pos = geo.attributes.position;
        const count = pos.count;
        const uvs = new Float32Array(count * 2);

        for (let i = 0; i < count; i++) {
            const x = pos.getX(i);
            const z = pos.getZ(i);
            uvs[i * 2    ] = x / tileMeters;
            uvs[i * 2 + 1] = z / tileMeters;
        }

        // Overwrite any existing UVs — the GLB's own UVs stretch the
        // texture across the whole road network, hiding the markings.
        geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        geo.attributes.uv.needsUpdate = true;
    }

    _styleRoads() {
        const roads = this.getRoadMeshes();
        if (!roads.length) {
            console.warn('[city-loader] no road meshes to style');
            return;
        }

        this._roadMaterial = makeRoadSurfaceMaterial();

        for (const mesh of roads) {
            this._generateRoadUVs(mesh, 6.0);

            const old = mesh.material;
            if (old && old !== this._roadMaterial) {
                const olds = Array.isArray(old) ? old : [old];
                for (const m of olds) m?.dispose?.();
            }

            mesh.material = this._roadMaterial;
            mesh.visible = true;
            mesh.renderOrder = 1;

            // Constant, controlled vertical nudge. See ROAD_Y_OFFSET_M.
            if (ROAD_Y_OFFSET_M !== 0) {
                mesh.position.y += ROAD_Y_OFFSET_M;
            }
        }

        console.info(
            `[city-loader] styled ${roads.length} road mesh(es) ` +
            `(yOffset ${ROAD_Y_OFFSET_M} m)`
        );
    }

    // =======================================================================
    // Internals — diagnostics
    // =======================================================================

    _logLayerSummary() {
        const summary = Object.entries(this.layers)
            .map(([k, v]) => `${k}: ${v.length}`)
            .join('  ');
        console.info(`[city-loader] layers → ${summary || '(none matched)'}`);
    }

    /**
     * Print the Y-range of each layer, the total city bounds, and the world
     * bounds. Also prints the vertical relationship between roads and
     * terrain so you can pick a good ROAD_Y_OFFSET_M.
     */
    _auditLayers() {
        if (!this.currentCity) return;

        this.currentCity.updateMatrixWorld(true);

        const rows = [];

        for (const [layerKey, meshes] of Object.entries(this.layers)) {
            if (!meshes.length) continue;

            const box = new THREE.Box3();
            for (const m of meshes) box.expandByObject(m);

            if (!Number.isFinite(box.min.y) || !Number.isFinite(box.max.y)) {
                rows.push({ layer: layerKey, note: 'no finite bounds' });
                continue;
            }

            rows.push({
                layer:   layerKey,
                count:   meshes.length,
                minY:    box.min.y,
                maxY:    box.max.y,
                heightY: box.max.y - box.min.y,
                sizeX:   box.max.x - box.min.x,
                sizeZ:   box.max.z - box.min.z,
            });
        }

        if (!rows.length) return;

        console.groupCollapsed('[city-loader] layer audit');
        console.table(rows.map((r) => ({
            layer:   r.layer,
            meshes:  r.count ?? '-',
            minY:    r.minY != null ? r.minY.toFixed(2) : '-',
            maxY:    r.maxY != null ? r.maxY.toFixed(2) : '-',
            heightY: r.heightY != null ? r.heightY.toFixed(2) : '-',
            sizeX:   r.sizeX != null ? r.sizeX.toFixed(1) : '-',
            sizeZ:   r.sizeZ != null ? r.sizeZ.toFixed(1) : '-',
        })));
        if (this.bounds) {
            console.info(
                `[city-loader] bounds  min=(${this.bounds.min.x.toFixed(1)}, ` +
                `${this.bounds.min.y.toFixed(2)}, ${this.bounds.min.z.toFixed(1)})  ` +
                `max=(${this.bounds.max.x.toFixed(1)}, ` +
                `${this.bounds.max.y.toFixed(2)}, ${this.bounds.max.z.toFixed(1)})`
            );
        }

        // ---- Road / terrain vertical relationship --------------------------
        const roads = this.getRoadMeshes();
        const terrain = this.getTerrainMeshes();
        if (roads.length && terrain.length) {
            const rBox = new THREE.Box3();
            for (const m of roads) rBox.expandByObject(m);
            const tBox = new THREE.Box3();
            for (const m of terrain) tBox.expandByObject(m);

            const roadMidY = (rBox.min.y + rBox.max.y) * 0.5;
            const terrainMidY = (tBox.min.y + tBox.max.y) * 0.5;
            const delta = roadMidY - terrainMidY;

            console.info(
                `[city-loader] road vs terrain  roadMidY=${roadMidY.toFixed(2)}  ` +
                `terrainMidY=${terrainMidY.toFixed(2)}  delta=${delta.toFixed(2)} m  ` +
                `(tune ROAD_Y_OFFSET_M in city-loader.js if this is not ~0)`
            );
        }

        console.groupEnd();
    }

    // =======================================================================
    // Internals — bounds
    // =======================================================================

    _computeBounds() {
        const fullBox = new THREE.Box3().setFromObject(this.currentCity);

        let yMin = 0;
        let yMax = 0;
        const terrain = this.getTerrainMeshes();
        if (terrain.length) {
            const tBox = new THREE.Box3();
            for (const m of terrain) tBox.expandByObject(m);
            if (Number.isFinite(tBox.min.y) && Number.isFinite(tBox.max.y)) {
                yMin = tBox.min.y;
                yMax = tBox.max.y;
            }
        }

        const L = BOUNDS_LIMIT_METERS;

        const minX = Math.max(fullBox.min.x, -L);
        const maxX = Math.min(fullBox.max.x,  L);
        const minZ = Math.max(fullBox.min.z, -L);
        const maxZ = Math.min(fullBox.max.z,  L);

        const min = new THREE.Vector3(minX, yMin, minZ);
        const max = new THREE.Vector3(maxX, yMax, maxZ);

        this.bounds = {
            min,
            max,
            size:   max.clone().sub(min),
            center: min.clone().add(max).multiplyScalar(0.5),
        };
    }

    _prepareTerrainRaycast() {
        this.currentCity.updateMatrixWorld(true);
    }

    // =======================================================================
    // Internals — cleanup
    // =======================================================================

    _disposeCurrent() {
        if (!this.currentCity) return;

        this.scene.remove(this.currentCity);

        this.currentCity.traverse((obj) => {
            if (!obj.isMesh) return;

            obj.geometry?.dispose?.();

            const mats = Array.isArray(obj.material)
                ? obj.material
                : [obj.material];

            for (const m of mats) {
                if (!m || m === this._roadMaterial) continue;

                for (const v of Object.values(m)) {
                    if (v && v.isTexture) v.dispose();
                }
                m.dispose?.();
            }
        });

        this._roadMaterial?.dispose?.();
        this._roadMaterial = null;

        this.currentCity = null;
        this.layers = {};
        this._layerLookup.clear();
        this._terrainGroup = null;
    }
}

// ---------------------------------------------------------------------------
// Pattern matcher.
// ---------------------------------------------------------------------------
function matchesPattern(name, pattern) {
    if (!pattern) return false;
    const p = String(pattern).toUpperCase();
    if (p === '*') return true;

    const startsWithStar = p.startsWith('*');
    const endsWithStar   = p.endsWith('*');
    const core = p.replace(/^\*/, '').replace(/\*$/, '');

    if (startsWithStar && endsWithStar) return name.includes(core);
    if (startsWithStar)                 return name.endsWith(core);
    if (endsWithStar)                   return name.startsWith(core);
    return name === core;
}