from __future__ import annotations

import math
import random
from typing import Dict, List, Tuple

BLOCK = 36
GRID = 6
ROAD_WIDTH = 7
SIDEWALK = 2.2


MARKER_COLOR = {
    'hospital': '#ff3b3b',
    'police': '#3b7aff',
    'fire': '#ff6a3b',
    'energy': '#39ffd8',
}

PALETTES = {
    'apartment': ['#3b4a63', '#465068', '#3a4456', '#414b5e', '#38415a'],
    'office': ['#2b3550', '#33405f', '#28324c', '#2f3a57', '#243049'],
    'commercial': ['#4a4655', '#53475a', '#43455a', '#4b4a5e'],
    'residential': ['#55617a', '#5d6680', '#505c74', '#626b85'],
    'hospital': ['#e8eef2'],
    'police': ['#2c3e6b'],
    'fire': ['#7a2a26'],
    'energy': ['#3a4a52'],
}


def rand(min_value: float, max_value: float) -> float:
    return min_value + random.random() * (max_value - min_value)


def pick(items: List[str]) -> str:
    return random.choice(items)


def P(k: int) -> float:
    return (k - GRID / 2) * BLOCK


def build_intersections() -> List[Dict[str, object]]:
    nodes: List[Dict[str, object]] = []
    for i in range(GRID + 1):
        for j in range(GRID + 1):
            nodes.append({
                'id': f'INT_{i}_{j}',
                'gridI': i,
                'gridJ': j,
                'x': P(i),
                'z': P(j),
                'light': {
                    'state': 'ns' if (i + j) % 2 == 0 else 'ew',
                    'timer': rand(0, 7),
                },
            })
    return nodes


def block_center(i: int, j: int) -> Tuple[float, float]:
    return ((P(i) + P(i + 1)) / 2, (P(j) + P(j + 1)) / 2)


def building_dims(type_name: str):
    if type_name == 'apartment':
        return {'w': rand(13, 19), 'd': rand(13, 19), 'hMin': 18, 'hMax': 34}
    if type_name == 'office':
        return {'w': rand(14, 22), 'd': rand(14, 22), 'hMin': 30, 'hMax': 70}
    if type_name == 'commercial':
        return {'w': rand(15, 22), 'd': rand(12, 18), 'hMin': 10, 'hMax': 22}
    if type_name == 'residential':
        return {'w': rand(9, 14), 'd': rand(9, 14), 'hMin': 7, 'hMax': 16}
    if type_name == 'hospital':
        return {'w': 20, 'd': 16, 'hMin': 18, 'hMax': 26}
    if type_name == 'police':
        return {'w': 15, 'd': 13, 'hMin': 11, 'hMax': 18}
    if type_name == 'fire':
        return {'w': 16, 'd': 14, 'hMin': 10, 'hMax': 14}
    if type_name == 'energy':
        return {'w': 14, 'd': 12, 'hMin': 6, 'hMax': 11}
    return {'w': 12, 'd': 12, 'hMin': 10, 'hMax': 20}


def make_building(idx: int, i: int, j: int) -> Dict[str, object]:
    cx, cz = block_center(i, j)
    inner = BLOCK - 2 * SIDEWALK
    specials = {
        0: 'hospital',
        GRID - 1: 'police',
        GRID * (GRID - 1): 'fire',
        GRID * GRID - 1: 'energy',
    }

    if idx in specials:
        type_name = specials[idx]
    elif idx % 3 == 0:
        type_name = 'apartment'
    else:
        roll = random.random()
        if roll < 0.28:
            type_name = 'apartment'
        elif roll < 0.5:
            type_name = 'office'
        elif roll < 0.72:
            type_name = 'commercial'
        else:
            type_name = 'residential'

    dims = building_dims(type_name)
    w = min(dims['w'], inner)
    d = min(dims['d'], inner)
    height = rand(dims['hMin'], dims['hMax'])
    floors = max(2, round(height / 3.3))
    rotation = 0 if type_name == 'office' else (math.pi / 2 if random.random() < 0.3 else 0)

    building = {
        'id': f'BUILDING_{str(idx + 1).zfill(3)}',
        'type': type_name,
        'position': [cx, 0, cz],
        'width': w,
        'depth': d,
        'height': height,
        'floors': floors,
        'status': 'normal',
        'color': pick(PALETTES[type_name]),
        'rotation': rotation,
        'marker': MARKER_COLOR.get(type_name),
    }

    if type_name == 'apartment':
        building['units'] = floors * 4
        building['balconies'] = True
    if type_name == 'office':
        building['occupancy'] = round(rand(0.5, 1) * floors * 20)
    return building


def build_road_lines() -> List[Dict[str, object]]:
    roads: List[Dict[str, object]] = []
    for j in range(GRID + 1):
        roads.append({'axis': 'x', 'pos': P(j), 'from': P(0), 'to': P(GRID)})
    for i in range(GRID + 1):
        roads.append({'axis': 'z', 'pos': P(i), 'from': P(0), 'to': P(GRID)})
    return roads


def build_infrastructure(buildings: List[Dict[str, object]]) -> Dict[str, List[object]]:
    streetlights: List[Dict[str, object]] = []
    traffic_lights: List[Dict[str, object]] = []
    trees: List[Dict[str, object]] = []

    for i in range(GRID + 1):
        for j in range(GRID + 1):
            streetlights.append({
                'id': f'LAMP_{i}_{j}',
                'x': P(i) + (-3 if i == GRID else 3),
                'z': P(j) + (-3 if j == GRID else 3),
            })
            traffic_lights.append({'id': f'TL_{i}_{j}', 'x': P(i), 'z': P(j)})

    for i in range(GRID):
        for j in range(GRID):
            cx, cz = block_center(i, j)
            half = BLOCK / 2 - SIDEWALK - 1.5
            count = 2 + int(random.random() * 2)
            for t in range(count):
                sx = -1 if random.random() < 0.5 else 1
                sz = -1 if random.random() < 0.5 else 1
                trees.append({
                    'id': f'TREE_{i}_{j}_{t}',
                    'x': cx + sx * half + rand(-1, 1),
                    'z': cz + sz * half + rand(-1, 1),
                    'scale': rand(0.8, 1.4),
                })

    infrastructure = []
    for building in buildings:
        if building['type'] in {'hospital', 'police', 'fire', 'energy'}:
            infrastructure.append({
                'id': f"INF_{building['id']}",
                'type': building['type'],
                'buildingId': building['id'],
                'position': building['position'],
                'status': 'operational',
            })
    return {'streetlights': streetlights, 'trafficLights': traffic_lights, 'trees': trees, 'infrastructure': infrastructure}


def generate_city() -> Dict[str, object]:
    intersections = build_intersections()
    roads = build_road_lines()
    buildings = []
    for i in range(GRID):
        for j in range(GRID):
            idx = i * GRID + j
            buildings.append(make_building(idx, i, j))
    infra = build_infrastructure(buildings)
    half = (GRID / 2) * BLOCK
    return {
        'meta': {'BLOCK': BLOCK, 'GRID': GRID, 'ROAD_WIDTH': ROAD_WIDTH, 'HALF': half, 'size': half * 2},
        'buildings': buildings,
        'roads': roads,
        'intersections': intersections,
        'streetlights': infra['streetlights'],
        'trafficLights': infra['trafficLights'],
        'trees': infra['trees'],
        'infrastructure': infra['infrastructure'],
    }
