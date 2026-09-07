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
engine.spawn_vehicles(38)


@app.get('/api/health')
def health() -> Dict[str, str]:
    return {'status': 'ok', 'name': 'AETHER / SKYNET'}


@app.get('/api/city')
def get_city() -> Dict[str, Any]:
    return engine.city


@app.get('/api/vehicles')
def get_vehicles() -> Dict[str, List[Dict[str, Any]]]:
    return {'vehicles': engine.vehicles}


@app.get('/api/vehicles/{vehicle_id}')
def get_vehicle(vehicle_id: str) -> Dict[str, Any]:
    vehicle = engine.get_vehicle(vehicle_id)
    if vehicle is None:
        return {'error': 'vehicle not found'}
    return vehicle


@app.get('/api/snapshot')
def snapshot() -> Dict[str, Any]:
    return {
        'type': 'snapshot',
        'city': engine.city,
        'vehicles': engine.vehicles,
        'time': engine.time,
    }


@app.post('/api/simulate')
def simulate() -> Dict[str, Any]:
    engine.update(0.016)
    return {'status': 'updated', 'time': engine.time}


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
            data = {'type': 'message', 'payload': payload}
            await websocket.send_json(data)
    except WebSocketDisconnect:
        pass


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
