from __future__ import annotations

import math
import random
from typing import Dict, List

from backend.engine.city_generator import GRID, ROAD_WIDTH, generate_city
from backend.engine.pathfinding import axis_of, pick_next

LIGHT_CYCLE = 7
STOP_DIST = 5
SAFE_GAP = 6
MIN_GAP = 2.6
ACCEL = 2.5
LANE_OFFSET = ROAD_WIDTH / 4


class SimulationEngine:
    def __init__(self) -> None:
        self.city = generate_city()
        self.vehicles: List[dict] = []
        self.time = 0.0

    def spawn_vehicles(self, n: int) -> None:
        if self.vehicles:
            return
        for index in range(n):
            self.vehicles.append(spawn_vehicle(self.city, f'CAR_{str(index + 1).zfill(3)}'))

    def update(self, dt: float) -> None:
        if dt <= 0:
            return
        self.time += dt
        update_traffic(self.city, self.vehicles, dt)

    def get_vehicle(self, vehicle_id: str) -> dict | None:
        for vehicle in self.vehicles:
            if vehicle['id'] == vehicle_id:
                return vehicle
        return None


def get_node(city: dict, node_id: str) -> dict:
    for node in city['intersections']:
        if node['id'] == node_id:
            return node
    raise KeyError(node_id)


def edge_length(a: dict, b: dict) -> float:
    return math.hypot(a['x'] - b['x'], a['z'] - b['z'])


def update_lights(city: dict, dt: float) -> None:
    for node in city['intersections']:
        node['light']['timer'] += dt
        if node['light']['timer'] >= LIGHT_CYCLE:
            node['light']['state'] = 'ew' if node['light']['state'] == 'ns' else 'ns'
            node['light']['timer'] = 0


def vehicle_transform(vehicle: dict, city: dict) -> dict:
    from_node = get_node(city, vehicle['fromId'])
    to_node = get_node(city, vehicle['toId'])
    dx = to_node['x'] - from_node['x']
    dz = to_node['z'] - from_node['z']
    length = math.hypot(dx, dz) or 1
    nx = dx / length
    nz = dz / length
    rx = nz
    rz = -nx
    t = vehicle['progress']
    x = from_node['x'] + dx * t + rx * LANE_OFFSET
    z = from_node['z'] + dz * t + rz * LANE_OFFSET
    heading = math.atan2(nx, nz)
    return {'x': x, 'z': z, 'heading': heading}


def update_traffic(city: dict, vehicles: List[dict], dt: float) -> None:
    update_lights(city, dt)
    by_edge: Dict[str, List[dict]] = {}
    for vehicle in vehicles:
        key = f"{vehicle['fromId']}>{vehicle['toId']}"
        by_edge.setdefault(key, []).append(vehicle)

    for vehicle in vehicles:
        from_node = get_node(city, vehicle['fromId'])
        to_node = get_node(city, vehicle['toId'])
        length = edge_length(from_node, to_node) or 1
        axis = axis_of(from_node, to_node)

        leader_progress = math.inf
        same_edge = by_edge.get(f"{vehicle['fromId']}>{vehicle['toId']}", [])
        for other in same_edge:
            if other['progress'] > vehicle['progress'] and other['progress'] < leader_progress:
                leader_progress = other['progress']

        gap = (leader_progress - vehicle['progress']) * length
        remaining = (1 - vehicle['progress']) * length
        red_for_me = to_node['light']['state'] != axis
        must_stop = red_for_me and remaining < STOP_DIST and remaining > 0.6

        target = vehicle['desiredSpeed']
        if must_stop:
            target = 0
        elif leader_progress != math.inf:
            if gap < MIN_GAP:
                target = 0
            elif gap < SAFE_GAP:
                fraction = (gap - MIN_GAP) / (SAFE_GAP - MIN_GAP)
                target = min(vehicle['desiredSpeed'], vehicle['desiredSpeed'] * fraction)

        if vehicle['speed'] < target:
            vehicle['speed'] = min(target, vehicle['speed'] + ACCEL * 3 * dt)
        else:
            vehicle['speed'] = max(target, vehicle['speed'] - ACCEL * 4 * dt)
        if vehicle['speed'] < 0:
            vehicle['speed'] = 0

        vehicle['progress'] += (vehicle['speed'] * dt) / length
        vehicle['status'] = 'stopped' if vehicle['speed'] < 0.5 else 'moving'

        if vehicle['progress'] >= 1:
            overflow = (vehicle['progress'] - 1) * length
            next_id = pick_next(city, vehicle['fromId'], vehicle['toId'])
            vehicle['fromId'] = vehicle['toId']
            vehicle['toId'] = next_id
            new_length = edge_length(get_node(city, vehicle['fromId']), get_node(city, vehicle['toId'])) or 1
            vehicle['progress'] = overflow / new_length
            if random.random() < 0.04:
                sectors = ['Sector_A', 'Sector_B', 'Sector_C', 'Sector_D', 'Sector_E', 'Sector_F']
                vehicle['destination'] = random.choice(sectors)

        transform = vehicle_transform(vehicle, city)
        vehicle['position']['x'] = transform['x']
        vehicle['position']['z'] = transform['z']
        vehicle['position']['y'] = 0
        vehicle['heading'] = transform['heading']


def spawn_vehicle(city: dict, vehicle_id: str) -> dict:
    start = random.choice(city['intersections'])
    neighbors = []
    for node in city['intersections']:
        if abs(node['gridI'] - start['gridI']) + abs(node['gridJ'] - start['gridJ']) == 1:
            neighbors.append(node)
    end = random.choice(neighbors) if neighbors else start
    desired_speed = 18 + random.random() * 28
    vehicle = {
        'id': vehicle_id,
        'type': 'civilian',
        'fromId': start['id'],
        'toId': end['id'],
        'progress': random.random(),
        'speed': desired_speed,
        'desiredSpeed': desired_speed,
        'position': {'x': start['x'], 'y': 0, 'z': start['z']},
        'heading': 0.0,
        'destination': random.choice(['Sector_A', 'Sector_B', 'Sector_C', 'Sector_D', 'Sector_E', 'Sector_F']),
        'status': 'moving',
        'color': random.choice(['#e8eef5', '#c9d6e8', '#8aa0c0', '#d8dee8', '#6f86b3', '#b9c6db'])
    }
    transform = vehicle_transform(vehicle, city)
    vehicle['position']['x'] = transform['x']
    vehicle['position']['z'] = transform['z']
    vehicle['heading'] = transform['heading']
    return vehicle
