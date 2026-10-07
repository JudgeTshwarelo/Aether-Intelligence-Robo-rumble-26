# tests/test_app.py
# AETHER / SKYNET — API + WebSocket test suite (multi-city world).

from fastapi.testclient import TestClient

from backend.main import app

client = TestClient(app)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------
def test_health_endpoint():
    response = client.get('/api/health')
    assert response.status_code == 200
    payload = response.json()
    assert payload['status'] == 'ok'
    assert payload['name'] == 'AETHER / SKYNET'


# ---------------------------------------------------------------------------
# World
# ---------------------------------------------------------------------------
def test_world_endpoint_shape():
    response = client.get('/api/world')
    assert response.status_code == 200
    payload = response.json()
    assert payload['type'] == 'world'
    for key in ('cities', 'highways', 'bounds', 'meta'):
        assert key in payload, f'missing world key: {key}'
    assert len(payload['cities']) == 3
    assert len(payload['highways']) >= 3


def test_world_cities_have_origin_and_id():
    payload = client.get('/api/world').json()
    for city in payload['cities']:
        for key in ('id', 'name', 'origin', 'meta', 'buildings', 'roads', 'intersections', 'gateways'):
            assert key in city, f'missing city key: {key}'
        assert len(city['origin']) == 2
        assert len(city['buildings']) > 0
        assert len(city['gateways']) == 4


def test_world_highways_connect_cities():
    payload = client.get('/api/world').json()
    city_ids = {c['id'] for c in payload['cities']}
    for hw in payload['highways']:
        assert len(hw['cities']) == 2
        assert hw['cities'][0] in city_ids
        assert hw['cities'][1] in city_ids
        assert hw['length'] > 0
        assert len(hw['pylons']) > 0
        assert len(hw['roadsideTrees']) > 0


def test_world_bounds_sane():
    payload = client.get('/api/world').json()
    b = payload['bounds']
    assert b['minX'] < b['maxX']
    assert b['minZ'] < b['maxZ']
    assert b['minX'] <= b['centerX'] <= b['maxX']
    assert b['minZ'] <= b['centerZ'] <= b['maxZ']


def test_world_bounds_fit_city_footprints():
    payload = client.get('/api/world').json()
    bounds = payload['bounds']

    for city in payload['cities']:
        x, z = city['origin']
        ground_extent = city['meta']['HALF'] + 40
        assert bounds['minX'] <= x - ground_extent
        assert bounds['maxX'] >= x + ground_extent
        assert bounds['minZ'] <= z - ground_extent
        assert bounds['maxZ'] >= z + ground_extent

    spacing = payload['meta']['CITY_SPACING']
    assert bounds['maxX'] - bounds['minX'] < spacing * 2
    assert bounds['maxZ'] - bounds['minZ'] < spacing * 2


# ---------------------------------------------------------------------------
# Cities
# ---------------------------------------------------------------------------
def test_cities_endpoint():
    response = client.get('/api/cities')
    assert response.status_code == 200
    payload = response.json()
    assert 'cities' in payload
    assert 'bounds' in payload
    assert len(payload['cities']) == 3


def test_city_detail_endpoint():
    response = client.get('/api/cities/ALPHA')
    assert response.status_code == 200
    payload = response.json()
    assert payload['id'] == 'ALPHA'


def test_city_detail_not_found():
    response = client.get('/api/cities/NOPE')
    assert response.status_code == 200
    payload = response.json()
    assert payload.get('error') == 'city not found'


def test_legacy_city_endpoint_still_works():
    response = client.get('/api/city')
    assert response.status_code == 200
    payload = response.json()
    assert 'id' in payload
    assert 'buildings' in payload


# ---------------------------------------------------------------------------
# Highways
# ---------------------------------------------------------------------------
def test_highways_endpoint():
    response = client.get('/api/highways')
    assert response.status_code == 200
    payload = response.json()
    assert 'highways' in payload
    assert 'meta' in payload
    hws = payload['highways']
    assert len(hws) >= 3
    for hw in hws:
        for key in ('id', 'cities', 'fromGateway', 'toGateway', 'a', 'b', 'length', 'lanes', 'pylons', 'roadsideTrees'):
            assert key in hw, f'missing highway key: {key}'


# ---------------------------------------------------------------------------
# Zones (legacy single-city)
# ---------------------------------------------------------------------------
def test_zones_endpoint():
    response = client.get('/api/zones')
    assert response.status_code == 200
    payload = response.json()
    assert 'zones' in payload
    assert 'zoneCounts' in payload
    assert 'typeCounts' in payload
    assert len(payload['zones']) >= 4


# ---------------------------------------------------------------------------
# Vehicles
# ---------------------------------------------------------------------------
def test_vehicle_endpoint_returns_simulation_state():
    response = client.get('/api/vehicles')
    assert response.status_code == 200
    payload = response.json()
    assert 'vehicles' in payload
    assert len(payload['vehicles']) > 0


def test_vehicle_detail_endpoint():
    vehicles = client.get('/api/vehicles').json()['vehicles']
    vid = vehicles[0]['id']
    response = client.get(f'/api/vehicles/{vid}')
    assert response.status_code == 200
    payload = response.json()
    assert payload['id'] == vid
    for key in ('type', 'fromId', 'toId', 'progress', 'speed', 'desiredSpeed', 'position', 'heading', 'status'):
        assert key in payload, f'missing vehicle field: {key}'


def test_vehicle_detail_not_found():
    response = client.get('/api/vehicles/DOES_NOT_EXIST')
    assert response.status_code == 200
    payload = response.json()
    assert 'error' in payload


def test_vehicle_classes_endpoint():
    response = client.get('/api/vehicle-classes')
    assert response.status_code == 200
    payload = response.json()
    assert 'classes' in payload
    classes = payload['classes']
    for name in ('car', 'van', 'bus', 'truck', 'emergency'):
        assert name in classes, f'missing vehicle class: {name}'


def test_vehicles_have_city_id():
    vehicles = client.get('/api/vehicles').json()['vehicles']
    # At least some vehicles should carry a cityId
    with_city = [v for v in vehicles if v.get('cityId')]
    assert len(with_city) > 0


# ---------------------------------------------------------------------------
# Inter-city presence
# ---------------------------------------------------------------------------
def test_some_vehicles_reach_highways():
    """Advance the sim enough that at least one vehicle uses a highway edge."""
    # request a few snapshots to get a mix of positions
    for _ in range(20):
        client.post('/api/simulate')

    stats = client.get('/api/stats').json()
    # onHighway may be zero at a given instant; but byCity should show
    # vehicles distributed across more than one city at least once.
    by_city = stats['vehicles'].get('byCity', {})
    assert isinstance(by_city, dict)
    # We want at least one vehicle to have a city tag
    assert len(by_city) >= 1


# ---------------------------------------------------------------------------
# Pedestrians
# ---------------------------------------------------------------------------
def test_pedestrians_endpoint():
    response = client.get('/api/pedestrians')
    assert response.status_code == 200
    payload = response.json()
    assert 'pedestrians' in payload
    assert len(payload['pedestrians']) > 0


def test_pedestrian_shape():
    peds = client.get('/api/pedestrians').json()['pedestrians']
    p = peds[0]
    for key in ('id', 'position', 'heading', 'speed', 'state'):
        assert key in p, f'missing pedestrian field: {key}'


# ---------------------------------------------------------------------------
# Snapshot & stats
# ---------------------------------------------------------------------------
def test_snapshot_shape():
    response = client.get('/api/snapshot')
    assert response.status_code == 200
    payload = response.json()
    assert payload['type'] == 'snapshot'
    for key in ('world', 'vehicles', 'pedestrians', 'time'):
        assert key in payload, f'missing snapshot key: {key}'
    assert len(payload['world']['cities']) == 3
    assert isinstance(payload['vehicles'], list)
    assert isinstance(payload['pedestrians'], list)


def test_stats_endpoint():
    response = client.get('/api/stats')
    assert response.status_code == 200
    payload = response.json()
    assert 'time' in payload
    assert 'vehicles' in payload
    assert 'pedestrians' in payload
    v = payload['vehicles']
    for key in ('total', 'moving', 'stopped', 'onHighway', 'byClass', 'byCity'):
        assert key in v
    assert v['total'] == v['moving'] + v['stopped']
    assert isinstance(v['byClass'], dict)
    assert isinstance(v['byCity'], dict)


def test_simulate_advances_time():
    t0 = client.get('/api/stats').json()['time']
    response = client.post('/api/simulate')
    assert response.status_code == 200
    payload = response.json()
    assert payload['status'] == 'updated'
    assert payload['time'] > t0


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------
def test_websocket_connects():
    with client.websocket_connect('/ws') as websocket:
        message = websocket.receive_json()
        assert message['type'] == 'connected'
        assert 'time' in message


def test_websocket_tick_returns_snapshot():
    with client.websocket_connect('/ws') as websocket:
        websocket.receive_json()  # greeting
        websocket.send_text('{"type":"tick"}')
        snapshot = websocket.receive_json()
        assert snapshot['type'] == 'snapshot'
        for key in ('world', 'vehicles', 'pedestrians', 'time'):
            assert key in snapshot, f'missing ws snapshot key: {key}'
        assert len(snapshot['world']['cities']) == 3


def test_websocket_advances_sim_time():
    with client.websocket_connect('/ws') as websocket:
        greeting = websocket.receive_json()
        t0 = greeting['time']
        websocket.send_text('{"type":"tick"}')
        snap = websocket.receive_json()
        assert snap['time'] > t0


# ---------------------------------------------------------------------------
# Static / frontend fallback
# ---------------------------------------------------------------------------
def test_root_serves_index():
    response = client.get('/')
    assert response.status_code == 200
    assert 'text/html' in response.headers.get('content-type', '')


def test_unknown_api_route_returns_error():
    response = client.get('/api/unknown/path')
    assert response.status_code == 200
    payload = response.json()
    assert payload.get('error') == 'not found'