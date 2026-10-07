# backend/main.py
# AETHER / SKYNET — FastAPI surface (multi-city world).

from __future__ import annotations

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
    return engine.world


@app.get('/api/cities')
def get_cities() -> Dict[str, Any]:
    """Just the cities (no highways)."""
    return {
        'cities': engine.world['cities'],
        'bounds': engine.world['bounds'],
    }


@app.get('/api/cities/{city_id}')
def get_city(city_id: str) -> Dict[str, Any]:
    city_key = city_id.upper()
    if city_key == 'ALPHA':
        return engine.world['cities'][0]
    for city in engine.world['cities']:
        if city['id'] == city_key:
            return city
    return {'error': 'city not found'}


@app.get('/api/highways')
def get_highways() -> Dict[str, Any]:
    return {
        'highways': engine.world['highways'],
        'meta': engine.world.get('meta', {}),
    }


# ---------------------------------------------------------------------------
# Backwards-compat single-city endpoint (returns the first city)
# ---------------------------------------------------------------------------
@app.get('/api/city')
def get_legacy_city() -> Dict[str, Any]:
    return engine.world['cities'][0]


@app.get('/api/zones')
def get_zones() -> Dict[str, Any]:
    primary = engine.world['cities'][0]
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
    return {'vehicles': engine.vehicles}


@app.get('/api/vehicles/{vehicle_id}')
def get_vehicle(vehicle_id: str) -> Dict[str, Any]:
    v = engine.get_vehicle(vehicle_id)
    if v is None:
        return {'error': 'vehicle not found'}
    return v


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
    return {'pedestrians': engine.pedestrians}


# ---------------------------------------------------------------------------
# Snapshot & stats
# ---------------------------------------------------------------------------
@app.get('/api/snapshot')
def snapshot() -> Dict[str, Any]:
    return {
        'type': 'snapshot',
        'world': engine.world,
        'vehicles': engine.vehicles,
        'pedestrians': engine.pedestrians,
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
        # highway vehicles: edge kind is highway
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
# WebSocket — tick + snapshot
# ---------------------------------------------------------------------------
@app.websocket('/ws')
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    await websocket.send_json({
        'type': 'connected',
        'message': 'AETHER / SKYNET digital twin connected',
        'time': engine.time,
    })
    try:
        while True:
            payload = await websocket.receive_text()

            # parse optional speed multiplier from client
            speed = 1
            try:
                import json as _json
                data = _json.loads(payload)
                if isinstance(data, dict) and 'speed' in data:
                    try:
                        speed = float(data['speed'])
                    except (TypeError, ValueError):
                        speed = 1
            except Exception:
                pass

            # clamp
            if speed <= 0:
                speed = 1
            if speed > 4:
                speed = 4

            dt = 0.016 * speed
            engine.update(dt)

            await websocket.send_json({
                'type': 'snapshot',
                'world': engine.world,
                'vehicles': engine.vehicles,
                'pedestrians': engine.pedestrians,
                'time': engine.time,
            })
    except WebSocketDisconnect:
        pass


# ---------------------------------------------------------------------------
# Static / frontend
# ---------------------------------------------------------------------------
project_root = Path(__file__).resolve().parents[1]
frontend_dir = project_root / 'frontend'
if frontend_dir.exists():
    app.mount('/static', StaticFiles(directory=str(frontend_dir)), name='static')


@app.get('/')
def serve_frontend() -> FileResponse:
    index_file = frontend_dir / 'index.html'
    if index_file.exists():
        return FileResponse(index_file)
    return FileResponse(project_root / 'index.html')


@app.get('/{path:path}')
def catch_all(path: str):
    if path.startswith('api/'):
        return {'error': 'not found'}
    if (frontend_dir / path).exists():
        return FileResponse(frontend_dir / path)
    if (project_root / path).exists():
        return FileResponse(project_root / path)
    return FileResponse(frontend_dir / 'index.html')