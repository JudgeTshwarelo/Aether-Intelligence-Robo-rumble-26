# backend/engine/city_generator.py
# AETHER / SKYNET — procedural city generator (multi-city world).
# Refactored: generate_city(origin, city_id) builds one city;
# generate_world() assembles six cities + highways between them.

from __future__ import annotations

import math
import random
from typing import Dict, List, Tuple

# ---------------------------------------------------------------------------
# Grid constants (local to a single city)
# ---------------------------------------------------------------------------
BLOCK = 36
GRID = 6
ROAD_WIDTH = 7
SIDEWALK = 2.2
LANE_COUNT = 2
LANE_WIDTH = ROAD_WIDTH / (LANE_COUNT * 2)

# ---------------------------------------------------------------------------
# World constants
# ---------------------------------------------------------------------------
CITY_SPACING = 700
HIGHWAY_WIDTH = 14
HIGHWAY_LANES = 2
HIGHWAY_LANE_WIDTH = HIGHWAY_WIDTH / (HIGHWAY_LANES * 2)
HIGHWAY_SPEED = (35, 55)
POWERLINE_SPACING = 42
ROADSIDE_TREE_SPACING = 18

# ---------------------------------------------------------------------------
# City layout (six Limpopo cities)
# ---------------------------------------------------------------------------
CITY_LAYOUT = [
    {'id': 'POLOKWANE',   'name': 'Polokwane',   'cx': 0,                 'cz': 0},
    {'id': 'SESHEGO',     'name': 'Seshego',     'cx': -260,              'cz': -120},
    {'id': 'MANKWENG',    'name': 'Mankweng',    'cx': 320,               'cz': -80},
    {'id': 'MOKOPANE',    'name': 'Mokopane',    'cx': -180,              'cz': 380},
    {'id': 'TZANEEN',     'name': 'Tzaneen',     'cx': 520,               'cz': 260},
    {'id': 'THOHOYANDOU', 'name': 'Thohoyandou', 'cx': 620,               'cz': -320},
]

HIGHWAY_LINKS = [
    ('POLOKWANE', 'SESHEGO'),
    ('POLOKWANE', 'MANKWENG'),
    ('POLOKWANE', 'MOKOPANE'),
    ('MANKWENG', 'TZANEEN'),
    ('TZANEEN', 'THOHOYANDOU'),
    ('MANKWENG', 'THOHOYANDOU'),
]

# ---------------------------------------------------------------------------
# Palettes
# ---------------------------------------------------------------------------
MARKER_COLOR = {
    'hospital': '#ff3b3b',
    'police':   '#3b7aff',
    'fire':     '#ff6a3b',
    'energy':   '#39ffd8',
    'school':   '#ffd93b',
    'transit':  '#a06bff',
}

PALETTES = {
    'apartment':   ['#3b4a63', '#465068', '#3a4456', '#414b5e', '#38415a'],
    'office':      ['#2b3550', '#33405f', '#28324c', '#2f3a57', '#243049'],
    'commercial':  ['#4a4655', '#53475a', '#43455a', '#4b4a5e'],
    'residential': ['#55617a', '#5d6680', '#505c74', '#626b85'],
    'industrial':  ['#3f3a35', '#4a413a', '#3a352f', '#443c34'],
    'hospital':    ['#e8eef2'],
    'police':      ['#2c3e6b'],
    'fire':        ['#7a2a26'],
    'energy':      ['#3a4a52'],
    'school':      ['#5a4d3b'],
    'transit':     ['#3d3a55'],
}

ZONE_RULES = {
    'downtown':    {'office': 0.45, 'commercial': 0.30, 'apartment': 0.20, 'residential': 0.05},
    'residential': {'residential': 0.50, 'apartment': 0.30, 'commercial': 0.15, 'office': 0.05},
    'industrial':  {'industrial': 0.55, 'commercial': 0.20, 'office': 0.15, 'apartment': 0.10},
    'mixed':       {'apartment': 0.35, 'commercial': 0.25, 'office': 0.20, 'residential': 0.20},
}

# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------
def rand(min_value: float, max_value: float) -> float:
    return min_value + random.random() * (max_value - min_value)

def pick(items: List[str]) -> str:
    return random.choice(items)

def weighted_pick(weights: Dict[str, float]) -> str:
    keys = list(weights.keys())
    vals = list(weights.values())
    total = sum(vals)
    r = random.random() * total
    acc = 0.0
    for k, v in zip(keys, vals):
        acc += v
        if r <= acc:
            return k
    return keys[-1]

def zone_for(i: int, j: int) -> str:
    half = GRID / 2
    if i < half and j < half:
        return 'downtown'
    if i >= half and j >= half:
        return 'residential'
    if i >= half and j < half:
        return 'industrial'
    return 'mixed'

# ---------------------------------------------------------------------------
# City-scoped builders (local coords, origin at 0,0)
# ---------------------------------------------------------------------------
def P(k: int) -> float:
    return (k - GRID / 2) * BLOCK

def build_intersections() -> List[Dict[str, object]]:
    nodes: List[Dict[str, object]] = []
    for i in range(GRID + 1):
        for j in range(GRID + 1):
            is_signalized = 0 < i < GRID and 0 < j < GRID
            nodes.append({
                'id': f'INT_{i}_{j}',
                'gridI': i,
                'gridJ': j,
                'x': P(i),
                'z': P(j),
                'signalized': is_signalized,
                'light': {
                    'state': 'ns' if (i + j) % 2 == 0 else 'ew',
                    'timer': rand(0, 7),
                    'cycle': 7.0,
                    'yellow': 1.2,
                    'allRed': 0.4,
                },
                'turns': {'ns': True, 'ew': True, 'left': True, 'right': True, 'uturn': False},
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
        return {'w': rand(9, 14),  'd': rand(9, 14),  'hMin': 7,  'hMax': 16}
    if type_name == 'industrial':
        return {'w': rand(18, 26), 'd': rand(16, 24), 'hMin': 6,  'hMax': 14}
    if type_name == 'hospital':
        return {'w': 20, 'd': 16, 'hMin': 18, 'hMax': 26}
    if type_name == 'police':
        return {'w': 15, 'd': 13, 'hMin': 11, 'hMax': 18}
    if type_name == 'fire':
        return {'w': 16, 'd': 14, 'hMin': 10, 'hMax': 14}
    if type_name == 'energy':
        return {'w': 14, 'd': 12, 'hMin': 6,  'hMax': 11}
    if type_name == 'school':
        return {'w': 22, 'd': 16, 'hMin': 8,  'hMax': 14}
    if type_name == 'transit':
        return {'w': 18, 'd': 14, 'hMin': 10, 'hMax': 18}
    return {'w': 12, 'd': 12, 'hMin': 10, 'hMax': 20}

def special_slots() -> Dict[Tuple[int, int], str]:
    return {
        (0, 0):                 'hospital',
        (GRID - 1, GRID - 1):   'police',
        (GRID - 1, 0):          'fire',
        (0, GRID - 1):          'energy',
        (GRID // 2, GRID // 2): 'transit',
        (GRID // 2, 0):         'school',
    }

def make_building(idx: int, i: int, j: int) -> Dict[str, object]:
    cx, cz = block_center(i, j)
    inner = BLOCK - 2 * SIDEWALK
    slots = special_slots()

    if (i, j) in slots:
        type_name = slots[(i, j)]
    else:
        zone = zone_for(i, j)
        type_name = weighted_pick(ZONE_RULES[zone])

    dims = building_dims(type_name)
    w = min(dims['w'], inner)
    d = min(dims['d'], inner)
    height = rand(dims['hMin'], dims['hMax'])
    floors = max(2, round(height / 3.3))
    rotation = 0 if type_name == 'office' else (math.pi / 2 if random.random() < 0.3 else 0)

    building = {
        'id': f'BUILDING_{str(idx + 1).zfill(3)}',
        'type': type_name,
        'zone': zone_for(i, j),
        'position': [cx, 0, cz],
        'width': w,
        'depth': d,
        'height': height,
        'floors': floors,
        'status': 'normal',
        'color': pick(PALETTES[type_name]),
        'rotation': rotation,
        'marker': MARKER_COLOR.get(type_name),
        'block': [i, j],
        'footprintArea': round(w * d, 2),
        'volume': round(w * d * height, 2),
    }

    if type_name == 'apartment':
        building['units'] = floors * 4
        building['balconies'] = True
        building['residents'] = building['units'] * round(rand(1.2, 2.4))
    if type_name == 'office':
        building['occupancy'] = round(rand(0.5, 1) * floors * 20)
        building['companyTier'] = pick(['startup', 'corp', 'gov'])
    if type_name == 'commercial':
        building['shops'] = max(2, round(w / 4))
    if type_name == 'industrial':
        building['hazardLevel'] = pick(['low', 'medium', 'high'])
    if type_name in {'hospital', 'police', 'fire', 'energy', 'school', 'transit'}:
        building['service'] = True

    return building

def build_road_lines() -> List[Dict[str, object]]:
    roads: List[Dict[str, object]] = []
    for j in range(GRID + 1):
        roads.append({
            'id': f'ROAD_X_{j}',
            'axis': 'x',
            'pos': P(j),
            'from': P(0),
            'to': P(GRID),
            'width': ROAD_WIDTH,
            'lanes': LANE_COUNT * 2,
            'class': 'major' if j % 2 == 0 else 'minor',
            'oneway': False,
        })
    for i in range(GRID + 1):
        roads.append({
            'id': f'ROAD_Z_{i}',
            'axis': 'z',
            'pos': P(i),
            'from': P(0),
            'to': P(GRID),
            'width': ROAD_WIDTH,
            'lanes': LANE_COUNT * 2,
            'class': 'major' if i % 2 == 0 else 'minor',
            'oneway': False,
        })
    return roads

def build_road_markings() -> List[Dict[str, object]]:
    markings: List[Dict[str, object]] = []

    def add_dashed(axis: str, fixed: float, start: float, end: float, offset: float, dash=2.5, gap=2.0):
        cursor = start
        while cursor < end:
            seg_end = min(cursor + dash, end)
            markings.append({
                'axis': axis,
                'fixed': fixed + offset,
                'start': cursor,
                'end': seg_end,
                'kind': 'dash',
            })
            cursor += dash + gap

    for j in range(GRID + 1):
        add_dashed('x', P(j), P(0), P(GRID), 0.0)
        add_dashed('x', P(j), P(0), P(GRID),  LANE_WIDTH)
        add_dashed('x', P(j), P(0), P(GRID), -LANE_WIDTH)

    for i in range(GRID + 1):
        add_dashed('z', P(i), P(0), P(GRID), 0.0)
        add_dashed('z', P(i), P(0), P(GRID),  LANE_WIDTH)
        add_dashed('z', P(i), P(0), P(GRID), -LANE_WIDTH)

    return markings

def build_crosswalks() -> List[Dict[str, object]]:
    crosswalks: List[Dict[str, object]] = []
    for i in range(GRID + 1):
        for j in range(GRID + 1):
            cx, cz = P(i), P(j)
            half = ROAD_WIDTH / 2 + 1.0
            crosswalks.append({'id': f'CW_{i}_{j}_N', 'x': cx, 'z': cz - half, 'orientation': 'x'})
            crosswalks.append({'id': f'CW_{i}_{j}_S', 'x': cx, 'z': cz + half, 'orientation': 'x'})
            crosswalks.append({'id': f'CW_{i}_{j}_E', 'x': cx + half, 'z': cz, 'orientation': 'z'})
            crosswalks.append({'id': f'CW_{i}_{j}_W', 'x': cx - half, 'z': cz, 'orientation': 'z'})
    return crosswalks

def build_infrastructure(buildings: List[Dict[str, object]]) -> Dict[str, List[object]]:
    streetlights: List[Dict[str, object]] = []
    traffic_lights: List[Dict[str, object]] = []
    trees: List[Dict[str, object]] = []
    hydrants: List[Dict[str, object]] = []
    bus_stops: List[Dict[str, object]] = []
    benches: List[Dict[str, object]] = []

    for i in range(GRID + 1):
        for j in range(GRID + 1):
            streetlights.append({
                'id': f'LAMP_{i}_{j}',
                'x': P(i) + (-3 if i == GRID else 3),
                'z': P(j) + (-3 if j == GRID else 3),
                'on': True,
            })
            traffic_lights.append({
                'id': f'TL_{i}_{j}',
                'x': P(i),
                'z': P(j),
                'signalized': 0 < i < GRID and 0 < j < GRID,
            })

    for i in range(GRID):
        for j in range(GRID):
            cx, cz = block_center(i, j)
            half = BLOCK / 2 - SIDEWALK - 1.5
            count = 2 + int(random.random() * 3)
            for t in range(count):
                sx = -1 if random.random() < 0.5 else 1
                sz = -1 if random.random() < 0.5 else 1
                trees.append({
                    'id': f'TREE_{i}_{j}_{t}',
                    'x': cx + sx * half + rand(-1, 1),
                    'z': cz + sz * half + rand(-1, 1),
                    'scale': rand(0.8, 1.4),
                })

            hydrants.append({
                'id': f'HYD_{i}_{j}',
                'x': cx + rand(-half, half),
                'z': cz + rand(-half, half),
            })
            benches.append({
                'id': f'BENCH_{i}_{j}',
                'x': cx + rand(-half, half),
                'z': cz + rand(-half, half),
            })

    for j in range(0, GRID + 1, 2):
        bus_stops.append({'id': f'BUS_X_{j}', 'x': P(0) + 6, 'z': P(j) + LANE_WIDTH})
    for i in range(0, GRID + 1, 2):
        bus_stops.append({'id': f'BUS_Z_{i}', 'x': P(i) + LANE_WIDTH, 'z': P(0) + 6})

    infrastructure: List[Dict[str, object]] = []
    for building in buildings:
        if building['type'] in {'hospital', 'police', 'fire', 'energy', 'school', 'transit'}:
            infrastructure.append({
                'id': f"INF_{building['id']}",
                'type': building['type'],
                'buildingId': building['id'],
                'position': building['position'],
                'status': 'operational',
                'coverage': round(rand(40, 90), 1),
            })

    return {
        'streetlights': streetlights,
        'trafficLights': traffic_lights,
        'trees': trees,
        'hydrants': hydrants,
        'busStops': bus_stops,
        'benches': benches,
        'infrastructure': infrastructure,
    }

# ---------------------------------------------------------------------------
# Gateway nodes — where city edges connect to highways
# ---------------------------------------------------------------------------
def build_gateways(city_id: str) -> List[Dict[str, object]]:
    """
    Place 4 gateway nodes just outside the city grid, one per cardinal side.
    These are the entry/exit points vehicles use to leave/enter the city.
    """
    half = (GRID / 2) * BLOCK
    offset = BLOCK * 0.9   # just beyond the outermost intersections
    gateways = [
        {'id': f'GW_{city_id}_N', 'side': 'N', 'x': 0,     'z': -half - offset},
        {'id': f'GW_{city_id}_S', 'side': 'S', 'x': 0,     'z':  half + offset},
        {'id': f'GW_{city_id}_E', 'side': 'E', 'x':  half + offset, 'z': 0},
        {'id': f'GW_{city_id}_W', 'side': 'W', 'x': -half - offset, 'z': 0},
    ]
    # Attach to the nearest interior intersection on the boundary for connectivity
    for gw in gateways:
        side = gw['side']
        if side == 'N':
            gw['connectTo'] = f'INT_{GRID // 2}_0'
        elif side == 'S':
            gw['connectTo'] = f'INT_{GRID // 2}_{GRID}'
        elif side == 'E':
            gw['connectTo'] = f'INT_{GRID}_{GRID // 2}'
        else:
            gw['connectTo'] = f'INT_0_{GRID // 2}'
    return gateways

# ---------------------------------------------------------------------------
# Single city generator (local coords, origin at 0,0)
# ---------------------------------------------------------------------------
def generate_city(origin: Tuple[float, float] = (0.0, 0.0), city_id: str = 'ALPHA', city_name: str = 'ALPHA') -> Dict[str, object]:
    ox, oz = origin

    intersections = build_intersections()
    roads = build_road_lines()
    markings = build_road_markings()
    crosswalks = build_crosswalks()

    buildings = []
    for i in range(GRID):
        for j in range(GRID):
            idx = i * GRID + j
            buildings.append(make_building(idx, i, j))

    infra = build_infrastructure(buildings)
    half = (GRID / 2) * BLOCK
    gateways = build_gateways(city_id)

    zone_counts: Dict[str, int] = {}
    type_counts: Dict[str, int] = {}
    for b in buildings:
        zone_counts[b['zone']] = zone_counts.get(b['zone'], 0) + 1
        type_counts[b['type']] = type_counts.get(b['type'], 0) + 1

    return {
        'id': city_id,
        'name': city_name,
        'origin': [ox, oz],
        'meta': {
            'BLOCK': BLOCK,
            'GRID': GRID,
            'ROAD_WIDTH': ROAD_WIDTH,
            'LANE_COUNT': LANE_COUNT,
            'LANE_WIDTH': LANE_WIDTH,
            'HALF': half,
            'size': half * 2,
        },
        'zones': ZONE_RULES,
        'zoneCounts': zone_counts,
        'typeCounts': type_counts,
        'buildings': buildings,
        'roads': roads,
        'roadMarkings': markings,
        'crosswalks': crosswalks,
        'intersections': intersections,
        'gateways': gateways,
        'streetlights': infra['streetlights'],
        'trafficLights': infra['trafficLights'],
        'trees': infra['trees'],
        'hydrants': infra['hydrants'],
        'busStops': infra['busStops'],
        'benches': infra['benches'],
        'infrastructure': infra['infrastructure'],
    }

# ---------------------------------------------------------------------------
# Highways (inter-city connectors)
# ---------------------------------------------------------------------------
def build_highways(cities: List[Dict[str, object]]) -> List[Dict[str, object]]:
    by_id = {c['id']: c for c in cities}
    highways: List[Dict[str, object]] = []

    for a_id, b_id in HIGHWAY_LINKS:
        a = by_id[a_id]
        b = by_id[b_id]

        # pick the pair of gateways that face each other best
        ax, az = a['origin']
        bx, bz = b['origin']

        def pick_gateway(city, target_x, target_z):
            best = None
            best_d = float('inf')
            for gw in city['gateways']:
                gx = city['origin'][0] + gw['x']
                gz = city['origin'][1] + gw['z']
                d = (gx - target_x) ** 2 + (gz - target_z) ** 2
                if d < best_d:
                    best_d = d
                    best = gw
            return best

        gw_a = pick_gateway(a, bx, bz)
        gw_b = pick_gateway(b, ax, az)

        # world-space endpoints
        a_world = (a['origin'][0] + gw_a['x'], a['origin'][1] + gw_a['z'])
        b_world = (b['origin'][0] + gw_b['x'], b['origin'][1] + gw_b['z'])

        dx = b_world[0] - a_world[0]
        dz = b_world[1] - a_world[1]
        length = math.hypot(dx, dz)
        heading = math.atan2(dz, dx)
        highway_id = f'HW_{a_id}_{b_id}'

        # roadside assets along the highway
        pylons: List[Dict[str, object]] = []
        roadside_trees: List[Dict[str, object]] = []

        # unit perpendicular for side placement
        px = -dz / length if length else 0
        pz =  dx / length if length else 0

        n_pylons = max(2, int(length // POWERLINE_SPACING))
        for k in range(n_pylons):
            t = (k + 0.5) / n_pylons
            bx_ = a_world[0] + dx * t + px * (HIGHWAY_WIDTH / 2 + 6)
            bz_ = a_world[1] + dz * t + pz * (HIGHWAY_WIDTH / 2 + 6)
            pylons.append({
                'id': f'{highway_id}_PYLON_{k}',
                'x': bx_,
                'z': bz_,
                'heading': heading,
            })

        n_trees = max(4, int(length // ROADSIDE_TREE_SPACING))
        for k in range(n_trees):
            t = (k + 0.5) / n_trees
            side = -1 if k % 2 == 0 else 1
            tx = a_world[0] + dx * t + px * side * (HIGHWAY_WIDTH / 2 + 3.5)
            tz = a_world[1] + dz * t + pz * side * (HIGHWAY_WIDTH / 2 + 3.5)
            roadside_trees.append({
                'id': f'{highway_id}_TREE_{k}',
                'x': tx,
                'z': tz,
                'scale': rand(0.9, 1.5),
            })

        highways.append({
            'id': highway_id,
            'cities': [a_id, b_id],
            'fromGateway': gw_a['id'],
            'toGateway': gw_b['id'],
            'a': {'x': a_world[0], 'z': a_world[1]},
            'b': {'x': b_world[0], 'z': b_world[1]},
            'length': length,
            'heading': heading,
            'width': HIGHWAY_WIDTH,
            'lanes': HIGHWAY_LANES * 2,
            'laneWidth': HIGHWAY_LANE_WIDTH,
            'speedRange': list(HIGHWAY_SPEED),
            'pylons': pylons,
            'roadsideTrees': roadside_trees,
        })

    return highways

# ---------------------------------------------------------------------------
# World assembly
# ---------------------------------------------------------------------------
def generate_world() -> Dict[str, object]:
    cities: List[Dict[str, object]] = []
    for spec in CITY_LAYOUT:
        cities.append(generate_city(
            origin=(spec['cx'], spec['cz']),
            city_id=spec['id'],
            city_name=spec['name'],
        ))

    highways = build_highways(cities)

    # Include each city ground (HALF + 40) and a small margin for nearby assets.
    extents = []
    for city in cities:
        ox, oz = city['origin']
        extent = city['meta']['HALF'] + 56
        extents.append((ox - extent, ox + extent, oz - extent, oz + extent))

    bounds = {
        'minX': min(extent[0] for extent in extents),
        'maxX': max(extent[1] for extent in extents),
        'minZ': min(extent[2] for extent in extents),
        'maxZ': max(extent[3] for extent in extents),
        'centerX': (min(extent[0] for extent in extents) + max(extent[1] for extent in extents)) / 2,
        'centerZ': (min(extent[2] for extent in extents) + max(extent[3] for extent in extents)) / 2,
    }

    return {
        'type': 'world',
        'cities': cities,
        'highways': highways,
        'bounds': bounds,
        'meta': {
            'CITY_SPACING': CITY_SPACING,
            'HIGHWAY_WIDTH': HIGHWAY_WIDTH,
            'HIGHWAY_LANES': HIGHWAY_LANES,
            'HIGHWAY_LANE_WIDTH': HIGHWAY_LANE_WIDTH,
        },
    }

# ---------------------------------------------------------------------------
# Backwards-compat shim — keeps old single-city callers working
# ---------------------------------------------------------------------------
def generate_city_legacy() -> Dict[str, object]:
    """Return the first city (ALPHA) in the old flat shape for legacy tests."""
    world = generate_world()
    alpha = world['cities'][0]
    # Flatten: keep the old top-level keys so existing code still works.
    flat = dict(alpha)
    flat['meta'] = dict(alpha['meta'])
    return flat