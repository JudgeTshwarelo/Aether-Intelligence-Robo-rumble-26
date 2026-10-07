// frontend/js/main.js
// AETHER / SKYNET — holographic digital twin front-end (multi-city world).
// Each city is a THREE.Group positioned at its world origin; all local
// builders use LOCAL coordinates. Vehicles/pedestrians use WORLD coords.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import {
  HOLO,
  makeHoloMaterial,
  makeHoloEdges,
  makeHoloGroundMaterial,
  makeVehicleMaterial,
  makeAccentMaterial,
  updateHoloTime,
  collectHoloMaterials,
} from './materials.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const STATE = {
  selectedBuildingId: null,
  selectedBuildingCityId: null,
  selectedVehicleId: null,
  followId: null,
  holo: true,
  paused: false,
  speed: 1,
  vehicles: [],
  pedestrians: [],
  world: null,
  vehicleClasses: null,
  simTime: 0,
  stats: { total: 0, moving: 0, stopped: 0, pedestrians: 0, onHighway: 0 },
  viewMode: 'world',
  focusedCityId: null,
  fpv: { yaw: 0, pitch: 0, keys: new Set(), pointerId: null, lastX: 0, lastY: 0, previousViewMode: 'world' },
};

const viewport       = document.getElementById('viewport');
const selectionPanel = document.getElementById('selection-panel');
const statusSummary  = document.getElementById('status-summary');
const viewButton     = document.getElementById('toggle-view');
const fpvButton      = document.getElementById('toggle-fpv');
const fpvHint        = document.getElementById('fpv-hint');
const orbitHint      = document.getElementById('orbit-hint');
const holoButton     = document.getElementById('toggle-holo');
const pauseButton    = document.getElementById('toggle-pause');
const speedButton    = document.getElementById('toggle-speed');

const statTime     = document.getElementById('stat-time');
const statVehicles = document.getElementById('stat-vehicles');
const statMoving   = document.getElementById('stat-moving');
const statStopped  = document.getElementById('stat-stopped');
const statFps      = document.getElementById('stat-fps');

const minimapCanvas = document.getElementById('minimap');
const minimapCtx    = minimapCanvas.getContext('2d');
const minimapZoomEl = document.getElementById('minimap-zoom');
const minimapCoords = document.getElementById('minimap-coords');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  const d = Math.floor((seconds * 10) % 10);
  return `${m}:${s}.${d}`;
}

function updateSummary() {
  if (!STATE.world) return;
  const c = STATE.world.cities.length;
  const h = STATE.world.highways.length;
  const b = STATE.world.cities.reduce((acc, city) => acc + city.buildings.length, 0);
  statusSummary.textContent = `${c} cities · ${h} highways · ${b} buildings`;
}

function makeToggleButton(button, active) {
  if (!button) return;
  button.classList.toggle('active', active);
}

function syncUI() {
  makeToggleButton(holoButton, STATE.holo);
  makeToggleButton(pauseButton, STATE.paused);
  makeToggleButton(fpvButton, STATE.viewMode === 'fpv');
  if (pauseButton) pauseButton.textContent = STATE.paused ? '▶ RESUME' : '⏸ PAUSE';
  if (speedButton) speedButton.textContent = `SPEED ${STATE.speed}×`;
  if (speedButton) speedButton.classList.toggle('active', STATE.speed !== 1);
  if (viewButton) {
    const labels = { world: 'WORLD VIEW', local: 'LOCAL VIEW', fpv: 'FPV' };
    viewButton.textContent = labels[STATE.viewMode] || 'WORLD VIEW';
    viewButton.classList.toggle('active', STATE.viewMode !== 'world');
  }
  if (fpvButton) {
    fpvButton.textContent = STATE.viewMode === 'fpv' ? 'EXIT FPV' : 'FPV';
    fpvButton.classList.toggle('active', STATE.viewMode === 'fpv');
  }
  if (fpvHint) fpvHint.hidden = STATE.viewMode !== 'fpv';
  if (orbitHint) orbitHint.hidden = STATE.viewMode === 'fpv';
}

function row(label, value, accentClass = '') {
  const rowEl = document.createElement('div');
  rowEl.className = 'data-row';
  const valueEl = document.createElement('span');
  valueEl.className = `data-value ${accentClass}`.trim();
  valueEl.textContent = value;
  const labelEl = document.createElement('span');
  labelEl.className = 'data-label';
  labelEl.textContent = label;
  rowEl.append(labelEl, valueEl);
  return rowEl;
}

function findBuilding(id, cityId) {
  if (!STATE.world) return null;
  const cities = cityId
    ? STATE.world.cities.filter((c) => c.id === cityId)
    : STATE.world.cities;
  for (const city of cities) {
    const b = city.buildings.find((b) => b.id === id);
    if (b) return { building: b, city };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Selection panel
// ---------------------------------------------------------------------------
function renderSelectionPanel() {
  selectionPanel.innerHTML = '';

  const buildingHit = STATE.selectedBuildingId
    ? findBuilding(STATE.selectedBuildingId, STATE.selectedBuildingCityId)
    : null;

  if (!buildingHit && !STATE.selectedVehicleId) {
    selectionPanel.hidden = true;
    return;
  }
  selectionPanel.hidden = false;

  if (buildingHit) {
    const { building, city } = buildingHit;
    const panel = document.createElement('div');
    panel.className = 'panel-card';
    panel.innerHTML = `
      <div class="panel-header">
        <div>
          <div class="panel-subtitle">ENTITY · BUILDING</div>
          <div class="entity-id">${building.id}</div>
        </div>
        <button class="close-button" type="button">✕</button>
      </div>`;
    panel.querySelector('.close-button').onclick = () => clearSelection();
    panel.append(row('City', city.name));
    panel.append(row('Type', building.type.toUpperCase()));
    panel.append(row('Zone', (building.zone || '—').toUpperCase()));
    panel.append(row('Height', `${building.height.toFixed(1)} m`));
    panel.append(row('Floors', String(building.floors)));
    if (building.units != null) panel.append(row('Units', String(building.units)));
    if (building.residents != null) panel.append(row('Residents', `${building.residents} ppl`));
    if (building.occupancy != null) panel.append(row('Occupancy', `${building.occupancy} ppl`));
    if (building.shops != null) panel.append(row('Shops', String(building.shops)));
    if (building.hazardLevel != null) panel.append(row('Hazard', building.hazardLevel.toUpperCase(), 'text-amber'));
    panel.append(row('Footprint', `${building.width.toFixed(0)}×${building.depth.toFixed(0)}`));
    panel.append(row('Status', building.status, 'text-emerald'));
    selectionPanel.appendChild(panel);
    return;
  }

  const id = STATE.selectedVehicleId;
  const vehicle = STATE.vehicles.find((v) => v.id === id);
  if (!vehicle) {
    selectionPanel.hidden = true;
    return;
  }

  const panel = document.createElement('div');
  panel.className = 'panel-card';
  panel.innerHTML = `
    <div class="panel-header">
      <div>
        <div class="panel-subtitle">ENTITY · VEHICLE</div>
        <div class="entity-id">${vehicle.id}</div>
      </div>
      <button class="close-button" type="button">✕</button>
    </div>`;
  panel.querySelector('.close-button').onclick = () => clearSelection();
  panel.append(row('Class', vehicle.type.toUpperCase()));
  panel.append(row('City', vehicle.cityId || '—'));
  panel.append(row('Speed', `${vehicle.speed.toFixed(1)} u/s`, vehicle.status === 'moving' ? 'text-cyan' : 'text-amber'));
  panel.append(row('Status', vehicle.status.toUpperCase(), vehicle.status === 'moving' ? 'text-emerald' : 'text-amber'));
  if (vehicle.length) panel.append(row('Length', `${vehicle.length.toFixed(1)} m`));
  panel.append(row('Lane', String(vehicle.lane ?? 0)));
  panel.append(row('Destination', vehicle.destination));

  const followButton = document.createElement('button');
  followButton.type = 'button';
  followButton.className = `follow-button ${STATE.followId === id ? 'following' : ''}`;
  followButton.textContent = STATE.followId === id ? '● FOLLOWING CAMERA' : 'ACTIVATE FOLLOW CAM';
  followButton.onclick = () => {
    STATE.followId = STATE.followId === id ? null : id;
    renderSelectionPanel();
  };
  panel.appendChild(followButton);
  selectionPanel.appendChild(panel);
}

function clearSelection() {
  STATE.selectedBuildingId = null;
  STATE.selectedBuildingCityId = null;
  STATE.selectedVehicleId = null;
  STATE.followId = null;
  renderSelectionPanel();
}

function setBuildingSelection(id, cityId) {
  STATE.selectedBuildingId = id;
  STATE.selectedBuildingCityId = cityId || null;
  STATE.selectedVehicleId = null;
  STATE.followId = null;
  renderSelectionPanel();
}

function setVehicleSelection(id) {
  STATE.selectedVehicleId = id;
  STATE.selectedBuildingId = null;
  STATE.selectedBuildingCityId = null;
  STATE.followId = null;
  renderSelectionPanel();
}

// ---------------------------------------------------------------------------
// Facade texture
// ---------------------------------------------------------------------------
function makeFacadeTexture(opts) {
  const { cols = 4, rows = 8, wallColor = '#222b3d', litColor = '#39d8e8', litChance = 0.42 } = opts;
  const canvas = document.createElement('canvas');
  const w = cols * 18;
  const h = rows * 18;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = wallColor;
  ctx.fillRect(0, 0, w, h);
  const pad = 3;
  const cw = (w - pad * (cols + 1)) / cols;
  const ch = (h - pad * (rows + 1)) / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = pad + c * (cw + pad);
      const y = pad + r * (ch + pad);
      const lit = Math.random() < litChance;
      ctx.fillStyle = lit ? litColor : '#070c16';
      ctx.fillRect(x, y, cw, ch);
      if (lit) {
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(x, y, cw, ch * 0.3);
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Scene / renderer / camera
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(HOLO.deep);

const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 12000);
camera.position.set(500, 700, 900);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
viewport.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = true;
controls.enableZoom = true;
controls.enableRotate = true;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 20;
controls.maxDistance = 8000;
controls.target.set(0, 0, 0);

scene.add(new THREE.AmbientLight(0x39ffd8, 0.25));
scene.add(new THREE.HemisphereLight('#39ffd8', '#05080f', 0.2));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.35);
dirLight.position.set(400, 500, 300);
scene.add(dirLight);

const cityGroup = new THREE.Group();
scene.add(cityGroup);
const highwayGroup = new THREE.Group();
scene.add(highwayGroup);
const vehicleGroup = new THREE.Group();
scene.add(vehicleGroup);
const pedestrianGroup = new THREE.Group();
scene.add(pedestrianGroup);

let holoMaterials = [];

function makeCityHoloMaterial(options = {}) {
  const bounds = STATE.world?.bounds;
  const span = bounds
    ? Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ)
    : 1000;
  const farFade = Math.max(2200, span * 3.5);
  return makeHoloMaterial({
    ...options,
    nearFade: options.nearFade ?? Math.min(300, farFade * 0.15),
    farFade,
  });
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.85, 0.65, 0.15
);
composer.addPass(bloom);

const HoloOverlayShader = {
  uniforms: {
    tDiffuse:   { value: null },
    uTime:      { value: 0 },
    uScanCount: { value: 420.0 },
    uScanSpeed: { value: 0.8 },
    uIntensity: { value: 0.015 },
    uVignette:  { value: 0.18 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uScanCount;
    uniform float uScanSpeed;
    uniform float uIntensity;
    uniform float uVignette;
    void main() {
      vec2 uv = vUv;
      vec2 dir = uv - 0.5;
      float d = length(dir);
      vec2 offset = dir * d * 0.0015;
      float r = texture2D(tDiffuse, uv + offset).r;
      float g = texture2D(tDiffuse, uv).g;
      float b = texture2D(tDiffuse, uv - offset).b;
      vec3 col = vec3(r, g, b);
      float scan = sin((uv.y * uScanCount) - (uTime * uScanSpeed)) * 0.5 + 0.5;
      col += (scan - 0.5) * uIntensity;
      col *= 1.0 - uIntensity * 0.6;
      float vig = smoothstep(1.1, 0.45, d);
      col *= mix(1.0, vig, uVignette);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
const holoOverlay = new ShaderPass(HoloOverlayShader);
composer.addPass(holoOverlay);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------------------
// Shared material cache
// ---------------------------------------------------------------------------
const SHARED_MATERIALS = {
  road: null, sidewalk: null, roadMark: null, crosswalk: null,
  lampPole: null, lampBulb: null, treeTrunk: null, treeLeaf: null,
  furniture: null, tlPole: null, tlHousing: null,
  highwayRoad: null, highwayEdge: null,
  pylonBody: null, pylonArm: null, powerline: null,
};

function initSharedMaterials() {
  SHARED_MATERIALS.road = makeCityHoloMaterial({
    color: '#0e1620', edgeColor: HOLO.cyan,
    opacity: 0.42, fresnelPower: 2.6,
    scanCount: 120, scanSpeed: 1.2,
    nearFade: 300,
  });
  SHARED_MATERIALS.sidewalk = makeCityHoloMaterial({
    color: HOLO.cyanDim, edgeColor: HOLO.cyan,
    opacity: 0.18, fresnelPower: 3.0, scanCount: 40,
    nearFade: 300,
  });
  SHARED_MATERIALS.roadMark = makeAccentMaterial(HOLO.cyanSoft, STATE.holo ? 1.1 : 0.2);
  SHARED_MATERIALS.crosswalk = makeAccentMaterial(HOLO.cyan, STATE.holo ? 1.4 : 0.25);
  SHARED_MATERIALS.lampPole = makeCityHoloMaterial({
    color: '#1a2230', edgeColor: HOLO.cyan,
    opacity: 0.5, fresnelPower: 2.4, scanCount: 30,
  });
  SHARED_MATERIALS.lampBulb = makeAccentMaterial('#fff3d0', 1.6);
  SHARED_MATERIALS.treeTrunk = makeCityHoloMaterial({
    color: '#1f2a24', edgeColor: HOLO.cyanSoft,
    opacity: 0.35, fresnelPower: 2.6, scanCount: 25,
  });
  SHARED_MATERIALS.treeLeaf = makeCityHoloMaterial({
    color: '#1f4d3a', edgeColor: HOLO.cyan,
    opacity: 0.42, fresnelPower: 2.0, scanCount: 35,
  });
  SHARED_MATERIALS.furniture = makeCityHoloMaterial({
    color: '#1a2230', edgeColor: HOLO.cyanSoft,
    opacity: 0.5, fresnelPower: 2.4, scanCount: 15,
  });
  SHARED_MATERIALS.tlPole = makeCityHoloMaterial({
    color: '#1a2230', edgeColor: HOLO.cyan,
    opacity: 0.5, fresnelPower: 2.2, scanCount: 20,
  });
  SHARED_MATERIALS.tlHousing = makeCityHoloMaterial({
    color: '#0d1219', edgeColor: HOLO.cyan,
    opacity: 0.6, fresnelPower: 2.0, scanCount: 20,
  });
  SHARED_MATERIALS.highwayRoad = makeHoloMaterial({
    color: '#0a0e16', edgeColor: HOLO.cyan,
    opacity: 0.55, fresnelPower: 2.4,
    scanCount: 200, scanSpeed: 1.8,
    nearFade: 400, farFade: 2200,
  });
  SHARED_MATERIALS.highwayEdge = makeAccentMaterial(HOLO.cyan, STATE.holo ? 1.6 : 0.3);
  SHARED_MATERIALS.pylonBody = makeHoloMaterial({
    color: '#1a2230', edgeColor: HOLO.cyan,
    opacity: 0.55, fresnelPower: 2.4, scanCount: 20,
  });
  SHARED_MATERIALS.pylonArm = makeHoloMaterial({
    color: '#1a2230', edgeColor: HOLO.cyanSoft,
    opacity: 0.5, fresnelPower: 2.4, scanCount: 20,
  });
  SHARED_MATERIALS.powerline = new THREE.LineBasicMaterial({
    color: new THREE.Color(HOLO.cyanSoft),
    transparent: true,
    opacity: 0.55,
  });
}

// ---------------------------------------------------------------------------
// City builders — ALL use LOCAL coordinates.
// The city's group is positioned at its world origin, so everything is relative.
// ---------------------------------------------------------------------------
function makeCityGround(city, group) {
  const { HALF } = city.meta;
  const groundSize = HALF * 2 + 80;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(groundSize, groundSize),
    makeHoloGroundMaterial()
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  group.add(ground);
}

function makeCityRoads(city, group) {
  const { GRID, BLOCK, ROAD_WIDTH } = city.meta;

  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const cx = ((i - GRID / 2) + 0.5) * BLOCK;
      const cz = ((j - GRID / 2) + 0.5) * BLOCK;
      const sidewalk = new THREE.Mesh(
        new THREE.PlaneGeometry(BLOCK - 1.5, BLOCK - 1.5),
        SHARED_MATERIALS.sidewalk
      );
      sidewalk.rotation.x = -Math.PI / 2;
      sidewalk.position.set(cx, 0.04, cz);
      group.add(sidewalk);
    }
  }

  for (const road of city.roads) {
    const stripe = new THREE.Mesh(
      new THREE.PlaneGeometry(road.to - road.from, ROAD_WIDTH),
      SHARED_MATERIALS.road
    );
    stripe.rotation.x = -Math.PI / 2;
    if (road.axis === 'x') stripe.position.set(0, 0.02, road.pos);
    else {
      stripe.rotation.z = Math.PI / 2;
      stripe.position.set(road.pos, 0.02, 0);
    }
    group.add(stripe);

    const center = new THREE.Mesh(
      new THREE.BoxGeometry(
        road.axis === 'x' ? (road.to - road.from) : 0.18,
        0.04,
        road.axis === 'x' ? 0.18 : (road.to - road.from)
      ),
      SHARED_MATERIALS.highwayEdge
    );
    if (road.axis === 'x') center.position.set(0, 0.05, road.pos);
    else center.position.set(road.pos, 0.05, 0);
    group.add(center);
  }
}

function makeCityRoadMarkings(city, group) {
  if (!city.roadMarkings || city.roadMarkings.length === 0) return;
  const geometry = new THREE.BoxGeometry(1, 0.02, 0.14);
  const mesh = new THREE.InstancedMesh(geometry, SHARED_MATERIALS.roadMark, city.roadMarkings.length);
  const dummy = new THREE.Object3D();
  let i = 0;
  for (const m of city.roadMarkings) {
    const len = m.end - m.start;
    if (m.axis === 'x') {
      dummy.position.set((m.start + m.end) / 2, 0.06, m.fixed);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(len, 1, 1);
    } else {
      dummy.position.set(m.fixed, 0.06, (m.start + m.end) / 2);
      dummy.rotation.set(0, Math.PI / 2, 0);
      dummy.scale.set(len, 1, 1);
    }
    dummy.updateMatrix();
    mesh.setMatrixAt(i++, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
}

function makeCityCrosswalks(city, group) {
  if (!city.crosswalks) return;
  for (const cw of city.crosswalks) {
    const stripeGroup = new THREE.Group();
    stripeGroup.position.set(cw.x, 0, cw.z);
    for (let s = -3; s <= 3; s++) {
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(0.4, 0.02, 4.6),
        SHARED_MATERIALS.crosswalk
      );
      if (cw.orientation === 'x') {
        stripe.position.set(s * 0.9, 0.055, 0);
      } else {
        stripe.rotation.y = Math.PI / 2;
        stripe.position.set(0, 0.055, s * 0.9);
      }
      stripeGroup.add(stripe);
    }
    group.add(stripeGroup);
  }
}

function makeCityStreetlights(city, group) {
  for (const lamp of city.streetlights) {
    const g = new THREE.Group();
    g.position.set(lamp.x, 0, lamp.z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 4.4, 6), SHARED_MATERIALS.lampPole);
    pole.position.y = 2.2;
    pole.add(makeHoloEdges(pole.geometry, { opacity: 0.4 }));
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.2, 6), SHARED_MATERIALS.lampPole);
    arm.position.set(0.6, 4.4, 0);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), SHARED_MATERIALS.lampBulb);
    bulb.position.set(0.6, 4.45, 0);
    g.add(pole, arm, bulb);
    group.add(g);
  }
}

function makeCityTrees(city, group) {
  for (const tree of city.trees) {
    const g = new THREE.Group();
    g.position.set(tree.x, 0, tree.z);
    g.scale.setScalar(tree.scale);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 1.4, 6), SHARED_MATERIALS.treeTrunk);
    trunk.position.y = 0.7;
    const top = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.2, 8), SHARED_MATERIALS.treeLeaf);
    top.position.y = 1.8;
    top.add(makeHoloEdges(top.geometry, { opacity: 0.35 }));
    const top2 = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.4, 8), SHARED_MATERIALS.treeLeaf);
    top2.position.y = 2.6;
    g.add(trunk, top, top2);
    group.add(g);
  }
}

function makeCityStreetFurniture(city, group) {
  if (city.hydrants) {
    for (const h of city.hydrants) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.6, 6), SHARED_MATERIALS.furniture);
      m.position.set(h.x, 0.3, h.z);
      group.add(m);
    }
  }
  if (city.benches) {
    for (const b of city.benches) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.1, 0.5), SHARED_MATERIALS.furniture);
      m.position.set(b.x, 0.45, b.z);
      group.add(m);
    }
  }
  if (city.busStops) {
    for (const s of city.busStops) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(3, 2.4, 0.2), SHARED_MATERIALS.furniture);
      m.position.set(s.x, 1.2, s.z);
      m.add(makeHoloEdges(m.geometry, { opacity: 0.4 }));
      group.add(m);
    }
  }
}

function makeCityTrafficLights(city, group) {
  for (const node of city.intersections) {
    const g = new THREE.Group();
    g.position.set(node.x, 0, node.z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6), SHARED_MATERIALS.tlPole);
    pole.position.y = 1.6;
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.6, 0.16), SHARED_MATERIALS.tlHousing);
    housing.position.set(0.18, 3.0, 0);

    const topLight = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), makeAccentMaterial(HOLO.ok, 2.0));
    topLight.position.set(0.18, 3.12, 0.08);
    const bottomLight = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), makeAccentMaterial(HOLO.danger, 2.0));
    bottomLight.position.set(0.18, 2.88, 0.08);

    g.add(pole, housing, topLight, bottomLight);
    group.add(g);
    node._trafficRefs = { topLight, bottomLight };
  }
}

function makeCityBuildings(city, group) {
  for (const building of city.buildings) {
    const g = new THREE.Group();
    g.position.set(building.position[0], 0, building.position[2]);
    g.rotation.y = building.rotation;

    const texture = makeFacadeTexture({
      cols: Math.max(2, Math.round(building.width / 3)),
      rows: Math.max(2, Math.round(building.floors)),
      wallColor: building.color,
      litColor: building.type === 'hospital' ? '#bfe8ff' : '#39d8e8',
      litChance: building.type === 'hospital' ? 0.7 : 0.42,
    });

    const bodyMat = makeCityHoloMaterial({
      color: building.type === 'hospital' ? '#cfe9ff' : HOLO.cyan,
      edgeColor: HOLO.edge,
      opacity: building.type === 'hospital' ? 0.75 : 0.5,
      fresnelPower: 2.0,
      scanCount: 70, scanSpeed: 1.4,
      map: texture,
      nearFade: 300,
    });

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(building.width, building.height, building.depth),
      bodyMat
    );
    body.position.y = building.height / 2;
    body.userData = { kind: 'building', id: building.id, cityId: city.id };
    body.add(makeHoloEdges(body.geometry, { opacity: 0.55, scale: 1.002 }));

    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(building.width * 0.96, 0.3, building.depth * 0.96),
      makeCityHoloMaterial({
        color: '#0e1620', edgeColor: HOLO.cyan,
        opacity: 0.5, fresnelPower: 2.4, scanCount: 30,
      })
    );
    roof.position.y = building.height + 0.1;

    const entrance = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 1.2, 0.1),
      makeAccentMaterial('#ffd98a', 0.8)
    );
    entrance.position.set(0, 0.6, building.depth / 2 + 0.02);

    g.add(body, roof, entrance);

    if (building.marker) {
      const markerBox = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 0.4, 1.2),
        makeAccentMaterial(building.marker, 1.6)
      );
      markerBox.position.y = building.height + 0.4;
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04, 0.04, 2.4, 6),
        makeHoloMaterial({ color: '#1a2230', edgeColor: HOLO.cyan, opacity: 0.5, fresnelPower: 2.0, scanCount: 15 })
      );
      pole.position.y = building.height + 1.4;
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 8, 8),
        makeAccentMaterial(building.marker, 2.5)
      );
      bulb.position.y = building.height + 2.6;
      g.add(markerBox, pole, bulb);
    }

    group.add(g);
  }
}

function makeCityInfrastructure(city, group) {
  for (const infra of city.infrastructure) {
    const building = city.buildings.find((b) => b.id === infra.buildingId);
    if (!building) continue;
    const skin = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.4, 1.2),
      makeAccentMaterial(HOLO.cyan, 1.6)
    );
    skin.position.set(building.position[0], building.height + 1.5, building.position[2]);
    group.add(skin);
  }
}

function makeCityLabel(city) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 512, 128);
  ctx.fillStyle = 'rgba(5, 8, 15, 0.75)';
  ctx.fillRect(0, 0, 512, 128);
  ctx.strokeStyle = HOLO.cyan;
  ctx.lineWidth = 2;
  ctx.strokeRect(2, 2, 508, 124);
  ctx.fillStyle = HOLO.cyan;
  ctx.font = 'bold 56px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(city.name, 256, 64);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.position.set(city.origin[0], 180, city.origin[1]);
  sprite.scale.set(220, 55, 1);
  sprite.userData = { kind: 'city-label', cityId: city.id };
  return sprite;
}

// ---------------------------------------------------------------------------
// Highways — world-space coordinates (not part of any city group)
// ---------------------------------------------------------------------------
function makeHighways() {
  if (!STATE.world) return;

  const pylonsByHighway = {};

  for (const hw of STATE.world.highways) {
    const ax = hw.a.x, az = hw.a.z;
    const bx = hw.b.x, bz = hw.b.z;
    const dx = bx - ax;
    const dz = bz - az;
    const length = hw.length;
    const heading = hw.heading;

    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(length, hw.width),
      SHARED_MATERIALS.highwayRoad
    );
    road.rotation.x = -Math.PI / 2;
    road.rotation.z = -heading;
    road.position.set((ax + bx) / 2, 0.03, (az + bz) / 2);
    highwayGroup.add(road);

    const dashCount = Math.max(4, Math.floor(length / 20));
    const dashGeo = new THREE.BoxGeometry(8, 0.05, 0.22);
    const dashMesh = new THREE.InstancedMesh(dashGeo, SHARED_MATERIALS.highwayEdge, dashCount);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < dashCount; i++) {
      const t = (i + 0.5) / dashCount;
      dummy.position.set(ax + dx * t, 0.06, az + dz * t);
      dummy.rotation.set(0, -heading, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      dashMesh.setMatrixAt(i, dummy.matrix);
    }
    dashMesh.instanceMatrix.needsUpdate = true;
    highwayGroup.add(dashMesh);

    for (const side of [-1, 1]) {
      const edge = new THREE.Mesh(
        new THREE.BoxGeometry(length, 0.05, 0.4),
        SHARED_MATERIALS.highwayEdge
      );
      const px = -dz / length * side * (hw.width / 2 - 0.3);
      const pz =  dx / length * side * (hw.width / 2 - 0.3);
      edge.position.set((ax + bx) / 2 + px, 0.05, (az + bz) / 2 + pz);
      edge.rotation.y = -heading;
      highwayGroup.add(edge);
    }

    if (hw.pylons && hw.pylons.length > 1) {
      pylonsByHighway[hw.id] = [];
      for (const p of hw.pylons) {
        const g = new THREE.Group();
        g.position.set(p.x, 0, p.z);
        const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 22, 2.6), SHARED_MATERIALS.pylonBody);
        body.position.y = 11;
        body.add(makeHoloEdges(body.geometry, { opacity: 0.4 }));
        const arm1 = new THREE.Mesh(new THREE.BoxGeometry(9, 0.5, 0.5), SHARED_MATERIALS.pylonArm);
        arm1.position.y = 18;
        const arm2 = arm1.clone();
        arm2.position.y = 21;
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.6, 2.6, 4), SHARED_MATERIALS.pylonArm);
        tip.position.y = 23;
        g.add(body, arm1, arm2, tip);
        highwayGroup.add(g);
        pylonsByHighway[hw.id].push({ x: p.x, z: p.z });
      }

      for (let i = 0; i < pylonsByHighway[hw.id].length - 1; i++) {
        const a = pylonsByHighway[hw.id][i];
        const b = pylonsByHighway[hw.id][i + 1];
        const strands = [
          { dy: 17.6, dx: -4.0, dz: 0 },
          { dy: 20.6, dx: 0,    dz: 0 },
          { dy: 17.6, dx: 4.0,  dz: 0 },
        ];
        for (const s of strands) {
          const mx = (a.x + b.x) / 2;
          const mz = (a.z + b.z) / 2;
          const my = s.dy - 1.4;
          const points = [
            new THREE.Vector3(a.x + s.dx, s.dy, a.z + s.dz),
            new THREE.Vector3(mx + s.dx, my, mz + s.dz),
            new THREE.Vector3(b.x + s.dx, s.dy, b.z + s.dz),
          ];
          const curve = new THREE.CatmullRomCurve3(points);
          const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(12));
          const line = new THREE.Line(geo, SHARED_MATERIALS.powerline);
          highwayGroup.add(line);
        }
      }
    }

    if (hw.roadsideTrees) {
      for (const t of hw.roadsideTrees) {
        const g = new THREE.Group();
        g.position.set(t.x, 0, t.z);
        g.scale.setScalar(t.scale);
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 1.6, 6), SHARED_MATERIALS.treeTrunk);
        trunk.position.y = 0.8;
        const top = new THREE.Mesh(new THREE.ConeGeometry(1.1, 2.6, 8), SHARED_MATERIALS.treeLeaf);
        top.position.y = 2.1;
        g.add(trunk, top);
        highwayGroup.add(g);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Vehicles — world coords
// ---------------------------------------------------------------------------
function vehicleSpecFor(type) {
  const cls = STATE.vehicleClasses?.[type];
  if (cls) return cls;
  return { length: 4.3, width: 2.1, height: 0.85, colors: ['#e8eef5'] };
}

function buildVehicles() {
  for (const vehicle of STATE.vehicles) {
    const spec = vehicleSpecFor(vehicle.type);
    const group = new THREE.Group();
    group.userData = { kind: 'vehicle', id: vehicle.id };

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(spec.width, spec.height, spec.length),
      makeVehicleMaterial({ color: vehicle.color })
    );
    body.add(makeHoloEdges(body.geometry, { opacity: 0.7, scale: 1.01 }));
    group.add(body);

    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(spec.width * 0.8, spec.height * 0.7, spec.length * 0.45),
      makeHoloMaterial({
        color: '#0a1018', edgeColor: HOLO.cyan,
        opacity: 0.7, fresnelPower: 1.6, scanCount: 40,
      })
    );
    cabin.position.set(0, spec.height * 0.65, spec.length * 0.05);
    group.add(cabin);

    const head1 = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), makeAccentMaterial('#fff7e0', 2.2));
    head1.position.set(spec.width * 0.3, 0.15, spec.length / 2 - 0.1);
    const head2 = head1.clone();
    head2.position.x = -spec.width * 0.3;
    group.add(head1, head2);

    const tailMat = makeAccentMaterial(HOLO.danger, 1.8);
    const tail1 = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.06), tailMat);
    tail1.position.set(spec.width * 0.3, 0.2, -spec.length / 2 + 0.1);
    const tail2 = tail1.clone();
    tail2.position.x = -spec.width * 0.3;
    group.add(tail1, tail2);

    if (vehicle.type === 'emergency') {
      const strobe = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 8, 8),
        makeAccentMaterial('#ffffff', 3.0)
      );
      strobe.position.set(0, spec.height + 0.15, 0);
      group.add(strobe);
    }

    if (STATE.selectedVehicleId === vehicle.id) {
      const sel = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(spec.width * 1.1, spec.height * 1.3, spec.length * 1.05)),
        new THREE.LineBasicMaterial({ color: HOLO.cyan, transparent: true, opacity: 0.9 })
      );
      group.add(sel);
    }

    group.position.set(vehicle.position.x, spec.height / 2 + 0.05, vehicle.position.z);
    group.rotation.y = vehicle.heading;
    vehicleGroup.add(group);
    vehicle._spec = spec;
  }
}

function updateObjectTransforms() {
  for (const vehicle of STATE.vehicles) {
    const mesh = vehicleGroup.children.find((child) => child.userData?.id === vehicle.id);
    if (!mesh) continue;
    const spec = vehicle._spec || vehicleSpecFor(vehicle.type);
    mesh.position.set(vehicle.position.x, spec.height / 2 + 0.05, vehicle.position.z);
    mesh.rotation.y = vehicle.heading;
  }

  // traffic light colors
  if (STATE.world) {
    for (const city of STATE.world.cities) {
      for (const node of city.intersections) {
        if (node._trafficRefs) {
          const s = node.light.state;
          const nsGreen = s === 'ns' || s === 'ns-yellow';
          const ewGreen = s === 'ew' || s === 'ew-yellow';
          node._trafficRefs.topLight.material.color.set(nsGreen ? HOLO.ok : (s === 'ns-yellow' ? HOLO.warn : HOLO.danger));
          node._trafficRefs.bottomLight.material.color.set(ewGreen ? HOLO.ok : (s === 'ew-yellow' ? HOLO.warn : HOLO.danger));
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pedestrians — world coords
// ---------------------------------------------------------------------------
function buildPedestrians() {
  const mat = makeAccentMaterial(HOLO.cyanSoft, 1.2);
  for (const ped of STATE.pedestrians) {
    const group = new THREE.Group();
    group.userData = { kind: 'pedestrian', id: ped.id };
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 0.9, 6), mat);
    body.position.y = 0.9;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), mat);
    head.position.y = 1.55;
    group.add(body, head);
    group.position.set(ped.position.x, 0, ped.position.z);
    pedestrianGroup.add(group);
  }
}

function updatePedestrianTransforms() {
  for (const ped of STATE.pedestrians) {
    const mesh = pedestrianGroup.children.find((c) => c.userData?.id === ped.id);
    if (!mesh) continue;
    mesh.position.set(ped.position.x, 0, ped.position.z);
    mesh.rotation.y = ped.heading || 0;
  }
}

// ---------------------------------------------------------------------------
// Render orchestration
// ---------------------------------------------------------------------------
function renderScene() {
  if (!STATE.world) return;

  cityGroup.clear();
  highwayGroup.clear();
  vehicleGroup.clear();
  pedestrianGroup.clear();

  initSharedMaterials();
  console.log('City render data', STATE.world.cities.map((city) => ({
    id: city.id,
    buildings: city.buildings.length,
    roads: city.roads.length,
    markings: city.roadMarkings?.length ?? 0,
    infrastructure: city.infrastructure?.length ?? 0,
  })));
  for (const city of STATE.world.cities) {
    const cityNode = new THREE.Group();
    cityNode.position.set(city.origin[0], 0, city.origin[1]);
    cityNode.userData = { kind: 'city', id: city.id };

    makeCityGround(city, cityNode);
    makeCityRoads(city, cityNode);
    makeCityRoadMarkings(city, cityNode);
    makeCityCrosswalks(city, cityNode);
    makeCityStreetlights(city, cityNode);
    makeCityTrafficLights(city, cityNode);
    makeCityTrees(city, cityNode);
    makeCityStreetFurniture(city, cityNode);
    makeCityBuildings(city, cityNode);
    makeCityInfrastructure(city, cityNode);

    cityGroup.add(cityNode);
    cityGroup.add(makeCityLabel(city));
  }

  makeHighways();
  buildVehicles();
  buildPedestrians();

  updateObjectTransforms();
  updatePedestrianTransforms();
  updateSummary();
  holoMaterials = collectHoloMaterials(scene);
}

function centerCameraOnWorld() {
  if (!STATE.world || !STATE.world.bounds) return;
  const b = STATE.world.bounds;
  const cx = b.centerX;
  const cz = b.centerZ;
  const halfWidth = (b.maxX - b.minX) / 2;
  const halfDepth = (b.maxZ - b.minZ) / 2;
  const radius = Math.hypot(halfWidth, halfDepth, 45);
  const verticalFov = THREE.MathUtils.degToRad(camera.fov);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
  const limitingFov = Math.min(verticalFov, horizontalFov);
  const distance = Math.max(radius / Math.sin(limitingFov / 2) * 1.12, 500);
  const targetY = 24;
  controls.target.set(cx, targetY, cz);
  const viewDirection = new THREE.Vector3(0.35, 0.72, 0.9).normalize();
  camera.position.set(cx, targetY, cz).addScaledVector(viewDirection, distance);
  controls.maxDistance = 8000;
  controls.minDistance = 20;
  controls.enablePan = true;
  controls.enableZoom = true;
  controls.enableRotate = true;
  controls.update();
  const worldSpan = Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 1200);
  scene.fog = new THREE.Fog(HOLO.deep, Math.max(700, worldSpan * 0.75), Math.max(3500, worldSpan * 3.2));
}

function animateCamera() {
  if (STATE.viewMode === 'fpv') return;
  if (STATE.followId) {
    const vehicle = STATE.vehicles.find((v) => v.id === STATE.followId);
    if (vehicle) {
      const target = new THREE.Vector3(vehicle.position.x, 1.5, vehicle.position.z);
      const forward = new THREE.Vector3(Math.sin(vehicle.heading), 0, Math.cos(vehicle.heading));
      const offset = forward.clone().multiplyScalar(-18).add(new THREE.Vector3(0, 7, 0));
      const desired = target.clone().add(offset);
      camera.position.lerp(desired, 0.08);
      const lookTarget = target.clone().add(forward.clone().multiplyScalar(20));
      controls.target.lerp(lookTarget, 0.12);
      controls.update();
      return;
    }
  }
}

function frameLocalCity(city) {
  if (!city) return;
  controls.target.set(city.origin[0], 12, city.origin[1]);
  camera.position.set(city.origin[0] + 145, 155, city.origin[1] + 190);
  controls.update();
}

function enterFpv() {
  const direction = controls.target.clone().sub(camera.position);
  const horizontal = Math.hypot(direction.x, direction.z);
  STATE.fpv.previousViewMode = STATE.viewMode;
  STATE.fpv.previousCamera = {
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
    fov: camera.fov,
    target: controls.target.clone(),
  };
  STATE.fpv.yaw = Math.atan2(-direction.x, -direction.z);
  STATE.fpv.pitch = Math.atan2(direction.y, horizontal);
  camera.position.y = Math.max(1.7, camera.position.y);
  camera.fov = 70;
  camera.updateProjectionMatrix();
  camera.rotation.order = 'YXZ';
  camera.rotation.set(STATE.fpv.pitch, STATE.fpv.yaw, 0);
  controls.enabled = false;
}

function leaveFpv() {
  const previous = STATE.fpv.previousCamera;
  if (previous) {
    camera.position.copy(previous.position);
    camera.quaternion.copy(previous.quaternion);
    camera.fov = previous.fov;
    camera.updateProjectionMatrix();
    controls.target.copy(previous.target);
  }
  controls.enabled = true;
  STATE.fpv.keys.clear();
  STATE.fpv.pointerId = null;
  controls.update();
}

function setViewMode(mode, restorePreviousCamera = false) {
  if (STATE.viewMode === 'fpv' && mode !== 'fpv') leaveFpv();
  if (mode === 'fpv' && STATE.viewMode !== 'fpv') enterFpv();
  STATE.viewMode = mode;

  if (restorePreviousCamera) return syncUI();
  if (mode === 'world') centerCameraOnWorld();
  else if (mode === 'local') {
    const city = STATE.world.cities.find((item) => item.id === STATE.focusedCityId) || STATE.world.cities[0];
    STATE.focusedCityId = city.id;
    frameLocalCity(city);
  }
  syncUI();
}

function updateFpvMovement(deltaTime) {
  const keys = STATE.fpv.keys;
  const forward = Number(keys.has('w') || keys.has('arrowup')) - Number(keys.has('s') || keys.has('arrowdown'));
  const strafe = Number(keys.has('d') || keys.has('arrowright')) - Number(keys.has('a') || keys.has('arrowleft'));
  if (forward === 0 && strafe === 0) return;

  const movement = new THREE.Vector3(-Math.sin(STATE.fpv.yaw) * forward - Math.cos(STATE.fpv.yaw) * strafe, 0,
    -Math.cos(STATE.fpv.yaw) * forward + Math.sin(STATE.fpv.yaw) * strafe);
  movement.normalize().multiplyScalar(32 * deltaTime);
  camera.position.add(movement);
  camera.position.y = 1.7;
}

function inspectAt(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, camera);
  const roots = [...vehicleGroup.children, ...cityGroup.children];
  const hits = raycaster.intersectObjects(roots, true);
  if (!hits.length) {
    clearSelection();
    return;
  }
  let owner = hits[0].object;
  while (owner && !['vehicle', 'building'].includes(owner.userData?.kind)) owner = owner.parent;
  const data = owner?.userData ?? hits[0].object.userData ?? null;

  if (data?.kind === 'vehicle' && data.id) setVehicleSelection(data.id);
  else if (data?.kind === 'building' && data.id) setBuildingSelection(data.id, data.cityId);
  else clearSelection();
}

// ---------------------------------------------------------------------------
// Stats bar
// ---------------------------------------------------------------------------
let fpsAccum = 0;
let fpsFrames = 0;

function updateStats(dt) {
  statTime.textContent = formatTime(STATE.simTime);
  statVehicles.textContent = String(STATE.stats.total);
  statMoving.textContent = String(STATE.stats.moving);
  statStopped.textContent = String(STATE.stats.stopped);

  fpsAccum += dt;
  fpsFrames += 1;
  if (fpsAccum >= 0.5) {
    statFps.textContent = String(Math.round(fpsFrames / fpsAccum));
    fpsAccum = 0;
    fpsFrames = 0;
  }
}

function computeLocalStats() {
  const total = STATE.vehicles.length;
  let moving = 0;
  for (const v of STATE.vehicles) if (v.status === 'moving') moving++;
  STATE.stats = {
    total,
    moving,
    stopped: total - moving,
    pedestrians: STATE.pedestrians.length,
  };
}

// ---------------------------------------------------------------------------
// Minimap
// ---------------------------------------------------------------------------
function worldToMinimap(x, z) {
  if (!STATE.world) return { mx: 0, my: 0 };
  const { minX, maxX, minZ, maxZ } = STATE.world.bounds;
  const size = minimapCanvas.width;
  const pad = 6;
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  const span = Math.max(spanX, spanZ);
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;

  const mx = ((x - (cx - span / 2)) / span) * (size - pad * 2) + pad;
  const my = ((z - (cz - span / 2)) / span) * (size - pad * 2) + pad;
  return { mx, my };
}

function drawMinimap() {
  if (!STATE.world) return;
  const ctx = minimapCtx;
  const size = minimapCanvas.width;

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(4, 7, 13, 0.9)';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(57, 255, 216, 0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, size - 1, size - 1);

  ctx.strokeStyle = 'rgba(57, 255, 216, 0.55)';
  ctx.lineWidth = 1.4;
  for (const hw of STATE.world.highways) {
    const p = worldToMinimap(hw.a.x, hw.a.z);
    const q = worldToMinimap(hw.b.x, hw.b.z);
    ctx.beginPath();
    ctx.moveTo(p.mx, p.my);
    ctx.lineTo(q.mx, q.my);
    ctx.stroke();
  }

  for (const city of STATE.world.cities) {
    const ox = city.origin[0];
    const oz = city.origin[1];

    ctx.strokeStyle = 'rgba(57, 255, 216, 0.18)';
    ctx.lineWidth = 0.6;
    for (const road of city.roads) {
      const p = worldToMinimap(
        ox + (road.axis === 'x' ? road.from : road.pos),
        oz + (road.axis === 'x' ? road.pos : road.from)
      );
      const q = worldToMinimap(
        ox + (road.axis === 'x' ? road.to : road.pos),
        oz + (road.axis === 'x' ? road.pos : road.to)
      );
      ctx.beginPath();
      ctx.moveTo(p.mx, p.my);
      ctx.lineTo(q.mx, q.my);
      ctx.stroke();
    }

    for (const b of city.buildings) {
      const { mx, my } = worldToMinimap(ox + b.position[0], oz + b.position[2]);
      let color = 'rgba(57, 255, 216, 0.55)';
      if (b.type === 'hospital') color = 'rgba(255, 59, 59, 0.85)';
      else if (b.type === 'police') color = 'rgba(59, 122, 255, 0.85)';
      else if (b.type === 'fire') color = 'rgba(255, 106, 59, 0.85)';
      else if (b.type === 'energy') color = 'rgba(57, 255, 216, 0.9)';
      else if (b.type === 'school') color = 'rgba(255, 217, 59, 0.85)';
      else if (b.type === 'transit') color = 'rgba(160, 107, 255, 0.85)';
      ctx.fillStyle = color;
      const w = Math.max(1, (b.width / 200) * size * 0.4);
      const h = Math.max(1, (b.depth / 200) * size * 0.4);
      ctx.fillRect(mx - w / 2, my - h / 2, w, h);
    }

    const center = worldToMinimap(ox, oz);
    ctx.fillStyle = 'rgba(57, 255, 216, 0.9)';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(city.name, center.mx, center.my - 8);
  }

  ctx.fillStyle = 'rgba(200, 255, 240, 0.5)';
  for (const p of STATE.pedestrians) {
    const { mx, my } = worldToMinimap(p.position.x, p.position.z);
    ctx.fillRect(mx, my, 1, 1);
  }

  for (const v of STATE.vehicles) {
    const { mx, my } = worldToMinimap(v.position.x, v.position.z);
    if (v.id === STATE.selectedVehicleId) ctx.fillStyle = '#ffffff';
    else if (v.type === 'emergency') ctx.fillStyle = 'rgba(255, 90, 90, 1)';
    else if (v.status === 'moving') ctx.fillStyle = 'rgba(127, 251, 230, 0.95)';
    else ctx.fillStyle = 'rgba(255, 179, 71, 0.95)';
    ctx.beginPath();
    ctx.arc(mx, my, 1.4, 0, Math.PI * 2);
    ctx.fill();
  }

  const camTarget = worldToMinimap(controls.target.x, controls.target.z);
  ctx.strokeStyle = 'rgba(57, 255, 216, 0.85)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(camTarget.mx, camTarget.my, 5, 0, Math.PI * 2);
  ctx.stroke();

  minimapCoords.textContent = `X ${controls.target.x.toFixed(0)} · Z ${controls.target.z.toFixed(0)}`;
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
let ws = null;
let wsConnected = false;
let wsLastSent = 0;

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => { wsConnected = true; };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'connected') return;

    if (msg.type === 'snapshot') {
      if (msg.vehicles) STATE.vehicles = msg.vehicles;
      if (msg.pedestrians) STATE.pedestrians = msg.pedestrians;
      if (typeof msg.time === 'number') STATE.simTime = msg.time;
      if (msg.world) {
        STATE.world = msg.world;
        renderScene();
      }

      const idsMatch = vehicleGroup.children.length === STATE.vehicles.length;
      if (!idsMatch) {
        vehicleGroup.clear();
        buildVehicles();
      }
      if (pedestrianGroup.children.length !== STATE.pedestrians.length) {
        pedestrianGroup.clear();
        buildPedestrians();
      }

      updateObjectTransforms();
      updatePedestrianTransforms();
      computeLocalStats();
    }
  };

  ws.onclose = () => {
    wsConnected = false;
    setTimeout(connectWebSocket, 2000);
  };

  ws.onerror = () => { wsConnected = false; };
}

function requestTick() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (STATE.paused) return;
  const now = performance.now();
  if (now - wsLastSent < 1000 / 30) return;
  wsLastSent = now;
  ws.send(JSON.stringify({ type: 'tick', speed: STATE.speed }));
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
async function bootstrap() {
  const [worldData, vehicleData, classData, pedData] = await Promise.all([
    fetchJson('/api/world'),
    fetchJson('/api/vehicles'),
    fetchJson('/api/vehicle-classes'),
    fetchJson('/api/pedestrians'),
  ]);

  STATE.world = worldData;
  STATE.vehicles = vehicleData.vehicles;
  STATE.vehicleClasses = classData.classes;
  STATE.pedestrians = pedData.pedestrians || [];

  renderScene();
  centerCameraOnWorld();
  renderSelectionPanel();
  syncUI();
  updateSummary();
  computeLocalStats();

  connectWebSocket();

  if (viewButton) {
    viewButton.onclick = () => {
      const modes = ['world', 'local', 'fpv'];
      const currentIndex = modes.indexOf(STATE.viewMode);
      const nextMode = modes[(currentIndex + 1) % modes.length];
      setViewMode(nextMode);
    };
  }

  if (fpvButton) {
    fpvButton.onclick = () => {
      if (STATE.viewMode === 'fpv') {
        setViewMode(STATE.fpv.previousViewMode || 'world');
      } else {
        setViewMode('fpv');
      }
    };
  }

  holoButton.onclick = () => {
    STATE.holo = !STATE.holo;
    syncUI();
    renderScene();
  };

  pauseButton.onclick = () => {
    STATE.paused = !STATE.paused;
    syncUI();
  };

  speedButton.onclick = () => {
    const cycle = [1, 2, 0.5];
    const i = cycle.indexOf(STATE.speed);
    STATE.speed = cycle[(i + 1) % cycle.length];
    syncUI();
    if (minimapZoomEl) minimapZoomEl.textContent = `${STATE.speed}×`;
  };

  const canvas = renderer.domElement;
  canvas.style.touchAction = 'none';
  const pointerGesture = { id: null, x: 0, y: 0, moved: false };
  const dragThreshold = 5;

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (STATE.viewMode === 'fpv') {
      STATE.fpv.pointerId = event.pointerId;
      STATE.fpv.lastX = event.clientX;
      STATE.fpv.lastY = event.clientY;
      pointerGesture.id = event.pointerId;
      pointerGesture.x = event.clientX;
      pointerGesture.y = event.clientY;
      pointerGesture.moved = false;
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    pointerGesture.id = event.pointerId;
    pointerGesture.x = event.clientX;
    pointerGesture.y = event.clientY;
    pointerGesture.moved = false;
  });

  canvas.addEventListener('pointermove', (event) => {
    if (pointerGesture.id !== event.pointerId) return;
    const dx = event.clientX - pointerGesture.x;
    const dy = event.clientY - pointerGesture.y;
    if (Math.hypot(dx, dy) >= dragThreshold) pointerGesture.moved = true;
    if (STATE.viewMode !== 'fpv' || STATE.fpv.pointerId !== event.pointerId) return;

    STATE.fpv.yaw -= dx * 0.003;
    STATE.fpv.pitch = THREE.MathUtils.clamp(STATE.fpv.pitch - dy * 0.003, -Math.PI * 0.472, Math.PI * 0.472);
    camera.rotation.set(STATE.fpv.pitch, STATE.fpv.yaw, 0);
    pointerGesture.x = event.clientX;
    pointerGesture.y = event.clientY;
  });

  const finishPointer = (event) => {
    if (pointerGesture.id !== event.pointerId) return;
    if (!pointerGesture.moved) inspectAt(event.clientX, event.clientY);
    pointerGesture.id = null;
    if (STATE.fpv.pointerId === event.pointerId) STATE.fpv.pointerId = null;
  };
  canvas.addEventListener('pointerup', finishPointer);
  canvas.addEventListener('pointercancel', (event) => {
    if (pointerGesture.id === event.pointerId) pointerGesture.id = null;
    if (STATE.fpv.pointerId === event.pointerId) STATE.fpv.pointerId = null;
  });

  const movementKeys = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
  window.addEventListener('keydown', (event) => {
    if (STATE.viewMode !== 'fpv') return;
    const key = event.key.toLowerCase();
    if (key === 'escape') {
      setViewMode(STATE.fpv.previousViewMode || 'world', true);
      return;
    }
    if (movementKeys.has(key)) {
      STATE.fpv.keys.add(key);
      event.preventDefault();
    }
  });
  window.addEventListener('keyup', (event) => STATE.fpv.keys.delete(event.key.toLowerCase()));
  window.addEventListener('blur', () => STATE.fpv.keys.clear());

  const clock = new THREE.Clock();
  let lastTime = 0;
  let minimapAccum = 0;

  function tick() {
    requestAnimationFrame(tick);

    const t = clock.getElapsedTime();
    const dt = Math.min(0.1, t - lastTime);
    lastTime = t;

    requestTick();

    if (!STATE.paused) {
      STATE.simTime += dt * STATE.speed;
    }

    updateStats(dt);
    updateHoloTime(holoMaterials, t);
    holoOverlay.uniforms.uTime.value = t;

    minimapAccum += dt;
    if (minimapAccum >= 1 / 20) {
      drawMinimap();
      minimapAccum = 0;
    }

    if (STATE.viewMode === 'fpv') updateFpvMovement(dt);
    else {
      animateCamera();
      controls.update();
    }
    composer.render();
  }

  tick();
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloom.setSize(window.innerWidth, window.innerHeight);
});

bootstrap().catch((err) => {
  console.error('Bootstrap failed:', err);
});