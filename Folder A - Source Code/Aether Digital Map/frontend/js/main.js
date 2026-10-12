// frontend/js/main.js
// ---------------------------------------------------------------------------
// AETHER DIGITAL TWIN — entry point.
//
// This file is a wiring harness. It:
//   1. boots the DigitalTwin scene
//   2. reads locations.json and populates the picker
//   3. loads the selected GLB via CityLoader  (one location = one GLB)
//   4. opens the WebSocket to the Python backend
//   5. routes incoming simulation frames to the actor modules
//   6. places the police-station marker at a real-world coordinate
//   7. exposes console helpers for demo use (AETHER.triggerSOS, etc.)
//
// It does NOT define renderers, materials, actors, or UI. Those live in
// digital-twin.js, materials.js, ambulances.js, drones.js, cars.js,
// emergency.js, police-station.js, ui.js.
// ---------------------------------------------------------------------------

import { DigitalTwin } from './digital-twin.js';
import { CityLoader }  from './city-loader.js';
import { UI }          from './ui.js';

import { Ambulances }  from './ambulances.js';
import { Drones }      from './drones.js';
import { Cars }        from './cars.js';
import { Emergency }      from './emergency.js';
import { PoliceStation }  from './police-station.js';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const viewport     = document.getElementById('viewport');
const loadingEl    = document.getElementById('twin-loading');
const loadingText  = document.getElementById('twin-loading-detail');
const summaryEl    = document.getElementById('status-summary');
const eyebrowEl    = document.getElementById('hud-eyebrow');
const headlineEl   = document.getElementById('hud-headline');
const locationSel  = document.getElementById('location-select');

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main() {
  // ----- 1. Scene --------------------------------------------------------
  const twin = new DigitalTwin(viewport, {
    onFps: (fps) => UI.setFps(fps),
    onCameraMove: (x, z, zoom) => UI.setMinimapCoords(x, z, zoom),
  });

  // ----- 2. UI -----------------------------------------------------------
  const ui = new UI(twin, {
    onToggleHolo:  (enabled) => twin.setRenderMode(enabled ? 'holo' : 'real'),
    onTogglePause: (paused)  => twin.setPaused(paused),
    onCycleSpeed:  (speed)   => twin.setSpeed(speed),
    onToggleView:  (mode)    => { /* camera view mode handled later */ },
  });
  ui.attach();

  // ----- 3. City loader --------------------------------------------------
  const cityLoader = new CityLoader(twin.getScene(), {
    onStatus:   (msg) => { if (loadingText) loadingText.textContent = msg; },
    onProgress: (loaded, total) => {
      if (!loadingText) return;
      if (total) loadingText.textContent =
        `loading model · ${Math.round((loaded / total) * 100)}%`;
      else       loadingText.textContent =
        `loading model · ${(loaded / 1024 / 1024).toFixed(1)} MB`;
    },
  });

  // ----- 4. Actor systems ------------------------------------------------
  const ambulances = new Ambulances(twin, cityLoader);
  const drones     = new Drones(twin, cityLoader);
  const cars       = new Cars(twin, cityLoader);
  const emergency  = new Emergency(twin, cityLoader, ambulances, drones);

  // Hand the actors a reference to the UI so they can push minimap markers
  // and (later) receive click-to-inspect events.
  ambulances.attachToUI(ui);
  drones.attachToUI(ui);
  cars.attachToUI(ui);

  // Tell the UI where the live actors are so click-to-inspect can find them.
  ui.attachActors({ ambulances, drones, cars });

  // Route follow-toggle into the twin's chase cam.
  ui.onFollowToggle = (actorId) => {
    if (!actorId) { twin.unfollowActor(); return; }
    const amb = ambulances.getById(actorId);
    if (amb) { twin.followActor(amb.root); return; }
    const drn = drones.getById(actorId);
    if (drn) { twin.followActor(drn.root); return; }
  };

  // ----- 4b. Police Station ---------------------------------------------
  // Placed at a real coordinate inside the Mankweng GLB footprint.
  // Tune lat/lon here, or from the console with:
  //   AETHER.policeStation.setLocation(-23.XXXXX, 29.XXXXX)
  const policeStation = new PoliceStation(twin, cityLoader, {
    name: 'Mankweng Police Station',
    lat:  -23.8890,
    lon:   29.7260,
  });

  // ----- 5. Load locations registry -------------------------------------
  const registry = await fetch('/static/models/locations.json')
    .then((r) => r.json())
    .catch((err) => {
      console.error('locations.json could not be read:', err);
      return { locations: [] };
    });

  if (!registry.locations?.length) {
    if (loadingText) loadingText.textContent = 'no locations available';
    return;
  }

  // Populate the picker (safe if the DOM element is missing).
  if (locationSel) {
    locationSel.innerHTML = '';
    for (const loc of registry.locations) {
      const opt = document.createElement('option');
      opt.value = loc.id;
      opt.textContent = loc.name;
      locationSel.appendChild(opt);
    }
  }

  // ----- 6. Load the first location -------------------------------------
  await loadLocation(registry.locations[0]);

  locationSel?.addEventListener('change', async (e) => {
    const loc = registry.locations.find((l) => l.id === e.target.value);
    if (loc) await loadLocation(loc);
  });

  async function loadLocation(loc) {
    loadingEl?.classList.remove('hidden');
    try {
      const meta = await cityLoader.load(loc.meta);
      twin.fitToBounds(cityLoader.getBounds());

      // Update HUD — defensive against missing meta fields.
      const displayName = (meta?.name || loc?.name || 'UNKNOWN').toUpperCase();
      const sizeKm      = (typeof meta?.size_km === 'number')
                            ? meta.size_km
                            : '—';
      const source      = meta?.source || 'real-world';

      if (eyebrowEl)  eyebrowEl.textContent  = `AETHER · ${displayName}`;
      if (headlineEl) headlineEl.textContent = 'DIGITAL TWIN';
      if (summaryEl)  summaryEl.textContent  = `${sizeKm} km² · ${source}`;

      // Hand the new city to the UI (bounds, labels, minimap) and to the
      // actor systems (so they can discard stale actors and re-seat).
      ui.onCityChanged(cityLoader);
      ambulances.onCityChanged(cityLoader);
      drones.onCityChanged(cityLoader);
      cars.onCityChanged(cityLoader);
      emergency.onCityChanged(cityLoader);
      policeStation.onCityChanged(cityLoader);
    } catch (err) {
      console.error('Location load failed:', err);
      if (loadingText) loadingText.textContent = `failed: ${err.message}`;
    } finally {
      setTimeout(() => loadingEl?.classList.add('hidden'), 350);
    }
  }

  // ----- 7. Backend WebSocket -------------------------------------------
  connectBackend(twin, {
    onInit:     (frame) => {
      ambulances.setFrame(frame.assets?.filter((a) => a.kind === 'ambulance'));
      drones.setFrame    (frame.assets?.filter((a) => a.kind === 'drone'));
      cars.setFrame      (frame.assets?.filter((a) => a.kind === 'car'));
      emergency.setPatients(frame.patients || []);
    },
    onSnapshot: (frame) => {
      ambulances.setFrame(frame.assets?.filter((a) => a.kind === 'ambulance'));
      drones.setFrame    (frame.assets?.filter((a) => a.kind === 'drone'));
      cars.setFrame      (frame.assets?.filter((a) => a.kind === 'car'));
      emergency.setPatients(frame.patients || []);
    },
    onEmergency: (frame) => emergency.trigger(frame.patient, frame.assigned),
  });

  // ----- 8. Wire the sim clock into UI stats ----------------------------
  setInterval(() => {
    UI.setSimTime(twin.getSimTime());
    UI.setAssetCounts(ambulances.count(), drones.count(), emergency.activeCount());
  }, 250);

  // ----- 9. Console helpers (demo use) ----------------------------------
  // Exposes a small API for triggering and inspecting the demo from the
  // browser console. Everything below is safe to call at any time.
  window.AETHER = {
    twin, cityLoader, ambulances, drones, cars, emergency, policeStation, ui,

    /**
     * Trigger a patient SOS.
     *   AETHER.triggerSOS()                         → random near Mankweng centre
     *   AETHER.triggerSOS(lat, lon)                 → explicit location
     *   AETHER.triggerSOS(lat, lon, { heartRate: 180, spo2: 70 })
     */
    triggerSOS(lat, lon, vitals) {
      const body = {};
      if (typeof lat === 'number') body.lat = lat;
      if (typeof lon === 'number') body.lon = lon;
      if (vitals) body.vitals = vitals;

      return fetch('/api/emergency/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then((r) => r.json())
        .then((res) => { console.info('[AETHER] SOS fired:', res); return res; })
        .catch((err) => { console.error('[AETHER] SOS failed:', err); });
    },

    /** Resolve every active emergency. */
    resolveAll() {
      const ids = [...emergency.active.keys()];
      return Promise.all(
        ids.map((id) =>
          fetch(`/api/emergency/${id}/resolve`, { method: 'POST' })
        )
      );
    },

    /**
     * Follow an actor by id (ambulance or drone).
     *   AETHER.follow('AMB-01')
     *   AETHER.follow(null)        → stop following
     */
    follow(id) {
      if (!id) { twin.unfollowActor(); return; }
      const a = ambulances.getById(id) || drones.getById(id);
      if (a) twin.followActor(a.root);
    },
  };
}

// ---------------------------------------------------------------------------
// Backend WebSocket
//
// `twin` is passed in explicitly — it lives inside main(), but the tick
// pings need to read twin.getSpeed(). Earlier versions referenced `twin`
// inside this function and silently swallowed the ReferenceError inside a
// try/catch, which meant the backend never advanced time and nothing moved.
// ---------------------------------------------------------------------------
function connectBackend(twin, handlers) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  let lastSent = 0;

  function open() {
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => console.info('[AETHER] backend connected');

    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case 'init':      handlers.onInit?.(msg);      break;
        case 'snapshot':  handlers.onSnapshot?.(msg);  break;
        case 'emergency': handlers.onEmergency?.(msg); break;
        case 'connected': /* ack */                     break;
      }
    };

    ws.onclose = () => {
      console.warn('[AETHER] backend disconnected, retrying…');
      setTimeout(open, 2000);
    };

    ws.onerror = () => { /* onclose will fire */ };
  }

  open();

  // Ping the sim at 20 Hz.
  setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    if (now - lastSent < 1000 / 20) return;
    lastSent = now;
    try {
      const speed = (twin && typeof twin.getSpeed === 'function')
        ? twin.getSpeed()
        : 1.0;
      ws.send(JSON.stringify({ type: 'tick', speed }));
    } catch (err) {
      // Deliberately silent — a dropped tick is not worth spamming the
      // console. If you're debugging motion that won't start, log here.
    }
  }, 50);
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------
main().catch((err) => {
  console.error('[AETHER] boot failed:', err);
  const el = document.getElementById('twin-loading-detail');
  if (el) el.textContent = `boot failed: ${err.message}`;
});