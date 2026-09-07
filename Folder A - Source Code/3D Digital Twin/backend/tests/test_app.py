from fastapi.testclient import TestClient

from backend.main import app

client = TestClient(app)


def test_health_endpoint():
    response = client.get('/api/health')
    assert response.status_code == 200
    payload = response.json()
    assert payload['status'] == 'ok'


def test_city_endpoint_returns_city_data():
    response = client.get('/api/city')
    assert response.status_code == 200
    payload = response.json()
    assert 'buildings' in payload
    assert 'roads' in payload
    assert 'intersections' in payload
    assert len(payload['buildings']) > 0


def test_vehicle_endpoint_returns_simulation_state():
    response = client.get('/api/vehicles')
    assert response.status_code == 200
    payload = response.json()
    assert 'vehicles' in payload
    assert len(payload['vehicles']) > 0


def test_websocket_connects():
    with client.websocket_connect('/ws') as websocket:
        message = websocket.receive_json()
        assert 'type' in message
