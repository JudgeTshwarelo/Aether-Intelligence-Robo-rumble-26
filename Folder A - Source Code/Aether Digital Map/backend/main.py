# backend/main.py
# ---------------------------------------------------------------------------
# AETHER DIGITAL TWIN — backend.
#
# After the architecture pivot, this backend no longer generates synthetic
# cities, traffic, or geometry. The world is a real urban:EXPORT GLB loaded
# by the frontend. The backend's job is intelligence:
#
#   • track simulated ambulance / drone / patient state
#   • drive traffic on the real road network (or a synthetic grid fallback)
#   • assign responders to emergencies and pick a destination hospital
#   • stream snapshots over WebSocket
#   • proxy the ESP32 wearable and camera (unchanged from before)
#
# Static files (`/static/*`) are served from the frontend directory, so
# `frontend/models/mankweng/mankweng.glb` is reachable at
# `/static/models/mankweng/mankweng.glb`.
# ---------------------------------------------------------------------------

from __future__ import annotations

import json
import math
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from backend.geo.road_network         import RoadNetwork
from backend.intelligence.detection   import analyse_patient
from backend.intelligence.allocation  import assign_nearest
from backend.simulation.ambulance     import Ambulance
from backend.simulation.drone         import Drone
from backend.simulation.patient       import Patient
from backend.simulation.traffic       import TrafficSystem

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title='AETHER Digital Twin', version='2.0.0')

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------
project_root = Path(__file__).resolve().parents[1]
frontend_dir = project_root / 'frontend'

if frontend_dir.exists():
    app.mount('/static', StaticFiles(directory=str(frontend_dir)), name='static')


def _resolve(filename: str) -> Path:
    for base in (frontend_dir, project_root):
        candidate = base / filename
        if candidate.exists():
            return candidate
    return frontend_dir / filename


@app.get('/')
def serve_index() -> FileResponse:
    return FileResponse(_resolve('index.html'))

# ---------------------------------------------------------------------------
# Mankweng reference — loaded from the same meta.json the frontend uses, so
# the backend's idea of "inside the city" always matches the GLB footprint.
# ---------------------------------------------------------------------------
def _load_mankweng_bounds() -> Dict[str, float]:
    """
    Return {center_lat, center_lon, half_lat, half_lon} for Mankweng.
    Falls back to safe defaults if meta.json can't be read.
    """
    meta_path = frontend_dir / 'models' / 'mankweng' / 'meta.json'
    try:
        meta = json.loads(meta_path.read_text(encoding='utf-8'))
    except Exception as exc:
        print(f'[sim] could not read {meta_path}: {exc!r} — using defaults')
        return {
            'center_lat': -23.88972,
            'center_lon':  29.72615,
            'half_lat':    0.0055,
            'half_lon':    0.0055,
        }

    center = meta.get('center', {})
    bounds = meta.get('bounds', {})

    if 'north' in bounds and 'south' in bounds:
        half_lat = (bounds['north'] - bounds['south']) / 2.0
    else:
        half_lat = 0.0055

    if 'east' in bounds and 'west' in bounds:
        half_lon = (bounds['east'] - bounds['west']) / 2.0
    else:
        half_lon = 0.0055

    return {
        'center_lat': float(center.get('lat', -23.88972)),
        'center_lon': float(center.get('lon',  29.72615)),
        'half_lat':   half_lat,
        'half_lon':   half_lon,
    }


_MANKWENG = _load_mankweng_bounds()


# ---------------------------------------------------------------------------
# Hospitals (real-world coordinates).
#
# The demo uses one hospital. Add more entries here when you download other
# cities — the assignment logic picks the nearest to each new patient.
#
# The frontend has the same list (see main.js) so the visual marker and the
# backend destination always agree.
# ---------------------------------------------------------------------------
HOSPITALS: List[Dict[str, Any]] = [
    {
        'id':   'HOSP-MANKWENG',
        'name': 'Mankweng Hospital',
        'lat':  -23.8879,
        'lon':   29.7479,
    },
]


def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres."""
    R = 6371000.0
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (math.sin(d_lat / 2) ** 2
         + math.cos(math.radians(lat1))
         * math.cos(math.radians(lat2))
         * math.sin(d_lon / 2) ** 2)
    return 2 * R * math.asin(min(1.0, math.sqrt(a)))


def _nearest_hospital(lat: float, lon: float) -> Optional[Dict[str, Any]]:
    """Return the closest hospital to (lat, lon), or None if list is empty."""
    if not HOSPITALS:
        return None
    best = None
    best_d = float('inf')
    for h in HOSPITALS:
        d = _haversine(lat, lon, h['lat'], h['lon'])
        if d < best_d:
            best_d = d
            best = h
    return best

def _random_mankweng_point() -> tuple[float, float]:
    """Pick a random point within the Mankweng GLB footprint."""
    import random
    lat = _MANKWENG['center_lat'] + (random.random() - 0.5) * 2 * _MANKWENG['half_lat']
    lon = _MANKWENG['center_lon'] + (random.random() - 0.5) * 2 * _MANKWENG['half_lon']
    return lat, lon
def _seed_default_fleet(self) -> None:
    # Spawn the fleet at points scattered inside the GLB footprint.
    def _rand_inside() -> tuple[float, float]:
        import random
        return _random_mankweng_point()

    for i in range(1, 4):
        lat, lon = _rand_inside()
        aid = f'AMB-{i:02d}'
        self.ambulances[aid] = Ambulance(id=aid, lat=lat, lon=lon)

    for i in range(1, 3):
        lat, lon = _rand_inside()
        did = f'DRN-{i:02d}'
        self.drones[did] = Drone(id=did, lat=lat, lon=lon)

# ---------------------------------------------------------------------------
# Simulation state (in-memory, single-process)
# ---------------------------------------------------------------------------
class Simulation:
    """
    Holds the current fleet, traffic, and patients. Nothing about geometry
    lives here — the frontend has the GLB. We track ids, GPS positions, and
    status so we can compute assignments and stream frames.
    """

    # Which location the sim is driving. Change if you swap cities.
    DEFAULT_CITY = 'mankweng'

    def __init__(self) -> None:
        self.time: float = 0.0
        self.ambulances: Dict[str, Ambulance] = {}
        self.drones:     Dict[str, Drone]     = {}
        self.patients:   Dict[str, Patient]   = {}

        # --- Road network & traffic --------------------------------------
        self._roads  = self._load_road_network(self.DEFAULT_CITY)
        self.traffic = TrafficSystem(self._roads, count=20)

        self._seed_default_fleet()

    # -----------------------------------------------------------------------
    # Bootstrapping
    # -----------------------------------------------------------------------

    def _load_road_network(self, city: str) -> RoadNetwork:
        """
        Load `frontend/models/<city>/roads.json` if present, else synthesize
        a grid from `<city>/meta.json`. Either way, we get a graph the
        traffic system can drive on.
        """
        city_dir    = frontend_dir / 'models' / city
        roads_path  = city_dir / 'roads.json'
        meta_path   = city_dir / 'meta.json'

        meta: Optional[dict] = None
        try:
            meta = json.loads(meta_path.read_text(encoding='utf-8'))
        except Exception as exc:
            print(f'[sim] could not read {meta_path}: {exc!r}')

        return RoadNetwork(roads_json_path=roads_path, meta=meta)

    def _seed_default_fleet(self) -> None:
        # Fleet base locations, scattered across the Mankweng GLB footprint
        # (GLB centre is -23.88972, 29.72615).
        fleet = [
            ('AMB-01', -23.8880, 29.7285),
            ('AMB-02', -23.8915, 29.7240),
            ('AMB-03', -23.8890, 29.7290),
        ]
        for aid, lat, lon in fleet:
            self.ambulances[aid] = Ambulance(id=aid, lat=lat, lon=lon)

        drone_fleet = [
            ('DRN-01', -23.8905, 29.7265),
            ('DRN-02', -23.8890, 29.7250),
        ]
        for did, lat, lon in drone_fleet:
            self.drones[did] = Drone(id=did, lat=lat, lon=lon)

    # -----------------------------------------------------------------------
    # Simulation step
    # -----------------------------------------------------------------------

    def tick(self, dt: float) -> None:
        """Advance every moving actor by dt seconds."""
        self.time += dt

        for a in self.ambulances.values():
            a.step(dt, patients=self.patients)

        for d in self.drones.values():
            d.step(dt, patients=self.patients)

        # Traffic moves with the fleet, so cars can pull aside for
        # responding ambulances.
        self.traffic.step(dt, ambulances=list(self.ambulances.values()))

    # -----------------------------------------------------------------------
    # Emergency handling
    # -----------------------------------------------------------------------

    def create_emergency(
        self,
        lat: float,
        lon: float,
        vitals: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Register a new patient, decide priority, assign an ambulance and
        drone, pick the nearest hospital as destination, and return the
        frame that will be broadcast to every client.
        """
        patient = Patient(lat=lat, lon=lon, vitals=vitals or {})
        patient.priority = analyse_patient(patient)

        # --- Hospital destination --------------------------------------
        hospital = _nearest_hospital(lat, lon)
        if hospital:
            patient.hospital = hospital['name']

        self.patients[patient.id] = patient

        ambulance = assign_nearest(
            list(self.ambulances.values()),
            patient,
            require_status=('idle', 'patrolling'),
        )
        drone = assign_nearest(
            list(self.drones.values()),
            patient,
            require_status=('idle', 'patrolling'),
        )

        assigned: Dict[str, Any] = {}
        if ambulance:
            ambulance.task_patient = patient.id
            ambulance.status = 'responding'
            assigned['ambulanceId'] = ambulance.id
            assigned['etaSeconds']  = ambulance.eta_to(patient)
        if drone:
            drone.task_patient = patient.id
            drone.status = 'responding'
            assigned['droneId']    = drone.id
            assigned['etaSeconds'] = drone.eta_to(patient)

        if hospital:
            assigned['hospitalId']   = hospital['id']
            assigned['hospitalName'] = hospital['name']
            assigned['hospitalLat']  = hospital['lat']
            assigned['hospitalLon']  = hospital['lon']

        return {
            'type':     'emergency',
            'patient':  patient.to_dict(),
            'assigned': assigned,
        }

    def resolve_emergency(self, patient_id: str) -> None:
        self.patients.pop(patient_id, None)
        for a in self.ambulances.values():
            if a.task_patient == patient_id:
                a.task_patient = None
                a.status = 'patrolling'
        for d in self.drones.values():
            if d.task_patient == patient_id:
                d.task_patient = None
                d.status = 'patrolling'

    # -----------------------------------------------------------------------
    # Frame serialisation
    # -----------------------------------------------------------------------

    def init_frame(self) -> Dict[str, Any]:
        return {
            'type':     'init',
            'assets':   self._assets_frame(),
            'patients': self._patients_frame(),
            'time':     self.time,
        }

    def snapshot_frame(self) -> Dict[str, Any]:
        return {
            'type':     'snapshot',
            'assets':   self._assets_frame(),
            'patients': self._patients_frame(),
            'time':     self.time,
        }

    def _assets_frame(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for a in self.ambulances.values():
            out.append(a.to_dict(kind='ambulance'))
        for d in self.drones.values():
            out.append(d.to_dict(kind='drone'))
        # Cars are appended after emergency vehicles so clients that filter
        # by kind can still consume the frame in a single pass.
        out.extend(self.traffic.to_frame())
        return out

    def _patients_frame(self) -> List[Dict[str, Any]]:
        return [p.to_dict() for p in self.patients.values()]


sim = Simulation()


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.get('/api/health')
def health() -> Dict[str, str]:
    return {'status': 'ok', 'name': 'AETHER Digital Twin', 'version': '2.0.0'}


# ---------------------------------------------------------------------------
# Hospitals
# ---------------------------------------------------------------------------
@app.get('/api/hospitals')
def get_hospitals() -> Dict[str, Any]:
    """List of hospitals known to the backend. Frontend mirrors this."""
    return {'hospitals': HOSPITALS}


# ---------------------------------------------------------------------------
# Emergency injection (used by the demo to trigger a crisis on demand)
#
# Two equivalent entry points:
#   POST /api/emergency          ← canonical
#   POST /api/emergency/trigger  ← console-friendly alias used by AETHER.triggerSOS
# ---------------------------------------------------------------------------
@app.post('/api/emergency')
async def inject_emergency(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Body (all fields optional):
      { "lat": -23.8897, "lon": 29.7261,
        "vitals": { "heartRate": 142, "spo2": 82, "conscious": true } }

    If lat/lon are omitted, a random point inside the Mankweng footprint is
    chosen. The returned frame is also broadcast over WebSocket.
    """
    lat = payload.get('lat')
    lon = payload.get('lon')
    if lat is None or lon is None:
        lat, lon = _random_mankweng_point()

    frame = sim.create_emergency(
        lat=float(lat),
        lon=float(lon),
        vitals=payload.get('vitals') or {},
    )

    await _broadcast(frame)

    return {'status': 'created', 'patient_id': frame['patient']['id']}


@app.post('/api/emergency/trigger')
async def trigger_emergency(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Console-friendly alias for POST /api/emergency. Same behaviour, but
    accepts an empty body and defaults vitals to a critical patient, so you
    can fire an emergency from the browser console with one line.
    """
    payload = payload or {}
    lat = payload.get('lat')
    lon = payload.get('lon')
    if lat is None or lon is None:
        lat, lon = _random_mankweng_point()

    vitals = payload.get('vitals') or {
        'heartRate': 142,
        'spo2': 82,
        'conscious': False,
    }

    frame = sim.create_emergency(
        lat=float(lat),
        lon=float(lon),
        vitals=vitals,
    )

    await _broadcast(frame)

    return {
        'status':     'created',
        'patient_id': frame['patient']['id'],
        'assigned':   frame['assigned'],
    }


@app.post('/api/emergency/{patient_id}/resolve')
async def resolve_emergency(patient_id: str) -> Dict[str, Any]:
    sim.resolve_emergency(patient_id)
    await _broadcast(sim.snapshot_frame())
    return {'status': 'resolved', 'patient_id': patient_id}


# ---------------------------------------------------------------------------
# Current state (for polling clients / debug)
# ---------------------------------------------------------------------------
@app.get('/api/state')
def state() -> Dict[str, Any]:
    return sim.snapshot_frame()


# ---------------------------------------------------------------------------
# WebSocket — init once, then stream snapshots
# ---------------------------------------------------------------------------
MAX_TICK_HZ = 30
MIN_TICK_DT = 1.0 / MAX_TICK_HZ
SNAPSHOT_EVERY_N_TICKS = 4      # emit a snapshot every 4 sim steps (~7.5 Hz)

_clients: List[WebSocket] = []


async def _broadcast(frame: Dict[str, Any]) -> None:
    """Send a frame to every connected client, dropping dead sockets."""
    if not _clients:
        return
    dead: List[WebSocket] = []
    for ws in _clients:
        try:
            await ws.send_json(frame)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _clients.remove(ws)


@app.websocket('/ws')
async def websocket_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    _clients.append(ws)

    # ---- Handshake ------------------------------------------------------
    await ws.send_json({
        'type':    'connected',
        'message': 'AETHER Digital Twin connected',
        'time':    sim.time,
    })

    # ---- One-shot init: fleet + traffic + patients ----------------------
    await ws.send_json(sim.init_frame())

    # ---- Simulation loop ------------------------------------------------
    tick_counter = 0
    try:
        while True:
            payload = await ws.receive_text()

            speed = 1.0
            try:
                data = json.loads(payload)
                if isinstance(data, dict):
                    s = data.get('speed')
                    if isinstance(s, (int, float)) and s > 0:
                        speed = min(float(s), 4.0)
            except Exception:
                pass

            tick_counter += 1
            if tick_counter % SNAPSHOT_EVERY_N_TICKS != 0:
                continue

            dt = 0.016 * speed
            if dt < MIN_TICK_DT: dt = MIN_TICK_DT
            if dt > 0.1:          dt = 0.1

            sim.tick(dt)
            await ws.send_json(sim.snapshot_frame())

    except WebSocketDisconnect:
        pass
    except Exception as exc:   # noqa: BLE001
        print(f'[ws] error: {exc!r}')
    finally:
        if ws in _clients:
            _clients.remove(ws)


# ---------------------------------------------------------------------------
# Wearable ESP32 proxy (unchanged behaviour, same endpoints)
# ---------------------------------------------------------------------------
_WEARABLE_HOST = os.environ.get('WEARABLE_IP', 'aether-wearable.local')
WEARABLE_ADDR: Dict[str, Any] = {'host': _WEARABLE_HOST, 'discovered_at': None}


def _wearable_base() -> str:
    host = WEARABLE_ADDR['host']
    if host.startswith('http://') or host.startswith('https://'):
        return host
    return f'http://{host}'


@app.post('/api/wearable/announce')
async def wearable_announce(payload: Dict[str, Any]) -> Dict[str, Any]:
    ip = payload.get('ip')
    if ip:
        WEARABLE_ADDR['host'] = ip
        WEARABLE_ADDR['discovered_at'] = time.time()
        print(f"[wearable] announced at {ip}")
    return {'ok': True, 'current_host': WEARABLE_ADDR['host']}


@app.get('/api/wearable/status')
async def wearable_status() -> Dict[str, Any]:
    return {
        'host':          WEARABLE_ADDR['host'],
        'url':           _wearable_base(),
        'discovered_at': WEARABLE_ADDR['discovered_at'],
    }


@app.get('/api/wearable/latest')
async def proxy_wearable_latest() -> Dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            r = await client.get(f'{_wearable_base()}/api/latest')
            r.raise_for_status()
            return r.json()
    except Exception:
        return {'valid': False, 'offline': True, 'host': WEARABLE_ADDR['host']}


@app.get('/api/wearable/test')
async def proxy_wearable_test(loc: str = 'mankweng') -> Dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            r = await client.get(
                f'{_wearable_base()}/api/test', params={'loc': loc},
            )
            r.raise_for_status()
            return {'status': 'forwarded', 'loc': loc, 'device_response': r.text}
    except Exception as exc:
        return {'status': 'offline', 'loc': loc, 'error': str(exc)}


# ---------------------------------------------------------------------------
# Camera ESP32 proxy (unchanged behaviour, same endpoints)
# ---------------------------------------------------------------------------
CAMERA_IP = os.environ.get('CAMERA_IP', '192.168.137.182')
CAMERA_BASE = f'http://{CAMERA_IP}'


@app.get('/api/camera/')
async def proxy_camera_root() -> HTMLResponse:
    async with httpx.AsyncClient(timeout=4.0) as client:
        try:
            r = await client.get(f'{CAMERA_BASE}/')
            html = r.text
        except Exception:
            html = (
                '<html><body style="background:#050d15;color:#fff;'
                'font-family:monospace;padding:40px">'
                '<h2 style="color:#ff5566">CAMERA OFFLINE</h2>'
                f'<p>Could not reach {CAMERA_IP}.</p>'
                '</body></html>'
            )

    html = html.replace('href="', 'href="/api/camera/')
    html = html.replace('src="',  'src="/api/camera/')
    return HTMLResponse(html)


@app.get('/api/camera/stream')
async def proxy_camera_stream():
    async def stream():
        async with httpx.AsyncClient(timeout=None) as client:
            try:
                async with client.stream('GET', f'{CAMERA_BASE}/stream') as r:
                    async for chunk in r.aiter_bytes():
                        yield chunk
            except Exception:
                return

    return StreamingResponse(
        stream(),
        media_type='multipart/x-mixed-replace; boundary=123456789000000000000987654321',
    )


@app.get('/api/camera/capture')
async def proxy_camera_capture():
    async with httpx.AsyncClient(timeout=4.0) as client:
        try:
            r = await client.get(f'{CAMERA_BASE}/capture')
            return StreamingResponse(iter([r.content]), media_type='image/jpeg')
        except Exception:
            return {'error': 'camera offline'}


@app.get('/api/camera/status')
async def camera_status() -> Dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            r = await client.get(f'{CAMERA_BASE}/')
            return {'online': r.status_code == 200, 'ip': CAMERA_IP}
    except Exception:
        return {'online': False, 'ip': CAMERA_IP}


# ---------------------------------------------------------------------------
# Catch-all — serve any file from frontend/, else fall back to index.html
# ---------------------------------------------------------------------------
@app.get('/{path:path}')
def catch_all(path: str):
    if path.startswith(('api/', 'ws', 'static/')):
        raise HTTPException(status_code=404, detail='not found')

    for base in (frontend_dir, project_root):
        candidate = base / path
        if candidate.is_file():
            return FileResponse(candidate)

    return FileResponse(_resolve('index.html'))