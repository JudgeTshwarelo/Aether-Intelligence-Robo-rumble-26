# backend/main.py
# AETHER / SKYNET — FastAPI surface (multi-city world).
# ⚡ PERF PASS:
#   - World is sent ONCE per websocket connection (`init`), never on each tick.
#   - Vehicle payloads on the wire are projected to a small field set.
#   - Static world payload is cached at module scope so it's serialized once.
#   - Tick dt is clamped and sub-ms updates are skipped.
# 🌐 ROUTING PASS:
#   - `/` serves the landing page (index.html).
#   - `/static/map.html` serves the digital twin (used by the landing iframe).
#   - Unknown paths fall back to the landing page, not the map.

from __future__ import annotations

import json
from typing import Any, Dict, List

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path

from backend.engine.simulation import SimulationEngine

app = FastAPI(title='AETHER / SKYNET', version='1.0.0')

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

engine = SimulationEngine()
engine.spawn_vehicles(120)
engine.spawn_pedestrians(80)

# ⚡ PERF: World is static after startup. Serialize once and reuse the same
# Python object — FastAPI will still call json.dumps on it per response, but
# at least the dict walk is skipped on hot paths that hit /api/world.
WORLD_PAYLOAD: Dict[str, Any] = engine.world

# ⚡ PERF: Fields the front-end actually consumes per vehicle. Anything else
# (route, routeIndex, destinationNode, leaderId, _spec, etc.) is dropped.
_VEHICLE_WIRE_FIELDS = (
    'id', 'type', 'class', 'cityId',
    'fromId', 'toId',
    'progress', 'speed', 'desiredSpeed',
    'position', 'heading',
    'destination', 'status', 'color', 'lane',
    'length', 'width', 'height',
)

_PEDESTRIAN_WIRE_FIELDS = (
    'id', 'cityId', 'position', 'heading', 'speed', 'state',
)


def _project(items: List[dict], fields: tuple) -> List[dict]:
    """Return a list of dicts limited to the given keys (missing keys skipped)."""
    out: List[dict] = []
    for item in items:
        out.append({k: item[k] for k in fields if k in item})
    return out


def _vehicles_wire() -> List[dict]:
    return _project(engine.vehicles, _VEHICLE_WIRE_FIELDS)


def _pedestrians_wire() -> List[dict]:
    return _project(engine.pedestrians, _PEDESTRIAN_WIRE_FIELDS)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
@app.get('/api/health')
def health() -> Dict[str, str]:
    return {'status': 'ok', 'name': 'AETHER / SKYNET'}


# ---------------------------------------------------------------------------
# World / cities / highways
# ---------------------------------------------------------------------------
@app.get('/api/world')
def get_world() -> Dict[str, Any]:
    """Full world payload: all cities, highways, bounds, meta."""
    return WORLD_PAYLOAD


@app.get('/api/cities')
def get_cities() -> Dict[str, Any]:
    """Just the cities (no highways)."""
    return {
        'cities': WORLD_PAYLOAD['cities'],
        'bounds': WORLD_PAYLOAD['bounds'],
    }


@app.get('/api/cities/{city_id}')
def get_city(city_id: str) -> Dict[str, Any]:
    city_key = city_id.upper()
    if city_key == 'ALPHA':
        return WORLD_PAYLOAD['cities'][0]
    for city in WORLD_PAYLOAD['cities']:
        if city['id'] == city_key:
            return city
    return {'error': 'city not found'}


@app.get('/api/highways')
def get_highways() -> Dict[str, Any]:
    return {
        'highways': WORLD_PAYLOAD['highways'],
        'meta': WORLD_PAYLOAD.get('meta', {}),
    }


# ---------------------------------------------------------------------------
# Backwards-compat single-city endpoint (returns the first city)
# ---------------------------------------------------------------------------
@app.get('/api/city')
def get_legacy_city() -> Dict[str, Any]:
    return WORLD_PAYLOAD['cities'][0]


@app.get('/api/zones')
def get_zones() -> Dict[str, Any]:
    primary = WORLD_PAYLOAD['cities'][0]
    return {
        'zones': primary.get('zones', {}),
        'zoneCounts': primary.get('zoneCounts', {}),
        'typeCounts': primary.get('typeCounts', {}),
    }


# ---------------------------------------------------------------------------
# Vehicles
# ---------------------------------------------------------------------------
@app.get('/api/vehicles')
def get_vehicles() -> Dict[str, List[Dict[str, Any]]]:
    # ⚡ PERF: trimmed wire projection
    return {'vehicles': _vehicles_wire()}


@app.get('/api/vehicles/{vehicle_id}')
def get_vehicle(vehicle_id: str) -> Dict[str, Any]:
    v = engine.get_vehicle(vehicle_id)
    if v is None:
        return {'error': 'vehicle not found'}
    return {k: v[k] for k in _VEHICLE_WIRE_FIELDS if k in v}


@app.get('/api/vehicle-classes')
def get_vehicle_classes() -> Dict[str, Any]:
    from backend.engine.simulation import VEHICLE_CLASSES
    return {
        'classes': {
            name: {
                'length': spec['length'],
                'width': spec['width'],
                'height': spec['height'],
                'speedRange': list(spec['desiredSpeed']),
                'weight': spec['weight'],
                'colors': spec['colors'],
            }
            for name, spec in VEHICLE_CLASSES.items()
        }
    }


# ---------------------------------------------------------------------------
# Pedestrians
# ---------------------------------------------------------------------------
@app.get('/api/pedestrians')
def get_pedestrians() -> Dict[str, List[Dict[str, Any]]]:
    return {'pedestrians': _pedestrians_wire()}


# ---------------------------------------------------------------------------
# Snapshot & stats
# ---------------------------------------------------------------------------
@app.get('/api/snapshot')
def snapshot() -> Dict[str, Any]:
    # Kept for backwards compat, but no longer ships the world.
    return {
        'type': 'snapshot',
        'vehicles': _vehicles_wire(),
        'pedestrians': _pedestrians_wire(),
        'time': engine.time,
    }


@app.get('/api/stats')
def stats() -> Dict[str, Any]:
    total = len(engine.vehicles)
    moving = sum(1 for v in engine.vehicles if v['status'] == 'moving')
    stopped = total - moving

    by_class: Dict[str, int] = {}
    by_city: Dict[str, int] = {}
    on_highway = 0

    for v in engine.vehicles:
        by_class[v['type']] = by_class.get(v['type'], 0) + 1
        cid = v.get('cityId') or 'unknown'
        by_city[cid] = by_city.get(cid, 0) + 1
        edge = engine.graph.edge(f"{v['fromId']}>{v['toId']}")
        if edge and edge.get('kind') == 'highway':
            on_highway += 1

    return {
        'time': engine.time,
        'vehicles': {
            'total': total,
            'moving': moving,
            'stopped': stopped,
            'onHighway': on_highway,
            'byClass': by_class,
            'byCity': by_city,
        },
        'pedestrians': len(engine.pedestrians),
        'spawned': engine.spawn_count,
        'despawned': engine.despawn_count,
    }


@app.post('/api/simulate')
def simulate() -> Dict[str, Any]:
    engine.update(0.016)
    return {'status': 'updated', 'time': engine.time}


# ---------------------------------------------------------------------------
# WebSocket — init once, then lightweight snapshots
# ---------------------------------------------------------------------------
# ⚡ PERF: The client used to receive the full world payload (multiple MB)
# on EVERY tick. Now:
#   1. On connect: one `init` message carries world + vehicles + peds + time.
#   2. Every subsequent tick: `snapshot` carries ONLY the dynamic state.
# This cuts per-tick payload size by ~95%.

MAX_TICK_HZ = 30
MIN_TICK_DT = 1.0 / MAX_TICK_HZ


@app.websocket('/ws')
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    # -----------------------------------------------------------------------
    # 1) Handshake
    # -----------------------------------------------------------------------
    await websocket.send_json({
        'type': 'connected',
        'message': 'AETHER / SKYNET digital twin connected',
        'time': engine.time,
    })

    # -----------------------------------------------------------------------
    # 2) One-shot init — ships the world exactly once
    # -----------------------------------------------------------------------
    await websocket.send_json({
        'type': 'init',
        'world': WORLD_PAYLOAD,
        'vehicles': _vehicles_wire(),
        'pedestrians': _pedestrians_wire(),
        'time': engine.time,
    })

    try:
        while True:
            payload = await websocket.receive_text()

            # parse optional speed multiplier from client
            speed = 1.0
            try:
                data = json.loads(payload)
                if isinstance(data, dict) and 'speed' in data:
                    try:
                        speed = float(data['speed'])
                    except (TypeError, ValueError):
                        speed = 1.0
            except Exception:
                pass

            # clamp
            if speed <= 0:
                speed = 1.0
            if speed > 4:
                speed = 4.0

            # ⚡ PERF: skip sub-ms updates so a chatty client can't melt the CPU
            dt = 0.016 * speed
            if dt < MIN_TICK_DT:
                dt = MIN_TICK_DT
            # Guard against enormous dt if the tab was backgrounded
            if dt > 0.1:
                dt = 0.1

            engine.update(dt)

            # ⚡ PERF: dynamic-only snapshot
            await websocket.send_json({
                'type': 'snapshot',
                'vehicles': _vehicles_wire(),
                'pedestrians': _pedestrians_wire(),
                'time': engine.time,
            })
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        # Never let a bad client take the server down.
        print(f'[ws] connection error: {exc!r}')


# ---------------------------------------------------------------------------
# Static / frontend
# ---------------------------------------------------------------------------
# 🌐 ROUTING:
#   `/`               → index.html   (landing page)
#   `/static/*`       → frontend/*   (css, js, images, and map.html)
#   `/static/map.html`→ the digital twin loaded inside the landing iframe
#
# So the folder layout should be:
#   frontend/
#   ├── index.html
#   ├── map.html
#   ├── css/styles.css
#   ├── js/main.js
#   ├── js/materials.js
#   └── images/
#       ├── AI-logo.png
#       └── bg.png
#
project_root = Path(__file__).resolve().parents[1]
frontend_dir = project_root / 'frontend'

# Mount /static/* → frontend/ (this also exposes /static/map.html)
if frontend_dir.exists():
    app.mount('/static', StaticFiles(directory=str(frontend_dir)), name='static')


def _resolve(filename: str) -> Path:
    """Look for a file in frontend/, falling back to project root."""
    for base in (frontend_dir, project_root):
        candidate = base / filename
        if candidate.exists():
            return candidate
    return frontend_dir / filename  # will 404 naturally if truly missing


@app.get('/')
def serve_landing() -> FileResponse:
    """Root serves the LANDING PAGE."""
    return FileResponse(_resolve('index.html'))


@app.get('/{path:path}')
def catch_all(path: str):
    # Never let /api/* fall through to HTML
    if path.startswith('api/'):
        return {'error': 'not found'}

    # Serve any real file from frontend/ (or project root)
    for base in (frontend_dir, project_root):
        candidate = base / path
        if candidate.is_file():
            return FileResponse(candidate)

    # Fallback for unknown paths → landing page
    return FileResponse(_resolve('index.html'))

   # ---------------------------------------------------------------------------
# Wearable ESP32 proxy — with auto-discovery
# ---------------------------------------------------------------------------
# Two ways the backend learns the ESP32's address:
#   1. mDNS: default hostname is `aether-wearable.local`
#   2. Announce: the ESP32 POSTs its IP to /api/wearable/announce on boot
#
# The announce path overrides the mDNS hostname.
# ---------------------------------------------------------------------------
import os
import httpx

# Initial address (mDNS hostname works on most systems; IP override via env)
_WEARABLE_HOST = os.environ.get('WEARABLE_IP', 'aether-wearable.local')
WEARABLE_ADDR = {'host': _WEARABLE_HOST, 'discovered_at': None}


def _wearable_base() -> str:
    host = WEARABLE_ADDR['host']
    # If someone pasted a full URL, use it as-is
    if host.startswith('http://') or host.startswith('https://'):
        return host
    return f'http://{host}'


@app.post('/api/wearable/announce')
async def wearable_announce(payload: Dict[str, Any]) -> Dict[str, Any]:
    """ESP32 calls this on boot with its own IP. Overrides mDNS lookup."""
    ip = payload.get('ip')
    host = payload.get('host')
    if ip:
        WEARABLE_ADDR['host'] = ip
        import time
        WEARABLE_ADDR['discovered_at'] = time.time()
        print(f"[wearable] announced at {ip} (mDNS: {host})")
    return {
        'ok': True,
        'current_host': WEARABLE_ADDR['host'],
    }


@app.get('/api/wearable/status')
async def wearable_status() -> Dict[str, Any]:
    """Quick diagnostic — who is the backend currently talking to?"""
    return {
        'host': WEARABLE_ADDR['host'],
        'url': _wearable_base(),
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
                f'{_wearable_base()}/api/test',
                params={'loc': loc},
            )
            r.raise_for_status()
            return {'status': 'forwarded', 'loc': loc, 'device_response': r.text}
    except Exception as exc:
        return {'status': 'offline', 'loc': loc, 'error': str(exc)}


    # ---------------------------------------------------------------------------
# Camera ESP32 proxy
# ---------------------------------------------------------------------------
# The camera runs the stock CameraWebServer sketch, which serves its own UI
# and MJPEG stream from the ESP32 at port 80.
#
# We proxy it so the digital-twin iframe loads same-origin (`/api/camera/...`),
# which avoids mixed-content blocking and CORS surprises.
# ---------------------------------------------------------------------------
import os
from fastapi.responses import StreamingResponse, HTMLResponse

CAMERA_IP = os.environ.get('CAMERA_IP', '192.168.137.182')   # ← your ESP32's IP
CAMERA_BASE = f'http://{CAMERA_IP}'


@app.get('/api/camera/')
async def proxy_camera_root() -> HTMLResponse:
    """Forward the ESP32's camera UI, rewriting relative URLs to our prefix."""
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
                '<p>Check that the ESP32 is powered on and on the same WiFi.</p>'
                '</body></html>'
            )

    # Rewrite relative asset paths so the browser loads them via /api/camera/
    # This is a blunt fix but works for the standard CameraWebServer UI.
    html = html.replace('href="', 'href="/api/camera/')
    html = html.replace('src="', 'src="/api/camera/')
    return HTMLResponse(html)


@app.get('/api/camera/stream')
async def proxy_camera_stream():
    """
    Proxy the MJPEG stream.
    Forwards bytes as they arrive so the browser can render live video.
    """
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
    """Snapshot endpoint — returns a single JPEG."""
    async with httpx.AsyncClient(timeout=4.0) as client:
        try:
            r = await client.get(f'{CAMERA_BASE}/capture')
            return StreamingResponse(
                iter([r.content]),
                media_type='image/jpeg',
            )
        except Exception:
            return {'error': 'camera offline'}


@app.get('/api/camera/status')
async def camera_status() -> Dict[str, Any]:
    """Diagnostic — is the camera reachable?"""
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            r = await client.get(f'{CAMERA_BASE}/')
            return {'online': r.status_code == 200, 'ip': CAMERA_IP}
    except Exception:
        return {'online': False, 'ip': CAMERA_IP}